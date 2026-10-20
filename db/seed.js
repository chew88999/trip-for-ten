// Seeds a 9-day March 2027 overseas trip for 10 people with a dependent task plan.
// Usage: npm run seed            (keeps existing data if a trip already exists)
//        npm run reset           (deletes the database and re-seeds)
import { rmSync, existsSync } from 'node:fs';
import { openDb, transaction, DB_PATH, DEFAULT_PASSWORD } from '../src/db.js';
import { hashPassword } from '../src/auth.js';

if (process.argv.includes('--reset')) {
  for (const suffix of ['', '-wal', '-shm']) {
    if (existsSync(DB_PATH + suffix)) rmSync(DB_PATH + suffix);
  }
}

const db = openDb();
if (db.prepare('SELECT COUNT(*) AS n FROM trips').get().n > 0) {
  console.log('Database already seeded. Use "npm run reset" to start over.');
  process.exit(0);
}

const members = [
  'Traveler 01', 'Traveler 02', 'Traveler 03', 'Traveler 04', 'Traveler 05',
  'Traveler 06', 'Traveler 07', 'Traveler 08', 'Traveler 09', 'Traveler 10',
];

// key, title, category, priority, start, due, assignee indexes (0-based), depends on keys
const tasks = [
  ['headcount',  'Confirm the 10 travelers and travel dates',          'general',       'critical', '2026-10-20', '2026-11-01', [0],    []],
  ['budget',     'Agree on per-person budget',                         'finance',       'high',     '2026-11-01', '2026-11-08', [0, 1], ['headcount']],
  ['passports',  'Check every passport is valid 6+ months past Mar 2027', 'documents',  'critical', '2026-10-20', '2026-11-15', [2],    ['headcount']],
  ['itinerary',  'Choose cities and high-level route for 9 days',      'general',       'high',     '2026-11-08', '2026-11-22', [0, 3], ['budget']],
  ['deposit',    'Collect deposit from each traveler into shared kitty','finance',      'high',     '2026-11-08', '2026-12-01', [1],    ['budget']],
  ['visa_check', 'Research visa / entry requirements for all nationalities', 'documents','high',    '2026-11-22', '2026-12-01', [2],    ['itinerary']],
  ['flights',    'Book group flights (names exactly as on passports)', 'transport',     'critical', '2026-12-01', '2026-12-15', [4],    ['itinerary', 'passports', 'deposit']],
  ['hotels',     'Book accommodation for 8 nights (5 rooms or rentals)','accommodation','critical', '2026-12-01', '2026-12-31', [5, 6], ['itinerary', 'deposit']],
  ['visas',      'Apply for visas / e-arrival cards where required',   'documents',     'critical', '2026-12-15', '2027-01-31', [2],    ['visa_check', 'flights']],
  ['insurance',  'Buy travel insurance for everyone',                  'health',        'high',     '2026-12-15', '2027-01-15', [7],    ['flights']],
  ['daily_plan', 'Draft day-by-day itinerary (Day 1 to Day 9)',        'activities',    'medium',   '2027-01-01', '2027-02-01', [3],    ['hotels', 'flights']],
  ['transfers',  'Book airport transfers for arrival and departure',   'transport',     'medium',   '2027-01-15', '2027-02-15', [4],    ['flights', 'hotels']],
  ['local_tx',   'Arrange local transport passes / intercity tickets', 'transport',     'medium',   '2027-02-01', '2027-02-20', [8],    ['daily_plan']],
  ['activities', 'Book tours, tickets and activities',                 'activities',    'medium',   '2027-02-01', '2027-02-20', [3, 9], ['daily_plan']],
  ['dining',     'Reserve group dinners (table for 10)',               'food',          'low',      '2027-02-01', '2027-02-28', [9],    ['daily_plan']],
  ['money',      'Arrange currency / travel cards',                    'finance',       'medium',   '2027-02-15', '2027-03-06', [1],    ['budget']],
  ['esim',       'Sort mobile data / eSIMs',                           'general',       'low',      '2027-02-15', '2027-03-06', [8],    ['flights']],
  ['docs_pack',  'Share emergency contacts and copies of passports/insurance', 'documents','high',  '2027-02-20', '2027-03-06', [7],    ['visas', 'insurance']],
  ['packing',    'Packing list and shared gear assignment',            'packing',       'low',      '2027-02-28', '2027-03-08', [6],    ['daily_plan']],
  ['checkin',    'Online check-in and seat selection',                 'transport',     'high',     '2027-03-11', '2027-03-12', [4],    ['flights', 'visas']],
  ['settle',     'Settle all shared expenses after the trip',          'finance',       'high',     '2027-03-21', '2027-03-31', [1],    ['checkin']],
];

transaction(db, () => {
  const tripId = db.prepare(`INSERT INTO trips (name, destination, start_date, end_date, base_currency, notes)
    VALUES (?, ?, ?, ?, ?, ?)`).run(
    'Group trip - March 2027', 'Overseas (destination TBD)', '2027-03-13', '2027-03-21', 'USD',
    '9 days / 8 nights, 10 travelers').lastInsertRowid;

  const insMember = db.prepare('INSERT INTO members (trip_id, name, is_organizer, password_hash) VALUES (?, ?, ?, ?)');
  const memberIds = members.map((name, i) => Number(insMember.run(tripId, name, i === 0 ? 1 : 0, hashPassword(DEFAULT_PASSWORD)).lastInsertRowid));

  const insTask = db.prepare(`INSERT INTO tasks (trip_id, title, category, priority, start_date, due_date)
    VALUES (?, ?, ?, ?, ?, ?)`);
  const insAssignee = db.prepare('INSERT INTO task_assignees (task_id, member_id, role) VALUES (?, ?, ?)');
  const insDep = db.prepare('INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES (?, ?)');

  const idByKey = {};
  for (const [key, title, category, priority, start, due, who] of tasks) {
    const id = Number(insTask.run(tripId, title, category, priority, start, due).lastInsertRowid);
    idByKey[key] = id;
    who.forEach((m, i) => insAssignee.run(id, memberIds[m], i === 0 ? 'owner' : 'helper'));
  }
  for (const [key, , , , , , , deps] of tasks) {
    for (const dep of deps) insDep.run(idByKey[key], idByKey[dep]);
  }
});

console.log(`Seeded ${members.length} members and ${tasks.length} tasks into ${DB_PATH}`);
