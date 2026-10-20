import express from 'express';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, transaction, DEFAULT_PASSWORD } from './db.js';
import { hashPassword, verifyPassword, newToken, readCookie } from './auth.js';

const db = openDb();
const app = express();
app.use(express.json());
app.use(express.static(join(dirname(fileURLToPath(import.meta.url)), '..', 'public')));

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const notFound = (what) => { throw new HttpError(404, `${what} not found`); };
const toCents = (amount) => Math.round(Number(amount) * 100);
const fromCents = (cents) => cents == null ? null : cents / 100;
const MEMBER_COLS = 'id, trip_id, name, email, phone, is_organizer, created_at';

// ---------- login ----------

const SESSION_COOKIE = 'trip_session';
const SESSION_DAYS = 7;

// Names for the login dropdown (no auth needed).
app.get('/api/login-options', (req, res) =>
  res.json(db.prepare('SELECT id, name FROM members ORDER BY name').all()));

app.post('/api/login', (req, res) => {
  const { member_id, password } = req.body;
  const m = db.prepare('SELECT id, name, password_hash FROM members WHERE id = ?').get(member_id);
  if (!m || !verifyPassword(password ?? '', m.password_hash)) throw new HttpError(401, 'Wrong name or password');
  const token = newToken();
  db.prepare(`DELETE FROM sessions WHERE expires_at < datetime('now')`).run();
  db.prepare(`INSERT INTO sessions (token, member_id, expires_at) VALUES (?, ?, datetime('now', ?))`)
    .run(token, m.id, `+${SESSION_DAYS} days`);
  res.cookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: 'strict', maxAge: SESSION_DAYS * 86400e3 });
  res.json({ id: m.id, name: m.name });
});

app.post('/api/logout', (req, res) => {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(readCookie(req, SESSION_COOKIE) ?? '');
  res.clearCookie(SESSION_COOKIE);
  res.status(204).end();
});

// Everything below requires a logged-in member; req.member is the current user.
app.use('/api', (req, res, next) => {
  const member = db.prepare(`SELECT m.id, m.trip_id, m.name, m.is_organizer FROM sessions s JOIN members m ON m.id = s.member_id
    WHERE s.token = ? AND s.expires_at > datetime('now')`).get(readCookie(req, SESSION_COOKIE) ?? '');
  if (!member) throw new HttpError(401, 'Please log in');
  req.member = member;
  next();
});

app.get('/api/me', (req, res) => res.json(req.member));

app.post('/api/me/password', (req, res) => {
  const { current_password, new_password } = req.body;
  const m = db.prepare('SELECT password_hash FROM members WHERE id = ?').get(req.member.id);
  if (!verifyPassword(current_password ?? '', m.password_hash)) throw new HttpError(400, 'Current password is wrong');
  if (!new_password || String(new_password).length < 4) throw new HttpError(400, 'New password must be at least 4 characters');
  db.prepare('UPDATE members SET password_hash = ? WHERE id = ?').run(hashPassword(String(new_password)), req.member.id);
  res.status(204).end();
});

// ---------- helpers ----------

function getTask(id) {
  const task = db.prepare('SELECT * FROM v_task_overview WHERE id = ?').get(id) ?? notFound('Task');
  task.assignees = db.prepare(`SELECT m.id, m.name, a.role FROM task_assignees a
    JOIN members m ON m.id = a.member_id WHERE a.task_id = ? ORDER BY a.role DESC, m.name`).all(id);
  task.depends_on = db.prepare(`SELECT t.id, t.title, t.status, t.due_date FROM task_dependencies d
    JOIN tasks t ON t.id = d.depends_on_task_id WHERE d.task_id = ?`).all(id);
  task.blocks = db.prepare(`SELECT t.id, t.title, t.status FROM task_dependencies d
    JOIN tasks t ON t.id = d.task_id WHERE d.depends_on_task_id = ?`).all(id);
  task.estimated_cost = fromCents(task.estimated_cost_cents);
  task.is_blocked = !!task.is_blocked;
  task.is_overdue = !!task.is_overdue;
  return task;
}

// True if adding "taskId depends on dependsOnId" would create a cycle,
// i.e. taskId is already reachable from dependsOnId's own prerequisites.
function wouldCreateCycle(taskId, dependsOnId) {
  const row = db.prepare(`WITH RECURSIVE upstream(id) AS (
      SELECT ? UNION SELECT d.depends_on_task_id FROM task_dependencies d JOIN upstream u ON d.task_id = u.id)
    SELECT 1 AS hit FROM upstream WHERE id = ?`).get(dependsOnId, taskId);
  return !!row;
}

function setDependencies(taskId, tripId, dependsOn) {
  db.prepare('DELETE FROM task_dependencies WHERE task_id = ?').run(taskId);
  for (const depId of dependsOn) {
    const dep = db.prepare('SELECT trip_id FROM tasks WHERE id = ?').get(depId) ?? notFound(`Dependency task ${depId}`);
    if (dep.trip_id !== tripId) throw new HttpError(400, `Task ${depId} belongs to a different trip`);
    if (depId === taskId || wouldCreateCycle(taskId, depId)) {
      throw new HttpError(400, `Depending on task ${depId} would create a circular dependency`);
    }
    db.prepare('INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES (?, ?)').run(taskId, depId);
  }
}

// assignees: [memberId] or [{ member_id, role }]; first plain id becomes owner.
function setAssignees(taskId, tripId, assignees) {
  db.prepare('DELETE FROM task_assignees WHERE task_id = ?').run(taskId);
  assignees.forEach((a, i) => {
    const memberId = typeof a === 'object' ? a.member_id : a;
    const role = typeof a === 'object' && a.role ? a.role : (i === 0 ? 'owner' : 'helper');
    const m = db.prepare('SELECT trip_id FROM members WHERE id = ?').get(memberId) ?? notFound(`Member ${memberId}`);
    if (m.trip_id !== tripId) throw new HttpError(400, `Member ${memberId} is not on this trip`);
    db.prepare('INSERT INTO task_assignees (task_id, member_id, role) VALUES (?, ?, ?)').run(taskId, memberId, role);
  });
}

function assertCanComplete(taskId) {
  const open = db.prepare(`SELECT t.id, t.title FROM task_dependencies d JOIN tasks t ON t.id = d.depends_on_task_id
    WHERE d.task_id = ? AND t.status NOT IN ('done','cancelled')`).all(taskId);
  if (open.length) {
    throw new HttpError(409, `Cannot mark done: waiting on ${open.map(t => `#${t.id} "${t.title}"`).join(', ')}`);
  }
}

const EDITABLE_TASK_FIELDS = ['title', 'description', 'category', 'status', 'priority', 'start_date', 'due_date'];

// ---------- trips ----------

app.get('/api/trips', (req, res) => res.json(db.prepare('SELECT * FROM trips ORDER BY start_date').all()));

app.get('/api/trips/:tripId', (req, res) => {
  const trip = db.prepare('SELECT * FROM trips WHERE id = ?').get(req.params.tripId) ?? notFound('Trip');
  trip.members = db.prepare(`SELECT ${MEMBER_COLS} FROM members WHERE trip_id = ? ORDER BY id`).all(trip.id);
  trip.task_summary = db.prepare(`SELECT status, COUNT(*) AS count FROM tasks WHERE trip_id = ? GROUP BY status`).all(trip.id);
  res.json(trip);
});

app.patch('/api/trips/:tripId', (req, res) => {
  const fields = ['name', 'destination', 'start_date', 'end_date', 'base_currency', 'notes'].filter(f => f in req.body);
  if (!fields.length) throw new HttpError(400, 'Nothing to update');
  const r = db.prepare(`UPDATE trips SET ${fields.map(f => `${f} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`)
    .run(...fields.map(f => req.body[f]), req.params.tripId);
  if (!r.changes) notFound('Trip');
  res.json(db.prepare('SELECT * FROM trips WHERE id = ?').get(req.params.tripId));
});

// ---------- members ----------

app.get('/api/trips/:tripId/members', (req, res) =>
  res.json(db.prepare(`SELECT ${MEMBER_COLS} FROM members WHERE trip_id = ? ORDER BY id`).all(req.params.tripId)));

app.post('/api/trips/:tripId/members', (req, res) => {
  const { name, email = null, phone = null, is_organizer = 0 } = req.body;
  if (!name) throw new HttpError(400, 'name is required');
  const id = db.prepare('INSERT INTO members (trip_id, name, email, phone, is_organizer, password_hash) VALUES (?, ?, ?, ?, ?, ?)')
    .run(req.params.tripId, name, email, phone, is_organizer ? 1 : 0, hashPassword(DEFAULT_PASSWORD)).lastInsertRowid;
  res.status(201).json(db.prepare(`SELECT ${MEMBER_COLS} FROM members WHERE id = ?`).get(id));
});

app.patch('/api/members/:id', (req, res) => {
  const fields = ['name', 'email', 'phone', 'is_organizer'].filter(f => f in req.body);
  if (!fields.length) throw new HttpError(400, 'Nothing to update');
  const r = db.prepare(`UPDATE members SET ${fields.map(f => `${f} = ?`).join(', ')} WHERE id = ?`)
    .run(...fields.map(f => req.body[f]), req.params.id);
  if (!r.changes) notFound('Member');
  res.json(db.prepare(`SELECT ${MEMBER_COLS} FROM members WHERE id = ?`).get(req.params.id));
});

app.delete('/api/members/:id', (req, res) => {
  const r = db.prepare('DELETE FROM members WHERE id = ?').run(req.params.id);
  if (!r.changes) notFound('Member');
  res.status(204).end();
});

// ---------- tasks ----------

// Filters: ?status=todo&assignee=3&category=transport&blocked=true&overdue=true
app.get('/api/trips/:tripId/tasks', (req, res) => {
  const where = ['trip_id = ?'];
  const params = [req.params.tripId];
  const { status, category, assignee, blocked, overdue } = req.query;
  if (status) { where.push('status = ?'); params.push(status); }
  if (category) { where.push('category = ?'); params.push(category); }
  if (assignee) { where.push('id IN (SELECT task_id FROM task_assignees WHERE member_id = ?)'); params.push(assignee); }
  if (blocked) where.push(`is_blocked = ${blocked === 'true' ? 1 : 0}`);
  if (overdue) where.push(`is_overdue = ${overdue === 'true' ? 1 : 0}`);
  res.json(db.prepare(`SELECT * FROM v_task_overview WHERE ${where.join(' AND ')}
    ORDER BY due_date IS NULL, due_date, priority = 'critical' DESC, id`).all(...params));
});

app.get('/api/tasks/:id', (req, res) => res.json(getTask(req.params.id)));

app.post('/api/trips/:tripId/tasks', (req, res) => {
  const tripId = Number(req.params.tripId);
  db.prepare('SELECT 1 FROM trips WHERE id = ?').get(tripId) ?? notFound('Trip');
  const b = req.body;
  if (!b.title) throw new HttpError(400, 'title is required');
  const id = transaction(db, () => {
    const id = Number(db.prepare(`INSERT INTO tasks (trip_id, title, description, category, status, priority,
        start_date, due_date, estimated_cost_cents) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      tripId, b.title, b.description ?? null, b.category ?? 'general', b.status ?? 'todo', b.priority ?? 'medium',
      b.start_date ?? null, b.due_date ?? null, b.estimated_cost != null ? toCents(b.estimated_cost) : null).lastInsertRowid);
    if (b.assignees) setAssignees(id, tripId, b.assignees);
    if (b.depends_on) setDependencies(id, tripId, b.depends_on);
    if (b.status === 'done') assertCanComplete(id);
    return id;
  });
  res.status(201).json(getTask(id));
});

// Edit any task field, plus assignees / depends_on lists. History is attributed to the logged-in member.
app.patch('/api/tasks/:id', (req, res) => {
  const id = Number(req.params.id);
  const before = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) ?? notFound('Task');
  const b = req.body;
  transaction(db, () => {
    const updates = EDITABLE_TASK_FIELDS.filter(f => f in b).map(f => [f, b[f]]);
    if ('estimated_cost' in b) updates.push(['estimated_cost_cents', b.estimated_cost == null ? null : toCents(b.estimated_cost)]);
    if (updates.length) {
      db.prepare(`UPDATE tasks SET ${updates.map(([f]) => `${f} = ?`).join(', ')} WHERE id = ?`)
        .run(...updates.map(([, v]) => v), id);
      const log = db.prepare('INSERT INTO task_history (task_id, changed_by, field, old_value, new_value) VALUES (?, ?, ?, ?, ?)');
      for (const [f, v] of updates) {
        if (String(before[f]) !== String(v)) log.run(id, req.member.id, f, before[f] == null ? null : String(before[f]), v == null ? null : String(v));
      }
    }
    if (b.assignees) setAssignees(id, before.trip_id, b.assignees);
    if (b.depends_on) setDependencies(id, before.trip_id, b.depends_on);
    if (b.status === 'done' && before.status !== 'done') assertCanComplete(id);
  });
  res.json(getTask(id));
});

app.delete('/api/tasks/:id', (req, res) => {
  const r = db.prepare('DELETE FROM tasks WHERE id = ?').run(req.params.id);
  if (!r.changes) notFound('Task');
  res.status(204).end();
});

app.get('/api/tasks/:id/history', (req, res) =>
  res.json(db.prepare(`SELECT h.*, m.name AS changed_by_name FROM task_history h
    LEFT JOIN members m ON m.id = h.changed_by WHERE h.task_id = ? ORDER BY h.id DESC`).all(req.params.id)));

app.post('/api/tasks/:id/dependencies', (req, res) => {
  const id = Number(req.params.id);
  const task = db.prepare('SELECT trip_id FROM tasks WHERE id = ?').get(id) ?? notFound('Task');
  const current = db.prepare('SELECT depends_on_task_id AS d FROM task_dependencies WHERE task_id = ?').all(id).map(r => r.d);
  transaction(db, () => setDependencies(id, task.trip_id, [...new Set([...current, Number(req.body.depends_on_task_id)])]));
  res.status(201).json(getTask(id));
});

app.delete('/api/tasks/:id/dependencies/:dependsOnId', (req, res) => {
  db.prepare('DELETE FROM task_dependencies WHERE task_id = ? AND depends_on_task_id = ?').run(req.params.id, req.params.dependsOnId);
  res.json(getTask(req.params.id));
});

// Timeline: tasks grouped by due month, with the earliest date each task can realistically finish.
app.get('/api/trips/:tripId/timeline', (req, res) => {
  const rows = db.prepare(`SELECT id, title, status, priority, start_date, due_date, assignees, depends_on, is_blocked, is_overdue
    FROM v_task_overview WHERE trip_id = ? ORDER BY due_date, id`).all(req.params.tripId);
  const byMonth = {};
  for (const r of rows) (byMonth[(r.due_date ?? 'unscheduled').slice(0, 7)] ??= []).push(r);
  // Flag dependency conflicts: a task due before something it depends on.
  const conflicts = db.prepare(`SELECT t.id AS task_id, t.title, t.due_date, p.id AS depends_on_id, p.title AS depends_on_title, p.due_date AS depends_on_due
    FROM task_dependencies d JOIN tasks t ON t.id = d.task_id JOIN tasks p ON p.id = d.depends_on_task_id
    WHERE t.trip_id = ? AND t.due_date < p.due_date`).all(req.params.tripId);
  res.json({ months: byMonth, schedule_conflicts: conflicts });
});

// ---------- expenses: who owes what ----------

function getExpense(id) {
  const e = db.prepare(`SELECT e.*, m.name AS paid_by_name FROM expenses e JOIN members m ON m.id = e.paid_by WHERE e.id = ?`).get(id)
    ?? notFound('Expense');
  e.amount = fromCents(e.amount_cents);
  e.shares = db.prepare(`SELECT s.member_id, m.name, s.share_cents / 100.0 AS share FROM expense_shares s
    JOIN members m ON m.id = s.member_id WHERE s.expense_id = ? ORDER BY m.id`).all(id);
  return e;
}

// Equal split spreads leftover cents so shares always sum to the exact total.
function writeShares(expenseId, tripId, amountCents, splitMethod, body) {
  db.prepare('DELETE FROM expense_shares WHERE expense_id = ?').run(expenseId);
  const ins = db.prepare('INSERT INTO expense_shares (expense_id, member_id, share_cents) VALUES (?, ?, ?)');
  if (splitMethod === 'custom') {
    const shares = body.shares ?? [];
    const total = shares.reduce((s, x) => s + toCents(x.amount), 0);
    if (total !== amountCents) throw new HttpError(400, `Custom shares add up to ${total / 100} but expense is ${amountCents / 100}`);
    for (const s of shares) ins.run(expenseId, s.member_id, toCents(s.amount));
  } else {
    const ids = body.split_between?.length
      ? body.split_between
      : db.prepare('SELECT id FROM members WHERE trip_id = ? ORDER BY id').all(tripId).map(m => m.id);
    const base = Math.floor(amountCents / ids.length);
    const extra = amountCents - base * ids.length;
    ids.forEach((mid, i) => ins.run(expenseId, mid, base + (i < extra ? 1 : 0)));
  }
}

app.get('/api/trips/:tripId/expenses', (req, res) => {
  const ids = db.prepare('SELECT id FROM expenses WHERE trip_id = ? ORDER BY expense_date, id').all(req.params.tripId);
  res.json(ids.map(r => getExpense(r.id)));
});

// Body: { description, amount, paid_by, task_id?, expense_date?, currency?,
//         split_method: 'equal' (split_between?: [memberIds], default everyone) | 'custom' (shares: [{member_id, amount}]) }
app.post('/api/trips/:tripId/expenses', (req, res) => {
  const tripId = Number(req.params.tripId);
  const b = req.body;
  if (!b.description || !b.amount || !b.paid_by) throw new HttpError(400, 'description, amount and paid_by are required');
  const amountCents = toCents(b.amount);
  const split = b.split_method ?? 'equal';
  const id = transaction(db, () => {
    const id = Number(db.prepare(`INSERT INTO expenses (trip_id, task_id, description, amount_cents, currency, paid_by, expense_date, split_method)
      VALUES (?, ?, ?, ?, ?, ?, COALESCE(?, date('now')), ?)`).run(
      tripId, b.task_id ?? null, b.description, amountCents, b.currency ?? 'USD', b.paid_by, b.expense_date ?? null, split).lastInsertRowid);
    writeShares(id, tripId, amountCents, split, b);
    return id;
  });
  res.status(201).json(getExpense(id));
});

app.patch('/api/expenses/:id', (req, res) => {
  const before = db.prepare('SELECT * FROM expenses WHERE id = ?').get(req.params.id) ?? notFound('Expense');
  const b = req.body;
  const amountCents = 'amount' in b ? toCents(b.amount) : before.amount_cents;
  const split = b.split_method ?? before.split_method;
  transaction(db, () => {
    db.prepare(`UPDATE expenses SET description = ?, amount_cents = ?, paid_by = ?, task_id = ?, expense_date = ?, split_method = ?, currency = ? WHERE id = ?`)
      .run(b.description ?? before.description, amountCents, b.paid_by ?? before.paid_by, 'task_id' in b ? b.task_id : before.task_id,
        b.expense_date ?? before.expense_date, split, b.currency ?? before.currency, before.id);
    if ('amount' in b || 'split_method' in b || 'shares' in b || 'split_between' in b) {
      writeShares(before.id, before.trip_id, amountCents, split, b);
    }
  });
  res.json(getExpense(before.id));
});

app.delete('/api/expenses/:id', (req, res) => {
  const r = db.prepare('DELETE FROM expenses WHERE id = ?').run(req.params.id);
  if (!r.changes) notFound('Expense');
  res.status(204).end();
});

app.post('/api/trips/:tripId/settlements', (req, res) => {
  const { from_member, to_member, amount, note = null } = req.body;
  const id = db.prepare('INSERT INTO settlements (trip_id, from_member, to_member, amount_cents, note) VALUES (?, ?, ?, ?, ?)')
    .run(req.params.tripId, from_member, to_member, toCents(amount), note).lastInsertRowid;
  res.status(201).json(db.prepare('SELECT * FROM settlements WHERE id = ?').get(id));
});

app.delete('/api/settlements/:id', (req, res) => {
  const r = db.prepare('DELETE FROM settlements WHERE id = ?').run(req.params.id);
  if (!r.changes) notFound('Settlement');
  res.status(204).end();
});

app.get('/api/trips/:tripId/settlements', (req, res) =>
  res.json(db.prepare('SELECT * FROM settlements WHERE trip_id = ? ORDER BY settled_on, id').all(req.params.tripId)));

// Balances plus the fewest payments needed to square everyone up.
app.get('/api/trips/:tripId/balances', (req, res) => {
  const rows = db.prepare('SELECT * FROM v_member_balances WHERE trip_id = ? ORDER BY member_id').all(req.params.tripId);
  const creditors = rows.filter(r => r.net_cents > 0).map(r => ({ ...r, left: r.net_cents })).sort((a, b) => b.left - a.left);
  const debtors = rows.filter(r => r.net_cents < 0).map(r => ({ ...r, left: -r.net_cents })).sort((a, b) => b.left - a.left);
  const payments = [];
  let i = 0, j = 0;
  while (i < debtors.length && j < creditors.length) {
    const amt = Math.min(debtors[i].left, creditors[j].left);
    payments.push({ from_member: debtors[i].member_id, from: debtors[i].name, to_member: creditors[j].member_id, to: creditors[j].name, amount: amt / 100 });
    debtors[i].left -= amt; creditors[j].left -= amt;
    if (!debtors[i].left) i++;
    if (!creditors[j].left) j++;
  }
  res.json({
    balances: rows.map(r => ({ member_id: r.member_id, name: r.name, paid: r.paid_cents / 100, fair_share: r.share_cents / 100,
      paid_back: (r.settled_out_cents - r.settled_in_cents) / 100,
      net: r.net_cents / 100, status: r.net_cents > 0 ? 'is owed' : r.net_cents < 0 ? 'owes' : 'settled' })),
    suggested_payments: payments,
  });
});

// ---------- errors ----------

app.use((req, res) => res.status(404).json({ error: 'Route not found' }));
app.use((err, req, res, next) => {
  const status = err.status ?? (/constraint/i.test(err.message) ? 400 : 500);
  res.status(status).json({ error: err.message });
});

const PORT = process.env.PORT ?? 3000;
app.listen(PORT, '127.0.0.1', () => console.log(`Trip planner API running at http://localhost:${PORT}/api/trips`));
