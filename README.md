# Trip for Ten — backend

Todoist-style planner for a 9-day overseas group trip (13–21 March 2027, 10 travelers), with shared expense tracking ("who owes what").

- **Database:** SQLite (built into Node 22.13+), file at `data/trip.db`
- **API:** Express, `http://localhost:3000/api`

```bash
npm install
npm run seed     # first-time seed (no-op if data exists)
npm run reset    # wipe and re-seed
npm start        # start API on localhost:3000
```

## Test data and tests

```bash
npm run test-data   # stop the app first; backs up data/trip.db, then loads 10 named travelers,
                    # task progress, 5 expenses and 2 repayments through the API
npm test            # 24 end-to-end API tests on a throwaway database (port 3101); never touches data/trip.db
```

`npm run reset` returns to the clean 21-task plan with "Traveler 01–10".

## Web app

Open **http://localhost:3000**, pick your name from the dropdown and sign in with the password **`1234`** (everyone's starting password; each person can change theirs under *People & trip*).

| Tab | What you can do |
|---|---|
| Tasks | Filter (mine / anyone's, status, category, search), tick tasks done, click a task to edit every field, owner, helpers and prerequisites, and see its edit history |
| Timeline | Gantt chart of all tasks with today's date and the trip dates, plus warnings when a task is due before its prerequisites |
| Who owes what | Add/edit expenses (split equally, among selected people, or custom amounts), see balances, and mark suggested repayments as paid |
| People & trip | Edit travelers' names and contact details, add/remove travelers, edit trip details, change your password |

The starting password can be changed with the `DEFAULT_PASSWORD` environment variable before seeding. It is meant for use on your own computer; use stronger passwords before putting this on a network.

The SQLite file can also be opened with [DB Browser for SQLite](https://sqlitebrowser.org/).

## Tables

| Table | Purpose |
|---|---|
| `trips` | Trip name, destination, dates, base currency |
| `members` | The 10 travelers |
| `tasks` | Title, description, category, status, priority, start/due dates, estimated cost |
| `task_assignees` | Who is on each task (`owner` / `helper`), many-to-many |
| `task_dependencies` | Task B can't be done until task A is done |
| `task_history` | Audit log of every task edit |
| `expenses` / `expense_shares` | Who paid, and how much each person owes of it |
| `settlements` | Repayments between members |

Views: `v_task_overview` (assignees, blocked/overdue flags), `v_member_balances` (net position per person).
Money is stored in integer cents; the API accepts and returns normal amounts (e.g. `120.50`).

## Key endpoints

| Method | Path | Notes |
|---|---|---|
| GET / POST | `/api/login-options`, `/api/login`, `/api/logout` | Only these work without signing in |
| GET / POST | `/api/me`, `/api/me/password` | Current user; change password |
| GET/PATCH | `/api/trips/1` | Trip details; edit destination, dates, etc. |
| GET/POST | `/api/trips/1/members` | PATCH/DELETE `/api/members/:id` |
| GET | `/api/trips/1/tasks?status=&assignee=&category=&blocked=true&overdue=true` | Filtered task list |
| POST | `/api/trips/1/tasks` | `{title, due_date, assignees:[ids], depends_on:[ids], ...}` |
| GET/PATCH/DELETE | `/api/tasks/:id` | **Edit any field**, incl. `assignees`, `depends_on`; edits are logged under the signed-in user |
| GET | `/api/tasks/:id/history` | Edit log |
| POST/DELETE | `/api/tasks/:id/dependencies[/:dependsOnId]` | Add/remove one prerequisite |
| GET | `/api/trips/1/timeline` | Tasks by month + due-date conflicts with prerequisites |
| GET/POST | `/api/trips/1/expenses` | Equal split (all or `split_between`) or `custom` shares |
| PATCH/DELETE | `/api/expenses/:id` | |
| GET/POST | `/api/trips/1/settlements` | Record a repayment; DELETE `/api/settlements/:id` to undo |
| GET | `/api/trips/1/balances` | Who owes / is owed, plus fewest payments to settle up |

Rules enforced: no circular dependencies; a task can't be marked `done` while a prerequisite is open; custom expense shares must add up to the total; equal splits distribute leftover cents so totals are exact.

Example edit:

```bash
curl -X PATCH http://localhost:3000/api/tasks/7 -H "Content-Type: application/json" -b cookies.txt -d "{\"due_date\":\"2026-12-20\",\"assignees\":[5,1]}"
```
