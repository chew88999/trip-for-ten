-- Trip planner schema: tasks, assignees, dependencies, and shared expenses.
-- Money is stored as integer cents to avoid floating-point rounding errors.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS trips (
  id            INTEGER PRIMARY KEY,
  name          TEXT    NOT NULL,
  destination   TEXT    NOT NULL,
  start_date    TEXT    NOT NULL,              -- ISO date YYYY-MM-DD
  end_date      TEXT    NOT NULL,
  base_currency TEXT    NOT NULL DEFAULT 'USD',
  notes         TEXT,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  CHECK (end_date >= start_date)
);

CREATE TABLE IF NOT EXISTS members (
  id         INTEGER PRIMARY KEY,
  trip_id    INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  name       TEXT    NOT NULL,
  email      TEXT,
  phone      TEXT,
  is_organizer INTEGER NOT NULL DEFAULT 0 CHECK (is_organizer IN (0, 1)),
  password_hash TEXT,                          -- scrypt "salt:hash"; set to the default password if NULL
  created_at TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (trip_id, name)
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT    PRIMARY KEY,
  member_id  INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  expires_at TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id             INTEGER PRIMARY KEY,
  trip_id        INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  title          TEXT    NOT NULL,
  description    TEXT,
  category       TEXT    NOT NULL DEFAULT 'general'
                 CHECK (category IN ('general','documents','transport','accommodation',
                                     'activities','food','finance','health','packing')),
  status         TEXT    NOT NULL DEFAULT 'todo'
                 CHECK (status IN ('todo','in_progress','done','cancelled')),
  priority       TEXT    NOT NULL DEFAULT 'medium'
                 CHECK (priority IN ('low','medium','high','critical')),
  start_date     TEXT,                          -- earliest date work should begin
  due_date       TEXT,                          -- deadline
  completed_at   TEXT,
  estimated_cost_cents INTEGER CHECK (estimated_cost_cents IS NULL OR estimated_cost_cents >= 0),
  created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  CHECK (due_date IS NULL OR start_date IS NULL OR due_date >= start_date)
);
CREATE INDEX IF NOT EXISTS idx_tasks_trip_due ON tasks(trip_id, due_date);

-- Many-to-many: a task can have several people, a person many tasks.
CREATE TABLE IF NOT EXISTS task_assignees (
  task_id   INTEGER NOT NULL REFERENCES tasks(id)   ON DELETE CASCADE,
  member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  role      TEXT    NOT NULL DEFAULT 'owner' CHECK (role IN ('owner','helper')),
  PRIMARY KEY (task_id, member_id)
);

-- task_id cannot start/finish until depends_on_task_id is done (finish-to-start).
-- Cycle prevention is enforced in the API layer.
CREATE TABLE IF NOT EXISTS task_dependencies (
  task_id            INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  depends_on_task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, depends_on_task_id),
  CHECK (task_id <> depends_on_task_id)
);

-- Edit history so the group can see who changed what on a task.
CREATE TABLE IF NOT EXISTS task_history (
  id         INTEGER PRIMARY KEY,
  task_id    INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  changed_by INTEGER REFERENCES members(id) ON DELETE SET NULL,
  field      TEXT    NOT NULL,
  old_value  TEXT,
  new_value  TEXT,
  changed_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Shared costs. paid_by fronted the money; expense_shares says who owes how much of it.
CREATE TABLE IF NOT EXISTS expenses (
  id           INTEGER PRIMARY KEY,
  trip_id      INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  task_id      INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
  description  TEXT    NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  currency     TEXT    NOT NULL DEFAULT 'USD',
  paid_by      INTEGER NOT NULL REFERENCES members(id),
  expense_date TEXT    NOT NULL DEFAULT (date('now')),
  split_method TEXT    NOT NULL DEFAULT 'equal' CHECK (split_method IN ('equal','custom')),
  created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS expense_shares (
  expense_id  INTEGER NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
  member_id   INTEGER NOT NULL REFERENCES members(id),
  share_cents INTEGER NOT NULL CHECK (share_cents >= 0),
  PRIMARY KEY (expense_id, member_id)
);

-- Repayments between members ("Alex paid Sam back $120").
CREATE TABLE IF NOT EXISTS settlements (
  id           INTEGER PRIMARY KEY,
  trip_id      INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  from_member  INTEGER NOT NULL REFERENCES members(id),
  to_member    INTEGER NOT NULL REFERENCES members(id),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  settled_on   TEXT    NOT NULL DEFAULT (date('now')),
  note         TEXT,
  CHECK (from_member <> to_member)
);

-- Keep updated_at / completed_at accurate on edits.
CREATE TRIGGER IF NOT EXISTS trg_tasks_updated
AFTER UPDATE ON tasks FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE tasks SET updated_at = datetime('now'),
    completed_at = CASE
      WHEN NEW.status = 'done' AND OLD.status <> 'done' THEN datetime('now')
      WHEN NEW.status <> 'done' THEN NULL
      ELSE NEW.completed_at END
  WHERE id = NEW.id;
END;

-- Views are rebuilt on every start so changes here reach existing databases.
DROP VIEW IF EXISTS v_member_balances;
DROP VIEW IF EXISTS v_task_overview;

-- Net position per member: positive = is owed money, negative = owes money.
CREATE VIEW v_member_balances AS
SELECT m.trip_id, m.id AS member_id, m.name,
  COALESCE((SELECT SUM(amount_cents) FROM expenses e WHERE e.paid_by = m.id), 0)          AS paid_cents,
  COALESCE((SELECT SUM(share_cents)  FROM expense_shares s WHERE s.member_id = m.id), 0)  AS share_cents,
  COALESCE((SELECT SUM(amount_cents) FROM settlements st WHERE st.from_member = m.id), 0) AS settled_out_cents,
  COALESCE((SELECT SUM(amount_cents) FROM settlements st WHERE st.to_member   = m.id), 0) AS settled_in_cents,
  COALESCE((SELECT SUM(amount_cents) FROM expenses e WHERE e.paid_by = m.id), 0)
  - COALESCE((SELECT SUM(share_cents) FROM expense_shares s WHERE s.member_id = m.id), 0)
  + COALESCE((SELECT SUM(amount_cents) FROM settlements st WHERE st.from_member = m.id), 0)
  - COALESCE((SELECT SUM(amount_cents) FROM settlements st WHERE st.to_member   = m.id), 0) AS net_cents
FROM members m;

-- Task list with assignee names and whether any prerequisite is still open.
CREATE VIEW v_task_overview AS
SELECT t.*,
  (SELECT group_concat(name, ', ') FROM (SELECT m.name FROM task_assignees a JOIN members m ON m.id = a.member_id
     WHERE a.task_id = t.id ORDER BY a.role DESC, m.name)) AS assignees,
  (SELECT group_concat(d.depends_on_task_id) FROM task_dependencies d WHERE d.task_id = t.id) AS depends_on,
  EXISTS (SELECT 1 FROM task_dependencies d JOIN tasks p ON p.id = d.depends_on_task_id
     WHERE d.task_id = t.id AND p.status NOT IN ('done','cancelled')) AS is_blocked,
  (t.status NOT IN ('done','cancelled') AND t.due_date < date('now')) AS is_overdue
FROM tasks t;
