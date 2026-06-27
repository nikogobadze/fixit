# FixIT

A friendly IT-help marketplace. Everyday people post a tech problem; a **manager**
triages it and agrees on a fair price; a qualified **fixer** picks it up; the
**client** confirms it's fixed. An **admin** promotes/demotes staff.

Built to be the *easiest* full stack to run on Windows:

| Layer    | Choice                          | Why |
|----------|---------------------------------|-----|
| Server   | Node + Express                  | tiny, ubiquitous |
| Database | **`node:sqlite`** (built in)    | no native build step — `npm install` just works |
| Auth     | JWT in an httpOnly cookie + bcrypt | stateless, survives restarts |
| Uploads  | multer → `./uploads`            | simple local image storage |
| Frontend | one `index.html` + `app.js`     | extends the original FixIT prototype |

## Run it

```bash
npm install
npm start
```

Then open **http://localhost:3000**. The database (`fixit.db`) and demo
accounts are created automatically on first run.

> Dev tip: `npm run dev` restarts on file changes.

## Demo accounts

| Role    | Email                | Password     |
|---------|----------------------|--------------|
| Admin   | admin@fixit.app      | `admin123`   |
| Manager | manager@fixit.app    | `manager123` |
| Fixer   | alex@fixit.app       | `fixer123`   (hardware, OS, network, security) |
| Fixer   | sam@fixit.app        | `fixer123`   (web, backend, mobile, data) |
| Client  | client@fixit.app     | `client123`  |

You can also register fresh **client** and **fixer** accounts from the UI.

## The workflow

```
Client posts problem (+ photo, + suggested price)
        │  status: submitted
        ▼
Manager reviews ──approve──▶ open ──fixer accepts──▶ assigned
        │                                                │ fixer marks done
        └─counter price──▶ price_countered               ▼
                              │  client accepts──▶ open   work_done
                              └  client declines─▶ declined│ client confirms
                                                           ▼
                                                       completed
```

- **Matching** is by a shared taxonomy: the categories a client picks are the
  same keys a fixer registers as skills, so a fixer only sees jobs they qualify for.
- **First fixer to accept wins** — the claim is an atomic DB update guarded on
  `status='open' AND assigned_fixer_id IS NULL`.
- The **manager's price explanation** is shown to the client in plain language.

## Roles & permissions

- **client** — post problems, respond to price suggestions, confirm completion.
- **fixer** — register qualifications, see/accept matching jobs, mark done.
- **manager** — review queue, approve or counter prices, see all tasks.
- **admin** — everything a manager can do, plus promote/demote
  fixer ⇄ manager ⇄ admin. The first seeded admin is protected and can't be changed.

## Project layout

```
server.js        Express app + all API routes + role guards
db.js            node:sqlite schema, shared taxonomy, seed data
public/
  index.html     UI (landing, auth, post flow, dashboards)
  app.js         SPA logic + API calls
uploads/         problem photos (created at runtime)
```

## Notes for going to production

This is a complete, runnable demo. Before a real launch you'd want:
real email/SMS notifications, payment handling, image storage on a CDN/S3,
HTTPS + a stronger `JWT_SECRET` (set the `JWT_SECRET` env var), rate limiting,
and tests. The data model and flow above are production-shaped and won't need
to change much.
