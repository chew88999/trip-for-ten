// End-to-end API tests against a throwaway database. Run: npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seed, startServer, client } from '../scripts/harness.js';

const dir = mkdtempSync(join(tmpdir(), 'trip-test-'));
const dbPath = join(dir, 'test.db');
let server, alex, ben, anon;

before(async () => {
  seed(dbPath);
  server = await startServer({ dbPath, port: 3101 });
  alex = client(server.base);
  ben = client(server.base);
  anon = client(server.base);
  await alex.login(1);
  await ben.login(2);
});

after(() => {
  server?.stop();
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
});

const newTask = (body) => alex.post('/trips/1/tasks', { title: 'Test task', ...body });
const sumNet = (b) => b.balances.reduce((s, x) => s + Math.round(x.net * 100), 0);

// ---------- login ----------

test('login dropdown lists all 10 travelers without signing in', async () => {
  const r = await anon.call('GET', '/login-options');
  assert.equal(r.status, 200);
  assert.equal(r.data.length, 10);
  assert.deepEqual(Object.keys(r.data[0]).sort(), ['id', 'name']);
});

test('data is not reachable without signing in', async () => {
  for (const path of ['/trips/1', '/trips/1/tasks', '/trips/1/balances', '/me']) {
    assert.equal((await anon.call('GET', path)).status, 401, path);
  }
});

test('wrong password is rejected, 1234 works', async () => {
  const c = client(server.base);
  assert.equal((await c.call('POST', '/login', { member_id: 3, password: '0000' })).status, 401);
  assert.equal((await c.call('POST', '/login', { member_id: 3 })).status, 401);
  assert.equal((await c.call('POST', '/login', { member_id: 999, password: '1234' })).status, 401);
  const r = await c.call('POST', '/login', { member_id: 3, password: '1234' });
  assert.equal(r.status, 200);
  assert.equal((await c.get('/me')).id, 3);
});

test('signing out ends the session', async () => {
  const c = client(server.base);
  await c.login(4);
  assert.equal((await c.call('GET', '/me')).status, 200);
  await c.call('POST', '/logout');
  // Cookie still sent, but the session row is gone.
  assert.equal((await c.call('GET', '/me')).status, 401);
});

test('password hashes never appear in API responses', async () => {
  const trip = await alex.get('/trips/1');
  const members = await alex.get('/trips/1/members');
  for (const m of [...trip.members, ...members]) assert.equal('password_hash' in m, false);
});

test('changing password: wrong current rejected, new one works, old one stops working', async () => {
  const c = client(server.base);
  await c.login(10);
  assert.equal((await c.call('POST', '/me/password', { current_password: 'nope', new_password: 'abcd' })).status, 400);
  assert.equal((await c.call('POST', '/me/password', { current_password: '1234', new_password: 'ab' })).status, 400);
  assert.equal((await c.call('POST', '/me/password', { current_password: '1234', new_password: 'kyoto2027' })).status, 204);
  const fresh = client(server.base);
  assert.equal((await fresh.call('POST', '/login', { member_id: 10, password: '1234' })).status, 401);
  assert.equal((await fresh.call('POST', '/login', { member_id: 10, password: 'kyoto2027' })).status, 200);
});

// ---------- seed plan ----------

test('seeded trip is 9 days in March 2027 with 21 dependent tasks', async () => {
  const trip = await alex.get('/trips/1');
  assert.equal(trip.start_date, '2027-03-13');
  assert.equal(trip.end_date, '2027-03-21');
  const tasks = await alex.get('/trips/1/tasks');
  assert.ok(tasks.length >= 21);
  const timeline = await alex.get('/trips/1/timeline');
  assert.deepEqual(timeline.schedule_conflicts, [], 'seed plan should have no tasks due before their prerequisites');
});

// ---------- tasks ----------

test('create and edit a task, including assignees, dependencies and cost', async () => {
  const pre = await newTask({ title: 'Prereq', due_date: '2026-12-01' });
  const t = await newTask({
    title: 'Book ramen tour', category: 'food', priority: 'high', start_date: '2026-12-01', due_date: '2027-01-10',
    estimated_cost: 199.99, assignees: [3, 4], depends_on: [pre.id],
  });
  assert.equal(t.estimated_cost, 199.99);
  assert.deepEqual(t.assignees.map((a) => [a.id, a.role]), [[3, 'owner'], [4, 'helper']]);
  assert.deepEqual(t.depends_on.map((d) => d.id), [pre.id]);
  assert.equal(t.is_blocked, true);
  const helperFirst = await newTask({ assignees: [{ member_id: 9, role: 'owner' }, { member_id: 2, role: 'helper' }] });
  const listed = (await alex.get('/trips/1/tasks')).find((x) => x.id === helperFirst.id);
  assert.equal(listed.assignees, 'Traveler 09, Traveler 02', 'owner is listed first');

  const edited = await ben.patch(`/tasks/${t.id}`, {
    title: 'Book ramen + sake tour', due_date: '2027-01-20', status: 'in_progress',
    assignees: [{ member_id: 5, role: 'owner' }], depends_on: [],
  });
  assert.equal(edited.title, 'Book ramen + sake tour');
  assert.equal(edited.status, 'in_progress');
  assert.deepEqual(edited.assignees.map((a) => a.id), [5]);
  assert.equal(edited.depends_on.length, 0);
  assert.equal(edited.is_blocked, false);

  const history = await alex.get(`/tasks/${t.id}/history`);
  assert.deepEqual(history.map((h) => h.field).sort(), ['due_date', 'status', 'title']);
  assert.ok(history.every((h) => h.changed_by === 2), 'edits are attributed to the signed-in person (Ben)');
});

test('invalid task values are rejected with 400', async () => {
  const t = await newTask({});
  assert.equal((await alex.call('PATCH', `/tasks/${t.id}`, { status: 'finished' })).status, 400);
  assert.equal((await alex.call('PATCH', `/tasks/${t.id}`, { start_date: '2027-02-01', due_date: '2027-01-01' })).status, 400);
  assert.equal((await alex.call('POST', '/trips/1/tasks', { description: 'no title' })).status, 400);
  assert.equal((await alex.call('PATCH', `/tasks/${t.id}`, { assignees: [999] })).status, 404);
  assert.equal((await alex.call('GET', '/tasks/99999')).status, 404);
});

test('a task cannot be done while a prerequisite is open; cancelled prerequisites do not block', async () => {
  const a = await newTask({ title: 'A' });
  const b = await newTask({ title: 'B', depends_on: [a.id] });
  const r = await alex.call('PATCH', `/tasks/${b.id}`, { status: 'done' });
  assert.equal(r.status, 409);
  assert.match(r.data.error, /waiting on/);
  assert.equal((await alex.get(`/tasks/${b.id}`)).status, 'todo', 'failed edit must roll back');

  await alex.patch(`/tasks/${a.id}`, { status: 'cancelled' });
  assert.equal((await alex.patch(`/tasks/${b.id}`, { status: 'done' })).status, 'done');
});

test('completed_at is stamped when done and cleared when reopened', async () => {
  const t = await newTask({});
  assert.equal(t.completed_at, null);
  const done = await alex.patch(`/tasks/${t.id}`, { status: 'done' });
  assert.ok(done.completed_at);
  const reopened = await alex.patch(`/tasks/${t.id}`, { status: 'todo' });
  assert.equal(reopened.completed_at, null);
});

test('circular dependencies are rejected (self, direct, and indirect)', async () => {
  const a = await newTask({ title: 'A' });
  const b = await newTask({ title: 'B', depends_on: [a.id] });
  const c = await newTask({ title: 'C', depends_on: [b.id] });
  assert.equal((await alex.call('PATCH', `/tasks/${a.id}`, { depends_on: [a.id] })).status, 400);
  assert.equal((await alex.call('POST', `/tasks/${a.id}/dependencies`, { depends_on_task_id: b.id })).status, 400);
  assert.equal((await alex.call('PATCH', `/tasks/${a.id}`, { depends_on: [c.id] })).status, 400);
  assert.equal((await alex.get(`/tasks/${a.id}`)).depends_on.length, 0, 'rejected edit leaves dependencies untouched');
  const removed = await alex.del(`/tasks/${c.id}/dependencies/${b.id}`);
  assert.equal(removed.depends_on.length, 0);
});

test('timeline flags a task due before its prerequisite', async () => {
  const late = await newTask({ title: 'Late prereq', due_date: '2027-02-20' });
  const early = await newTask({ title: 'Early dependent', due_date: '2027-02-01', depends_on: [late.id] });
  const { schedule_conflicts } = await alex.get('/trips/1/timeline');
  assert.ok(schedule_conflicts.some((c) => c.task_id === early.id && c.depends_on_id === late.id));
});

test('task filters: assignee, status, overdue, blocked', async () => {
  const overdue = await newTask({ title: 'Overdue one', start_date: '2020-01-01', due_date: '2020-01-02', assignees: [7] });
  const mine = await alex.get('/trips/1/tasks?assignee=7');
  assert.ok(mine.some((t) => t.id === overdue.id));
  assert.ok(mine.every((t) => (t.assignees ?? '').includes('Traveler 07')));
  const od = await alex.get('/trips/1/tasks?overdue=true');
  assert.ok(od.some((t) => t.id === overdue.id));
  const blocked = await alex.get('/trips/1/tasks?blocked=true');
  assert.ok(blocked.length > 0 && blocked.every((t) => t.is_blocked === 1));
  const done = await alex.get('/trips/1/tasks?status=done');
  assert.ok(done.every((t) => t.status === 'done'));
});

test('deleting a task removes its links but keeps related expenses', async () => {
  const a = await newTask({ title: 'To delete' });
  const b = await newTask({ title: 'Depends on deleted', depends_on: [a.id] });
  const e = await alex.post('/trips/1/expenses', { description: 'Linked', amount: 10, paid_by: 1, task_id: a.id, split_between: [1] });
  await alex.del(`/tasks/${a.id}`);
  assert.equal((await alex.get(`/tasks/${b.id}`)).depends_on.length, 0);
  const kept = (await alex.get('/trips/1/expenses')).find((x) => x.id === e.id);
  assert.equal(kept.task_id, null);
  await alex.del(`/expenses/${e.id}`);
});

// ---------- expenses ----------

test('equal split spreads leftover cents so shares add up exactly', async () => {
  const e = await alex.post('/trips/1/expenses', { description: 'Snacks', amount: 100, paid_by: 1, split_between: [1, 2, 3] });
  assert.deepEqual(e.shares.map((s) => s.share), [33.34, 33.33, 33.33]);
  const all = await alex.post('/trips/1/expenses', { description: 'eSIMs', amount: 239.99, paid_by: 2 });
  assert.equal(all.shares.length, 10);
  assert.equal(Math.round(all.shares.reduce((s, x) => s + x.share * 100, 0)), 23999);
  await alex.del(`/expenses/${e.id}`);
  await alex.del(`/expenses/${all.id}`);
});

test('custom shares must add up to the total', async () => {
  const bad = await alex.call('POST', '/trips/1/expenses', {
    description: 'Dinner', amount: 100, paid_by: 1, split_method: 'custom',
    shares: [{ member_id: 1, amount: 60 }, { member_id: 2, amount: 30 }],
  });
  assert.equal(bad.status, 400);
  assert.match(bad.data.error, /add up/);
  assert.equal((await alex.get('/trips/1/expenses')).filter((x) => x.description === 'Dinner').length, 0, 'nothing saved on failure');
});

test('expense validation: missing fields and non-positive amounts', async () => {
  assert.equal((await alex.call('POST', '/trips/1/expenses', { description: 'x', paid_by: 1 })).status, 400);
  assert.equal((await alex.call('POST', '/trips/1/expenses', { description: 'x', amount: -5, paid_by: 1 })).status, 400);
});

test('balances always net to zero and suggested payments settle everyone', async () => {
  const created = [
    await alex.post('/trips/1/expenses', { description: 'Hotel', amount: 1234.56, paid_by: 1 }),
    await ben.post('/trips/1/expenses', { description: 'Taxi', amount: 77.77, paid_by: 2, split_between: [2, 5, 9] }),
    await ben.post('/trips/1/expenses', {
      description: 'Tickets', amount: 90, paid_by: 6, split_method: 'custom',
      shares: [{ member_id: 1, amount: 45 }, { member_id: 6, amount: 45 }],
    }),
  ];
  const b = await alex.get('/trips/1/balances');
  assert.equal(sumNet(b), 0);
  assert.ok(b.suggested_payments.length <= 9, 'at most n-1 payments for 10 people');

  const settlements = [];
  for (const p of b.suggested_payments) {
    settlements.push(await alex.post('/trips/1/settlements', { from_member: p.from_member, to_member: p.to_member, amount: p.amount }));
  }
  const settled = await alex.get('/trips/1/balances');
  assert.ok(settled.balances.every((x) => x.net === 0), 'everyone is at zero after paying the suggestions');
  assert.equal(settled.suggested_payments.length, 0);

  const first = b.suggested_payments[0];
  const withPaidBack = (await alex.get('/trips/1/balances')).balances;
  const sentCents = b.suggested_payments.filter((p) => p.from_member === first.from_member).reduce((s, p) => s + Math.round(p.amount * 100), 0);
  assert.equal(Math.round(withPaidBack.find((x) => x.member_id === first.from_member).paid_back * 100), sentCents, 'payer shows money sent');
  assert.ok(withPaidBack.find((x) => x.member_id === first.to_member).paid_back < 0, 'receiver shows money received');

  // Undoing a repayment reopens the debt.
  await alex.del(`/settlements/${settlements[0].id}`);
  assert.equal((await alex.get('/trips/1/balances')).suggested_payments.length, 1);

  for (const s of settlements.slice(1)) await alex.del(`/settlements/${s.id}`);
  for (const e of created) await alex.del(`/expenses/${e.id}`);
  assert.ok((await alex.get('/trips/1/balances')).balances.every((x) => x.net === 0));
});

test('editing an expense recalculates the shares', async () => {
  const e = await alex.post('/trips/1/expenses', { description: 'Museum', amount: 30, paid_by: 1, split_between: [1, 2, 3] });
  const up = await alex.patch(`/expenses/${e.id}`, { amount: 40, split_between: [1, 2] });
  assert.deepEqual(up.shares.map((s) => [s.member_id, s.share]), [[1, 20], [2, 20]]);
  const custom = await alex.patch(`/expenses/${e.id}`, { split_method: 'custom', shares: [{ member_id: 3, amount: 40 }] });
  assert.deepEqual(custom.shares.map((s) => [s.member_id, s.share]), [[3, 40]]);
  const renamed = await alex.patch(`/expenses/${e.id}`, { description: 'Museum tickets' });
  assert.equal(renamed.shares.length, 1, 'changing only the description keeps the shares');
  await alex.del(`/expenses/${e.id}`);
});

test('settlement to yourself is rejected', async () => {
  assert.equal((await alex.call('POST', '/trips/1/settlements', { from_member: 1, to_member: 1, amount: 5 })).status, 400);
});

// ---------- members ----------

test('people with expenses cannot be removed; others can, and new people get password 1234', async () => {
  const e = await alex.post('/trips/1/expenses', { description: 'Lunch', amount: 20, paid_by: 8, split_between: [8, 9] });
  assert.equal((await alex.call('DELETE', '/members/8')).status, 400);
  await alex.del(`/expenses/${e.id}`);

  const guest = await alex.post('/trips/1/members', { name: 'Guest Person' });
  const c = client(server.base);
  await c.login(guest.id, '1234');
  assert.equal((await c.get('/me')).name, 'Guest Person');
  await alex.del(`/members/${guest.id}`);
  assert.equal((await c.call('GET', '/me')).status, 401, 'removed person is signed out');
});

test('duplicate traveler names are rejected', async () => {
  assert.equal((await alex.call('POST', '/trips/1/members', { name: 'Traveler 02' })).status, 400);
});

test('web app pages are served', async () => {
  const origin = server.base.replace('/api', '');
  for (const p of ['/', '/app.js', '/app.css']) assert.equal((await fetch(origin + p)).status, 200, p);
});
