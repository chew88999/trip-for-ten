// Replaces data/trip.db with the standard seed plus realistic test data, entered through the API.
// Stop the running server first (the database file is replaced). Usage: npm run test-data
import { copyFileSync, existsSync } from 'node:fs';
import { DB_PATH } from '../src/db.js';
import { seed, startServer, client } from './harness.js';

if (existsSync(DB_PATH)) {
  const backup = DB_PATH.replace(/\.db$/, `-backup-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.db`);
  copyFileSync(DB_PATH, backup);
  console.log(`Backed up current database to ${backup}`);
}
try { seed(DB_PATH); } catch (err) {
  console.error(`${err.message}\nIs the app still running? Stop it first, then re-run.`);
  process.exit(1);
}

const server = await startServer({ dbPath: DB_PATH, port: 3099 });
try {
  const as = {};
  const people = [
    ['alex', 'Alex Tan'], ['priya', 'Priya Nair'], ['ben', 'Ben Wong'], ['chloe', 'Chloe Lim'], ['daniel', 'Daniel Ong'],
    ['emily', 'Emily Koh'], ['farid', 'Farid Rahman'], ['grace', 'Grace Lee'], ['hiro', 'Hiro Sato'], ['isabel', 'Isabel Cruz'],
  ];
  const id = {};
  people.forEach(([key], i) => (id[key] = i + 1));

  // Each person gets their own logged-in session.
  for (const [key] of people) { as[key] = client(server.base); await as[key].login(id[key]); }

  // Real names and contact details.
  for (const [key, name] of people) {
    await as.alex.patch(`/members/${id[key]}`, { name, email: `${key}@example.com`, phone: `+65 9${String(100 + id[key]).padStart(3, '0')} ${String(1000 + id[key] * 37)}` });
  }
  await as.alex.patch('/trips/1', { name: 'Japan with the gang - March 2027', destination: 'Japan (Tokyo, Kyoto, Osaka)', notes: '9 days / 8 nights. Fly in to Tokyo, out of Osaka.' });

  const tasks = await as.alex.get('/trips/1/tasks');
  const task = (start) => tasks.find((t) => t.title.startsWith(start)).id;

  // Progress made so far, by different people.
  await as.alex.patch(`/tasks/${task('Confirm the 10')}`, { status: 'done', description: 'All 10 confirmed in the group chat on 18 Oct.' });
  await as.priya.patch(`/tasks/${task('Agree on per-person')}`, { status: 'in_progress', description: 'Proposal: USD 2,800 per person excluding flights. Vote closes 8 Nov.', estimated_cost: 28000 });
  await as.ben.patch(`/tasks/${task('Check every passport')}`, { status: 'in_progress', description: '8 of 10 checked. Waiting for Hiro and Isabel to send photo pages.' });
  await as.emily.patch(`/tasks/${task('Book accommodation')}`, { estimated_cost: 9600, description: 'Looking at two 5-person apartments per city.' });
  await as.daniel.patch(`/tasks/${task('Book group flights')}`, { estimated_cost: 12000, priority: 'critical' });
  await as.grace.patch(`/tasks/${task('Buy travel insurance')}`, { estimated_cost: 850 });

  // An overdue task, a cancelled task, and one with a schedule conflict (due before its prerequisite).
  await as.chloe.post('/trips/1/tasks', {
    title: 'Create group chat and shared photo folder', category: 'general', priority: 'medium',
    start_date: '2026-10-01', due_date: '2026-10-15', assignees: [id.chloe],
  });
  await as.hiro.post('/trips/1/tasks', {
    title: 'Look into a 7-day JR Pass', category: 'transport', priority: 'low', status: 'cancelled',
    description: 'Not worth it after the 2023 price rise; individual tickets are cheaper for our route.',
    start_date: '2026-10-05', due_date: '2026-10-25', assignees: [id.hiro],
  });
  await as.isabel.post('/trips/1/tasks', {
    title: 'Book tea ceremony in Kyoto (Day 5)', category: 'activities', priority: 'medium',
    start_date: '2027-01-20', due_date: '2027-02-10', estimated_cost: 450,
    assignees: [id.isabel, id.grace], depends_on: [task('Book tours, tickets')],
  });

  // Shared expenses so far, covering every split type.
  await as.emily.post('/trips/1/expenses', {
    description: 'Apartment booking deposit (refundable)', amount: 2000, paid_by: id.emily,
    task_id: task('Book accommodation'), expense_date: '2026-10-12',
  });
  await as.chloe.post('/trips/1/expenses', {
    description: 'Japan guidebooks x3', amount: 45.9, paid_by: id.chloe, expense_date: '2026-10-08',
    split_between: [id.chloe, id.daniel, id.grace],
  });
  await as.alex.post('/trips/1/expenses', {
    description: 'Planning dinner (drinks charged to who had them)', amount: 287.5, paid_by: id.alex,
    expense_date: '2026-10-18', split_method: 'custom', shares: [
      { member_id: id.alex, amount: 52.5 }, { member_id: id.priya, amount: 41 }, { member_id: id.ben, amount: 48 },
      { member_id: id.farid, amount: 38 }, { member_id: id.hiro, amount: 61 }, { member_id: id.isabel, amount: 47 },
    ],
  });
  await as.hiro.post('/trips/1/expenses', {
    description: 'eSIM bundle (10 x 9-day)', amount: 239.99, paid_by: id.hiro, expense_date: '2026-10-19',
    task_id: task('Sort mobile data'),
  });
  await as.ben.post('/trips/1/expenses', {
    description: 'Passport photo service', amount: 84, paid_by: id.ben, expense_date: '2026-10-16',
    split_between: [id.ben, id.isabel], task_id: task('Check every passport'),
  });

  // Some people have already paid back.
  await as.priya.post('/trips/1/settlements', { from_member: id.priya, to_member: id.emily, amount: 200, note: 'Bank transfer' });
  await as.daniel.post('/trips/1/settlements', { from_member: id.daniel, to_member: id.chloe, amount: 15.3, note: 'Cash' });

  const after = await as.alex.get('/trips/1/tasks');
  const exp = await as.alex.get('/trips/1/expenses');
  console.log(`Loaded test data: ${people.length} people, ${after.length} tasks, ${exp.length} expenses, 2 repayments.`);
  console.log('Sign in as any of them with password 1234.');
} finally {
  server.stop();
}
