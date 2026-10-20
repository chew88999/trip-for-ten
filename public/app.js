// Trip for Ten — front end. Talks to the Express API on the same origin.
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const CATEGORIES = ['general', 'documents', 'transport', 'accommodation', 'activities', 'food', 'finance', 'health', 'packing'];
const STATUS_LABEL = { todo: 'To do', in_progress: 'In progress', done: 'Done', cancelled: 'Cancelled' };
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

const state = { me: null, trip: null, members: [], tasks: [], expenses: [], balances: null, settlements: [], timeline: null };
let currentTab = 'tasks';

// ---------- API ----------

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && path !== '/login') { showLogin(); throw new Error('Please sign in'); }
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data;
}

function toast(msg, bad = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = bad ? 'toast bad' : 'toast';
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), bad ? 5000 : 2500);
}

// ---------- formatting ----------

function money(n) {
  const currency = state.trip?.base_currency || 'USD';
  try { return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(n ?? 0); }
  catch { return `${currency} ${(n ?? 0).toFixed(2)}`; }
}
const parseDate = (d) => new Date(`${d}T00:00:00`);
const fmtDate = (d, opts = { day: 'numeric', month: 'short' }) => d ? parseDate(d).toLocaleDateString(undefined, opts) : '';
// Local calendar date (toISOString would give the UTC date, which is wrong early/late in the day).
const today = () => new Date().toLocaleDateString('en-CA');
// The database stores timestamps in UTC as "YYYY-MM-DD HH:MM:SS".
const localTime = (ts) => new Date(`${ts.replace(' ', 'T')}Z`).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const memberName = (id) => state.members.find((m) => m.id === id)?.name ?? '?';

// ---------- login ----------

async function showLogin() {
  $('#app-view').hidden = true;
  $('#login-view').hidden = false;
  const names = await api('/login-options');
  $('#login-name').innerHTML = '<option value="">Choose your name…</option>' +
    names.map((m) => `<option value="${m.id}">${esc(m.name)}</option>`).join('');
  try { const last = localStorage.getItem('lastMember'); if (last) $('#login-name').value = last; } catch {}
  $('#login-password').value = '';
  ($('#login-name').value ? $('#login-password') : $('#login-name')).focus();
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#login-error').hidden = true;
  try {
    await api('/login', { method: 'POST', body: { member_id: Number($('#login-name').value), password: $('#login-password').value } });
    try { localStorage.setItem('lastMember', $('#login-name').value); } catch {}
    await start();
  } catch (err) {
    $('#login-error').textContent = err.message;
    $('#login-error').hidden = false;
  }
});

$('#logout-btn').addEventListener('click', async () => {
  await api('/logout', { method: 'POST' });
  showLogin();
});

// ---------- loading ----------

async function start() {
  try { state.me = await api('/me'); } catch { return; }
  $('#login-view').hidden = true;
  $('#app-view').hidden = false;
  $('#me-name').textContent = state.me.name;
  await refresh();
}

async function refresh() {
  const t = state.me.trip_id;
  const [trip, tasks, expenses, balances, settlements, timeline] = await Promise.all([
    api(`/trips/${t}`), api(`/trips/${t}/tasks`), api(`/trips/${t}/expenses`),
    api(`/trips/${t}/balances`), api(`/trips/${t}/settlements`), api(`/trips/${t}/timeline`),
  ]);
  Object.assign(state, { trip, members: trip.members, tasks, expenses, balances, settlements, timeline });
  renderHeader();
  renderFilters();
  renderTasks();
  renderTimeline();
  renderExpenses();
  renderPeople();
}

function renderHeader() {
  const { trip } = state;
  $('#trip-name').textContent = trip.name;
  const nights = Math.round((parseDate(trip.end_date) - parseDate(trip.start_date)) / 864e5);
  $('#trip-meta').textContent = `${trip.destination} · ${fmtDate(trip.start_date, { day: 'numeric', month: 'short', year: 'numeric' })} – ${fmtDate(trip.end_date, { day: 'numeric', month: 'short', year: 'numeric' })} · ${nights + 1} days · ${state.members.length} travelers`;
  const days = Math.ceil((parseDate(trip.start_date) - parseDate(today())) / 864e5);
  $('#countdown').textContent = days > 0 ? `${days} days to go` : days > -nights - 1 ? 'Trip in progress' : 'Trip finished';
  document.title = `${trip.name} · Trip for Ten`;
}

// ---------- tabs ----------

$$('.tabs button').forEach((b) => b.addEventListener('click', () => {
  currentTab = b.dataset.tab;
  $$('.tabs button').forEach((x) => x.classList.toggle('active', x === b));
  $$('.tab').forEach((s) => (s.hidden = s.id !== `tab-${currentTab}`));
}));

// ---------- tasks ----------

function renderFilters() {
  const a = $('#f-assignee');
  const prev = a.value || 'all';
  a.innerHTML = `<option value="all">Everyone's tasks</option><option value="me">My tasks</option>` +
    state.members.map((m) => `<option value="${m.id}">${esc(m.name)}</option>`).join('');
  a.value = prev;
  const c = $('#f-category');
  if (c.options.length === 1) c.innerHTML += CATEGORIES.map((x) => `<option value="${x}">${cap(x)}</option>`).join('');
  $('#t-category').innerHTML = CATEGORIES.map((x) => `<option value="${x}">${cap(x)}</option>`).join('');
}
['#f-search', '#f-assignee', '#f-status', '#f-category'].forEach((s) => $(s).addEventListener('input', renderTasks));

function assigneeIds(task) {
  // v_task_overview gives names; map back to ids for filtering.
  return (task.assignees ?? '').split(', ').filter(Boolean).map((n) => state.members.find((m) => m.name === n)?.id);
}

function renderTasks() {
  const total = state.tasks.filter((t) => t.status !== 'cancelled').length;
  const done = state.tasks.filter((t) => t.status === 'done').length;
  $('#progress-bar').style.width = `${total ? (done / total) * 100 : 0}%`;
  $('#progress-label').textContent = `${done} of ${total} tasks done`;

  const q = $('#f-search').value.trim().toLowerCase();
  const who = $('#f-assignee').value;
  const status = $('#f-status').value;
  const cat = $('#f-category').value;
  const list = state.tasks.filter((t) =>
    (!q || `${t.title} ${t.description ?? ''} ${t.assignees ?? ''}`.toLowerCase().includes(q)) &&
    (who === 'all' || assigneeIds(t).includes(who === 'me' ? state.me.id : Number(who))) &&
    (!status || (status === 'open' ? !['done', 'cancelled'].includes(t.status) : t.status === status)) &&
    (!cat || t.category === cat));

  if (!list.length) { $('#task-list').innerHTML = '<li class="empty">No tasks match these filters.</li>'; return; }
  let month = null;
  let html = '';
  for (const t of list) {
    const m = t.due_date ? fmtDate(t.due_date, { month: 'long', year: 'numeric' }) : 'No due date';
    if (m !== month) { html += `<li class="month">${m}</li>`; month = m; }
    const deps = (t.depends_on ?? '').split(',').filter(Boolean).length;
    html += `<li class="task ${t.status === 'done' ? 'done' : ''}" data-id="${t.id}">
      <input type="checkbox" ${t.status === 'done' ? 'checked' : ''} aria-label="Mark done" data-toggle="${t.id}">
      <div class="body">
        <div class="title">${esc(t.title)}</div>
        <div class="meta">
          ${t.status === 'in_progress' ? '<span class="chip in_progress">In progress</span>' : ''}
          ${t.status === 'cancelled' ? '<span class="chip">Cancelled</span>' : ''}
          ${t.is_blocked ? '<span class="chip blocked">Waiting on other tasks</span>' : ''}
          <span class="chip ${t.priority}">${cap(t.priority)}</span>
          <span class="chip">${cap(t.category)}</span>
          ${t.assignees ? `<span>👤 ${esc(t.assignees)}</span>` : '<span>Unassigned</span>'}
          ${deps ? `<span>· ${deps} prerequisite${deps > 1 ? 's' : ''}</span>` : ''}
          ${t.estimated_cost_cents ? `<span>· est. ${money(t.estimated_cost_cents / 100)}</span>` : ''}
        </div>
      </div>
      <div class="due ${t.is_overdue ? 'overdue' : ''}">${t.due_date ? `Due ${fmtDate(t.due_date)}` : ''}</div>
    </li>`;
  }
  $('#task-list').innerHTML = html;
}

$('#task-list').addEventListener('click', async (e) => {
  const toggle = e.target.closest('[data-toggle]');
  if (toggle) {
    const id = Number(toggle.dataset.toggle);
    try {
      await api(`/tasks/${id}`, { method: 'PATCH', body: { status: toggle.checked ? 'done' : 'todo' } });
      await refresh();
    } catch (err) { toggle.checked = !toggle.checked; toast(err.message, true); }
    return;
  }
  const row = e.target.closest('.task');
  if (row) openTask(Number(row.dataset.id));
});

$('#new-task-btn').addEventListener('click', () => openTask(null));

// ---------- task dialog ----------

async function openTask(id) {
  const task = id ? await api(`/tasks/${id}`) : {
    title: '', description: '', status: 'todo', priority: 'medium', category: 'general',
    start_date: today(), due_date: '', estimated_cost: null, assignees: [{ id: state.me.id, role: 'owner' }], depends_on: [], blocks: [],
  };
  $('#task-dialog-title').textContent = id ? 'Edit task' : 'New task';
  $('#t-id').value = id ?? '';
  $('#t-title').value = task.title;
  $('#t-description').value = task.description ?? '';
  $('#t-status').value = task.status;
  $('#t-priority').value = task.priority;
  $('#t-category').value = task.category;
  $('#t-start').value = task.start_date ?? '';
  $('#t-due').value = task.due_date ?? '';
  $('#t-cost').value = task.estimated_cost ?? '';

  const owner = task.assignees.find((a) => a.role === 'owner')?.id ?? '';
  const helpers = new Set(task.assignees.filter((a) => a.role === 'helper').map((a) => a.id));
  $('#t-owner').innerHTML = '<option value="">Unassigned</option>' +
    state.members.map((m) => `<option value="${m.id}">${esc(m.name)}</option>`).join('');
  $('#t-owner').value = owner;
  $('#t-helpers').innerHTML = state.members.map((m) =>
    `<label><input type="checkbox" value="${m.id}" ${helpers.has(m.id) ? 'checked' : ''}> ${esc(m.name)}</label>`).join('');

  const depIds = new Set(task.depends_on.map((d) => d.id));
  $('#t-dep-search').value = '';
  $('#t-deps').innerHTML = state.tasks.filter((t) => t.id !== id).map((t) =>
    `<label data-title="${esc(t.title.toLowerCase())}"><input type="checkbox" value="${t.id}" ${depIds.has(t.id) ? 'checked' : ''}>
      ${esc(t.title)} <span class="date">${t.status === 'done' ? '✓ ' : ''}${fmtDate(t.due_date)}</span></label>`).join('');

  $('#t-blocks').textContent = task.blocks.length ? `Other tasks waiting on this one: ${task.blocks.map((b) => b.title).join('; ')}` : '';
  $('#t-delete').hidden = !id;
  $('#t-history-wrap').hidden = !id;
  $('#t-history').innerHTML = '';
  if (id) {
    const hist = await api(`/tasks/${id}/history`);
    $('#t-history').innerHTML = hist.length ? hist.map((h) =>
      `<li>${esc(localTime(h.changed_at))} · <b>${esc(h.changed_by_name ?? 'Someone')}</b> changed ${esc(h.field.replace('_cents', ''))}: ${esc(h.old_value ?? '—')} → ${esc(h.new_value ?? '—')}</li>`).join('')
      : '<li class="muted">No edits yet.</li>';
  }
  $('#t-error').hidden = true;
  $('#task-dialog').showModal();
  $('#t-title').focus();
}

$('#t-dep-search').addEventListener('input', (e) => {
  const q = e.target.value.toLowerCase();
  $$('#t-deps label').forEach((l) => (l.hidden = q && !l.dataset.title.includes(q)));
});

$('#t-cancel').addEventListener('click', () => $('#task-dialog').close());

$('#task-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = $('#t-id').value;
  const owner = Number($('#t-owner').value);
  const helpers = $$('#t-helpers input:checked').map((i) => Number(i.value)).filter((h) => h !== owner);
  const body = {
    title: $('#t-title').value.trim(),
    description: $('#t-description').value.trim() || null,
    status: $('#t-status').value,
    priority: $('#t-priority').value,
    category: $('#t-category').value,
    start_date: $('#t-start').value || null,
    due_date: $('#t-due').value || null,
    estimated_cost: $('#t-cost').value === '' ? null : Number($('#t-cost').value),
    assignees: [...(owner ? [{ member_id: owner, role: 'owner' }] : []), ...helpers.map((h) => ({ member_id: h, role: 'helper' }))],
    depends_on: $$('#t-deps input:checked').map((i) => Number(i.value)),
  };
  try {
    await api(id ? `/tasks/${id}` : `/trips/${state.me.trip_id}/tasks`, { method: id ? 'PATCH' : 'POST', body });
    $('#task-dialog').close();
    toast(id ? 'Task saved' : 'Task added');
    await refresh();
  } catch (err) {
    $('#t-error').textContent = err.message;
    $('#t-error').hidden = false;
  }
});

$('#t-delete').addEventListener('click', async () => {
  const id = $('#t-id').value;
  if (!confirm(`Delete "${$('#t-title').value}"? This can't be undone.`)) return;
  await api(`/tasks/${id}`, { method: 'DELETE' });
  $('#task-dialog').close();
  toast('Task deleted');
  await refresh();
});

// ---------- timeline (Gantt) ----------

function renderTimeline() {
  const { tasks, trip, timeline } = state;
  const conflicts = timeline.schedule_conflicts;
  $('#conflicts').innerHTML = conflicts.length ? `<div class="warn-box"><b>Schedule conflicts:</b><br>${conflicts.map((c) =>
    `“${esc(c.title)}” is due ${fmtDate(c.due_date)} but depends on “${esc(c.depends_on_title)}” due ${fmtDate(c.depends_on_due)}`).join('<br>')}</div>` : '';

  const dated = tasks.filter((t) => t.due_date).sort((a, b) => (a.start_date ?? a.due_date).localeCompare(b.start_date ?? b.due_date) || a.due_date.localeCompare(b.due_date));
  const allDates = [today(), trip.start_date, trip.end_date, ...dated.flatMap((t) => [t.start_date ?? t.due_date, t.due_date])];
  const min = parseDate(allDates.reduce((a, b) => (a < b ? a : b)));
  min.setDate(1);
  const max = parseDate(allDates.reduce((a, b) => (a > b ? a : b)));
  max.setDate(max.getDate() + 7);
  const span = max - min;
  const pct = (d) => ((parseDate(d) - min) / span) * 100;

  let months = '';
  for (const d = new Date(min); d < max; d.setMonth(d.getMonth() + 1)) {
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
    if (pct(iso) > 94) break;   // no room to label a month that starts at the right edge
    months += `<span class="g-month" style="left:${pct(iso)}%">${d.toLocaleDateString(undefined, { month: 'short', year: 'numeric' })}</span>`;
  }
  const overlay = `<div class="g-trip" style="left:${pct(trip.start_date)}%;width:${pct(trip.end_date) - pct(trip.start_date) + (864e5 / span) * 100}%"></div>
    <div class="g-today" style="left:${pct(today())}%"></div>`;

  const rows = dated.map((t) => {
    const start = t.start_date ?? t.due_date;
    const cls = t.status === 'done' ? 'done' : t.status === 'cancelled' ? 'cancelled' : t.is_overdue ? 'overdue' : t.is_blocked ? 'blocked' : '';
    const width = Math.max(pct(t.due_date) - pct(start) + (864e5 / span) * 100, 0.5);
    return `<div class="g-row"><div class="g-label" data-id="${t.id}" title="${esc(t.title)}">${esc(t.title)}</div>
      <div class="g-track">${overlay}<div class="g-bar ${cls}" data-id="${t.id}" style="left:${pct(start)}%;width:${width}%"
        title="${esc(t.title)}: ${fmtDate(start)} – ${fmtDate(t.due_date)} (${STATUS_LABEL[t.status]})"></div></div></div>`;
  }).join('');

  $('#gantt').innerHTML = `<div class="legend" style="padding:10px 10px 0">
      <span><i style="background:var(--accent)"></i>Open</span><span><i style="background:var(--warn)"></i>Waiting on others</span>
      <span><i style="background:var(--danger)"></i>Overdue</span><span><i style="background:var(--ok)"></i>Done</span>
      <span><i style="background:var(--trip-band);border:1px solid var(--border)"></i>Trip dates</span>
      <span><i style="background:var(--danger);width:2px"></i>Today</span></div>
    <div class="gantt-inner"><div class="g-row g-head"><div class="g-label"></div><div class="g-track">${months}</div></div>${rows}</div>`;
}

$('#gantt').addEventListener('click', (e) => {
  const el = e.target.closest('[data-id]');
  if (el) openTask(Number(el.dataset.id));
});

// ---------- expenses ----------

function renderExpenses() {
  const { balances, expenses, settlements, members } = state;
  $('#balance-table').innerHTML = `<tr><th>Person</th><th class="num">Paid</th><th class="num">Share</th>
      <th class="num" title="Repayments sent (+) or received (−)">Paid back</th><th class="num">Balance</th></tr>` +
    balances.balances.map((b) => `<tr><td>${esc(b.name)}${b.member_id === state.me.id ? ' (you)' : ''}</td>
      <td class="num">${money(b.paid)}</td><td class="num">${money(b.fair_share)}</td>
      <td class="num muted">${b.paid_back > 0 ? '+' : b.paid_back < 0 ? '−' : ''}${b.paid_back ? money(Math.abs(b.paid_back)) : '–'}</td>
      <td class="num ${b.net > 0 ? 'pos' : b.net < 0 ? 'neg' : ''}">${b.net > 0 ? 'gets back ' : b.net < 0 ? 'owes ' : ''}${money(Math.abs(b.net))}</td></tr>`).join('');

  $('#payments').innerHTML = balances.suggested_payments.length ? balances.suggested_payments.map((p, i) =>
    `<li class="payment"><span><b>${esc(p.from)}</b> pays <b>${esc(p.to)}</b> ${money(p.amount)}</span>
      <button class="link" data-pay="${i}">Mark paid</button></li>`).join('')
    : '<li class="muted">Everyone is settled up.</li>';

  $('#expense-table').innerHTML = expenses.length ? `<tr><th>Date</th><th>Description</th><th>Paid by</th><th>Split</th><th class="num">Amount</th><th></th></tr>` +
    expenses.map((e) => `<tr><td>${fmtDate(e.expense_date)}</td><td>${esc(e.description)}</td><td>${esc(e.paid_by_name)}</td>
      <td>${e.split_method === 'custom' ? 'Custom' : e.shares.length === members.length ? 'Everyone' : `${e.shares.length} people`}</td>
      <td class="num">${money(e.amount)}</td>
      <td class="num"><button class="link" data-edit-ex="${e.id}">Edit</button><button class="link" data-del-ex="${e.id}">Delete</button></td></tr>`).join('')
    : '<tr><td class="muted">No expenses yet. Add the first one above.</td></tr>';

  $('#settlement-table').innerHTML = settlements.length ? `<tr><th>Date</th><th>From</th><th>To</th><th class="num">Amount</th><th></th></tr>` +
    settlements.map((s) => `<tr><td>${fmtDate(s.settled_on)}</td><td>${esc(memberName(s.from_member))}</td><td>${esc(memberName(s.to_member))}</td>
      <td class="num">${money(s.amount_cents / 100)}</td><td class="num"><button class="link" data-del-st="${s.id}">Undo</button></td></tr>`).join('')
    : '<tr><td class="muted">No repayments recorded yet.</td></tr>';

  if (!$('#ex-id').value) resetExpenseForm();
}

function resetExpenseForm() {
  $('#expense-form').reset();
  $('#ex-id').value = '';
  $('#expense-form-title').textContent = 'Add an expense';
  $('#ex-cancel').hidden = true;
  $('#ex-error').hidden = true;
  $('#ex-date').value = today();
  $('#ex-paid-by').innerHTML = state.members.map((m) => `<option value="${m.id}">${esc(m.name)}</option>`).join('');
  $('#ex-paid-by').value = state.me.id;
  $('#ex-task').innerHTML = '<option value="">None</option>' + state.tasks.map((t) => `<option value="${t.id}">${esc(t.title)}</option>`).join('');
  renderSplitPeople();
}

function splitMode() { return $('input[name=ex-split]:checked').value; }

function renderSplitPeople(shares = null) {
  const mode = splitMode();
  const box = $('#ex-split-people');
  const shareMap = new Map((shares ?? []).map((s) => [s.member_id, s.share]));
  if (mode === 'all') { box.innerHTML = ''; updateSplitHint(); return; }
  box.innerHTML = state.members.map((m) => mode === 'custom'
    ? `<label>${esc(m.name)} <input type="number" min="0" step="0.01" data-share="${m.id}" value="${shareMap.get(m.id) ?? ''}" placeholder="0"></label>`
    : `<label><input type="checkbox" data-pick="${m.id}" ${!shares || shareMap.has(m.id) ? 'checked' : ''}> ${esc(m.name)}</label>`).join('');
  updateSplitHint();
}

function updateSplitHint() {
  const amount = Number($('#ex-amount').value) || 0;
  const mode = splitMode();
  let text = '';
  if (mode === 'all') text = `${money(amount / state.members.length)} each across ${state.members.length} people`;
  if (mode === 'some') {
    const n = $$('[data-pick]:checked').length;
    text = n ? `${money(amount / n)} each across ${n} people` : 'Pick at least one person';
  }
  if (mode === 'custom') {
    const sum = $$('[data-share]').reduce((s, i) => s + (Number(i.value) || 0), 0);
    const left = Math.round((amount - sum) * 100) / 100;
    text = left === 0 ? 'Shares add up ✓' : `${money(Math.abs(left))} ${left > 0 ? 'still to assign' : 'too much assigned'}`;
  }
  $('#ex-split-hint').textContent = text;
}

$$('input[name=ex-split]').forEach((r) => r.addEventListener('change', () => renderSplitPeople()));
$('#expense-form').addEventListener('input', (e) => { if (e.target.name !== 'ex-split') updateSplitHint(); });
$('#ex-cancel').addEventListener('click', resetExpenseForm);

$('#expense-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = $('#ex-id').value;
  const mode = splitMode();
  const body = {
    description: $('#ex-desc').value.trim(),
    amount: Number($('#ex-amount').value),
    paid_by: Number($('#ex-paid-by').value),
    expense_date: $('#ex-date').value || null,
    task_id: $('#ex-task').value ? Number($('#ex-task').value) : null,
    currency: state.trip.base_currency,
    split_method: mode === 'custom' ? 'custom' : 'equal',
  };
  if (mode === 'all') body.split_between = state.members.map((m) => m.id);
  if (mode === 'some') body.split_between = $$('[data-pick]:checked').map((i) => Number(i.dataset.pick));
  if (mode === 'custom') body.shares = $$('[data-share]').filter((i) => Number(i.value) > 0).map((i) => ({ member_id: Number(i.dataset.share), amount: Number(i.value) }));
  if (mode === 'some' && !body.split_between.length) { showExError('Pick at least one person to split with'); return; }
  try {
    await api(id ? `/expenses/${id}` : `/trips/${state.me.trip_id}/expenses`, { method: id ? 'PATCH' : 'POST', body });
    $('#ex-id').value = '';
    toast(id ? 'Expense updated' : 'Expense added');
    await refresh();
  } catch (err) { showExError(err.message); }
});

function showExError(msg) { $('#ex-error').textContent = msg; $('#ex-error').hidden = false; }

$('#tab-expenses').addEventListener('click', async (e) => {
  const t = e.target;
  try {
    if (t.dataset.pay) {
      const p = state.balances.suggested_payments[Number(t.dataset.pay)];
      if (!confirm(`Record that ${p.from} paid ${p.to} ${money(p.amount)}?`)) return;
      await api(`/trips/${state.me.trip_id}/settlements`, { method: 'POST', body: { from_member: p.from_member, to_member: p.to_member, amount: p.amount } });
      toast('Repayment recorded');
      await refresh();
    } else if (t.dataset.delEx) {
      if (!confirm('Delete this expense?')) return;
      await api(`/expenses/${t.dataset.delEx}`, { method: 'DELETE' });
      await refresh();
    } else if (t.dataset.delSt) {
      if (!confirm('Undo this repayment?')) return;
      await api(`/settlements/${t.dataset.delSt}`, { method: 'DELETE' });
      await refresh();
    } else if (t.dataset.editEx) {
      const ex = state.expenses.find((x) => x.id === Number(t.dataset.editEx));
      resetExpenseForm();
      $('#ex-id').value = ex.id;
      $('#expense-form-title').textContent = 'Edit expense';
      $('#ex-cancel').hidden = false;
      $('#ex-desc').value = ex.description;
      $('#ex-amount').value = ex.amount;
      $('#ex-paid-by').value = ex.paid_by;
      $('#ex-date').value = ex.expense_date;
      $('#ex-task').value = ex.task_id ?? '';
      const mode = ex.split_method === 'custom' ? 'custom' : ex.shares.length === state.members.length ? 'all' : 'some';
      $(`input[name=ex-split][value=${mode}]`).checked = true;
      renderSplitPeople(ex.shares);
      $('#expense-form').scrollIntoView({ behavior: 'smooth' });
    }
  } catch (err) { toast(err.message, true); }
});

// ---------- people & trip ----------

function renderPeople() {
  $('#member-table').innerHTML = `<tr><th>Name</th><th>Email</th><th>Phone</th><th></th></tr>` +
    state.members.map((m) => `<tr data-member="${m.id}">
      <td><input data-f="name" value="${esc(m.name)}" aria-label="Name"></td>
      <td><input data-f="email" type="email" value="${esc(m.email)}" aria-label="Email" placeholder="Email"></td>
      <td><input data-f="phone" value="${esc(m.phone)}" aria-label="Phone" placeholder="Phone"></td>
      <td>${m.id === state.me.id ? '<span class="muted small">you</span>' : `<button class="link" data-del-member="${m.id}">Remove</button>`}</td></tr>`).join('');
  const t = state.trip;
  $('#trip-f-name').value = t.name;
  $('#trip-f-destination').value = t.destination;
  $('#trip-f-start').value = t.start_date;
  $('#trip-f-end').value = t.end_date;
  $('#trip-f-currency').value = t.base_currency;
  $('#trip-f-notes').value = t.notes ?? '';
}

$('#member-table').addEventListener('change', async (e) => {
  const row = e.target.closest('[data-member]');
  if (!row || !e.target.dataset.f) return;
  try {
    await api(`/members/${row.dataset.member}`, { method: 'PATCH', body: { [e.target.dataset.f]: e.target.value.trim() || null } });
    toast('Saved');
    await refresh();
  } catch (err) { toast(err.message, true); }
});

$('#member-table').addEventListener('click', async (e) => {
  const id = e.target.dataset.delMember;
  if (!id) return;
  if (!confirm(`Remove ${memberName(Number(id))} from the trip?`)) return;
  try {
    await api(`/members/${id}`, { method: 'DELETE' });
    await refresh();
  } catch (err) { toast(err.message.includes('FOREIGN KEY') ? 'This person has expenses or repayments recorded, so they can\'t be removed.' : err.message, true); }
});

$('#add-member-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api(`/trips/${state.me.trip_id}/members`, { method: 'POST', body: { name: $('#new-member-name').value.trim() } });
    $('#new-member-name').value = '';
    toast('Traveler added');
    await refresh();
  } catch (err) { toast(err.message, true); }
});

$('#trip-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api(`/trips/${state.me.trip_id}`, { method: 'PATCH', body: {
      name: $('#trip-f-name').value.trim(), destination: $('#trip-f-destination').value.trim(),
      start_date: $('#trip-f-start').value, end_date: $('#trip-f-end').value,
      base_currency: $('#trip-f-currency').value.trim().toUpperCase(), notes: $('#trip-f-notes').value.trim() || null,
    } });
    toast('Trip saved');
    await refresh();
  } catch (err) { toast(err.message, true); }
});

$('#password-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/me/password', { method: 'POST', body: { current_password: $('#pw-current').value, new_password: $('#pw-new').value } });
    e.target.reset();
    toast('Password updated');
  } catch (err) { toast(err.message, true); }
});

start().catch(() => {});
