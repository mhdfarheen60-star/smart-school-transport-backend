# Smart School Transportation Management System

Full-stack web application that connects **students**, **drivers** and **school administrators** to manage
transport requests, bus assignments, routes, daily pickup/drop-off attendance, notifications, complaints and
vehicle problem reports.

**Developer:** Muhammed Farheen P K

| Layer    | Stack |
|----------|-------|
| Frontend | React 18, Vite, TypeScript, Tailwind CSS, Framer Motion, Lucide, React Router, Axios, Recharts |
| Backend  | Node.js, Express, TypeScript, JWT, bcrypt-hashed passwords (`bcryptjs`), Zod validation |
| Database | MongoDB via Mongoose (local, Compass or Atlas) |

## Project structure

```
smart-school-transport/
├── backend/    Express REST API (models, controllers, routes, middleware, services, validators)
├── frontend/   React app (layouts, pages/{auth,student,driver,admin}, components, services, context)
├── package.json  convenience scripts
└── README.md
```

## Prerequisites

* Node.js 18+
* A MongoDB instance: local `mongod`, or a MongoDB Atlas connection string

## Setup

```bash
# 1. install dependencies
npm run install:all            # or: npm install in backend/ and frontend/

# 2. configure the backend
cp backend/.env.example backend/.env
#    edit backend/.env: set MONGO_URI, JWT_SECRET (long random string),
#    SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD

# 3. configure the frontend
cp frontend/.env.example frontend/.env     # VITE_API_URL=http://localhost:5000/api

# 4. create the first administrator (add --demo for sample drivers/buses/routes)
npm run seed --prefix backend -- --demo
```

### Environment variables

`backend/.env`

| Name | Purpose |
|------|---------|
| `PORT` | API port (default 5000) |
| `MONGO_URI` | MongoDB connection string (local or Atlas) |
| `JWT_SECRET` | Secret for signing tokens (min 32 chars; use a long random value) |
| `JWT_EXPIRES_IN` | Token lifetime (default `1d`) |
| `JWT_ISSUER`, `JWT_AUDIENCE` | Optional token claims (defaults provided; keep them stable) |
| `CLIENT_URL` | Allowed CORS origin(s), comma separated (default `http://localhost:5173`); HTTPS required in production |
| `NODE_ENV` | `development` / `production` |
| `TRUST_PROXY` | `false` by default. Set to the trusted hop count or `loopback` only behind a reverse proxy you control |
| `AUTH_RATE_LIMIT` | Auth attempts per IP per 15 minutes (default `30`) |
| `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD`, `SEED_DEMO_PASSWORD` | Used only by `npm run seed` |

`frontend/.env` — `VITE_API_URL=http://localhost:5000/api` and the optional
`VITE_GOOGLE_MAPS_API_KEY` (a browser key, public by design).

> `.env` files are git-ignored. Never commit real credentials or paste them into issue trackers.
> Generate `JWT_SECRET` with `node -e "console.log(require('crypto').randomBytes(64).toString('base64url'))"`.

## Running

```bash
# terminal 1 — API on http://localhost:5000/api
npm run dev --prefix backend

# terminal 2 — UI on http://localhost:5173
npm run dev --prefix frontend
```

Production build: `npm run build` (compiles `backend/dist` and `frontend/dist`); start the API with
`npm start --prefix backend`.

### Logging in

| Role | URL | Account |
|------|-----|---------|
| Student | `/login`, `/register` | self-registration |
| Driver | `/driver/login` | created by an admin (Admin → Drivers) |
| Admin | `/admin/login` | created by `npm run seed` |

With `--demo`, two drivers (`ravi.driver@school.local`, `suresh.driver@school.local`), two buses and two routes
are created; their password is `SEED_DEMO_PASSWORD` or, if unset, `SEED_ADMIN_PASSWORD`.

## Google Maps location selection

Students pick exact pickup / drop-off points on a Google map; drivers and admins see them on maps and can open them in Google Maps.

1. In Google Cloud, create a **browser** API key and enable only: **Maps JavaScript API**, **Places API (New)** and **Geocoding API**.
2. Restrict the key to your site domains (HTTP referrers) and to those three APIs.
3. Put it in `frontend/.env` as `VITE_GOOGLE_MAPS_API_KEY=your_google_maps_api_key` and restart `npm run dev`.
   This is a browser key and is visible to anyone who loads the app, so the restrictions above are the protection.
   Never put a server/API key in a `VITE_` variable, and rotate the key if it is ever exposed.

Without a key the app still runs: the picker shows a configuration notice and lets students type the address and
coordinates manually; maps are replaced by a coordinate list plus working Google Maps links.

How it works

* `POST /api/transport-requests` takes `pickupLocation` / `dropLocation` as `{ address, latitude, longitude, placeId? }`
  (validated: address required, latitude -90..90, longitude -180..180). The address is stored in the existing
  `pickupLocation` / `dropLocation` string fields and the coordinates in new `pickupGeo` / `dropGeo` fields, so older
  requests keep working. Responses add `pickup` / `drop` objects. `PATCH /api/transport-requests/:id` edits a pending request.
* Changes after approval go through `/api/location-changes` (student submit, admin approve/reject). Nothing live changes
  until approval; on approval the request's location is updated, the student and the assigned driver are notified, and
  the previous/proposed values, requester, reviewer and timestamps are kept as history.
* Drivers receive student locations only for their own active assignment (`GET /api/assignments/mine`); every check is
  enforced on the backend.

## Feature overview

**Student** — registration, transport request, assigned bus/driver/route/pickup time, notifications,
pickup/drop attendance history, complaints, profile.

**Driver** — dashboard, assigned students, daily trip with pickup (picked up / absent / not available) and
drop-off marking, stop-by-stop route, vehicle problem reporting (breakdown, traffic delay, accident,
mechanical issue), notifications, profile.

**Admin** — dashboard + charts, CRUD for students/drivers/vehicles/routes, request approval with bus assignment,
bus/driver/route assignments with capacity and conflict validation, trips, attendance monitoring and correction,
complaint and vehicle-problem management (including marking a vehicle unavailable), broadcast notifications,
reports with CSV/PDF export, audit log.

### Business rules enforced by the API

* Duplicate student IDs, emails, licence numbers and vehicle registration numbers are rejected (unique indexes + checks).
* A vehicle or driver can have only one active assignment (partial unique indexes).
* Vehicle capacity is validated whenever a student is added or capacity is lowered; unavailable vehicles cannot be assigned.
* Trips and attendance store their own vehicle/driver/route references, so ending or changing an assignment
  never rewrites history. Students/drivers/vehicles/routes with history are deactivated or refuse deletion instead of being removed.
* A student cannot be dropped before being picked up; closed trips cannot be edited by drivers.
* Every list endpoint supports `page`, `limit`, `search`, `sort` (`field` / `-field`) and entity filters.

### Public site design and asset credits

The public homepage is an editorial, photography-led page (`/`) with a matching light
operational theme for the signed-in app. Marketing copy and photo alt text live in
`frontend/src/data/marketingContent.ts`, and marketing-only styles are scoped to
`.marketing-site` in `frontend/src/styles/marketing.css`.

Photographs are reused from Wikimedia Commons under CC BY / CC BY-SA. The exact
source file, author, licence URL, adaptations and attribution requirements for every
image are recorded in `frontend/public/images/marketing/ASSET-SOURCES.md` (served at
`/images/marketing/ASSET-SOURCES.md` and linked from the site footer). If you replace
or add a photo, update that file in the same change.

The homepage deliberately does not claim features the API does not provide: there is
no live GPS bus tracking, no SMS/WhatsApp delivery, no online payments and no parent
self-service sign-in. Keep new copy consistent with `backend/src/routes/index.ts`.

## API summary

All responses: `{ success, data, meta? }` or `{ success: false, message, details? }`. Send `Authorization: Bearer <token>`.

| Prefix | Notes |
|--------|-------|
| `/api/auth` | `POST register`, `POST login`, `GET me`, `PATCH profile`, `POST change-password` |
| `/api/students`, `/drivers`, `/vehicles`, `/routes`, `/parents` | admin CRUD (`GET /routes/options` for any signed-in user) |
| `/api/transport-requests` | student create/list/edit/cancel; admin list, `POST :id/assign`, `PATCH :id/review` |
| `/api/assignments` | admin CRUD, `POST :id/end`, `POST :id/riders`, `DELETE :id/riders/:studentId`; `GET mine` (student/driver) |
| `/api/trips` | driver `POST today`; admin create/list; `PATCH :id/status` |
| `/api/attendance` | role-scoped list; driver `PATCH :id/pickup`, `PATCH :id/drop`; admin `PATCH :id` |
| `/api/notifications` | own list, mark read/all read, delete; admin broadcast `POST` |
| `/api/complaints` | student/driver create, role-scoped list, admin `PATCH :id` |
| `/api/vehicle-problems` | driver create/list, admin list + `PATCH :id` |
| `/api/reports/:type` | admin; `?from&to&format=json\|csv\|pdf`; types: students, drivers, vehicles, attendance, requests, complaints, vehicle-problems |
| `/api/dashboard` | `admin`, `student`, `driver`, `audit-logs` |

## Testing

The suite writes disposable records. Use a dedicated database and never point it at production:

```bash
# backend/.env (or process env): MONGO_URI=mongodb://127.0.0.1:27017/sst_security_test
npm run seed --prefix backend
API_URL=http://localhost:5000/api npm run test:e2e --prefix backend
```

The script exercises registration/login, role permissions, CRUD, all workflows (request → approval →
assignment → pickup/drop → problem report → complaint → report export → request lifecycle), capacity and conflict
rules, token revocation, and error handling against the real API and database.

If you run the suite repeatedly within 15 minutes, raise `AUTH_RATE_LIMIT` on the test server (for example
`AUTH_RATE_LIMIT=200`). The production default stays at 30.

## Security

Implemented controls:

* Passwords are hashed with bcrypt cost 12; lower-cost hashes are upgraded on successful login. Unknown accounts
  are compared against a dummy hash so response timing does not reveal whether an email or student ID exists.
* JWTs use HS256 with an explicit issuer/audience and a default 1-day lifetime. Every request re-checks the user,
  active status and `tokenVersion`, so changing a password or deactivating an account revokes old tokens.
* Role-based authorization on every route; students and drivers only receive their own records. Driver access to
  student locations is limited to their active assignment.
* Zod validation plus a request sanitizer that rejects MongoDB operators (`$...`), dotted/bracketed keys and
  prototype-pollution keys in JSON bodies and query strings. JSON bodies are limited to 100 kB and the query parser
  is set to `simple`.
* Helmet security headers (CSP, HSTS in production, frame/object denial, no-referrer, Permissions-Policy),
  `Cache-Control: no-store`, `X-Powered-By` disabled, and HTML escaping in JSON responses.
  `frontend/public/_headers` adds frame/MIME/referrer/Permissions-Policy/COOP/HSTS headers on static hosts that
  support the Netlify/Cloudflare `_headers` format; configure equivalents on other hosts.
* CORS uses an explicit origin allow-list (`CLIENT_URL`) with no wildcard; production origins must be HTTPS.
* Rate limits: 600 requests/15 min per IP for the API, and 30 auth attempts/15 min per IP (configurable with
  `AUTH_RATE_LIMIT`). Clients receive standard rate-limit headers and `429` responses.
* CSV exports neutralise spreadsheet-formula injection.

Deployment checklist:

1. Set `NODE_ENV=production` and serve both the API and frontend over HTTPS only. Set `CLIENT_URL` to the exact
   HTTPS frontend origin(s).
2. Keep `TRUST_PROXY=false` unless the API is behind a reverse proxy you control, then set it to the hop count or
   `loopback`. Never set it to `true` on a directly reachable server: clients could spoof `X-Forwarded-For` and
   bypass IP-based limits.
3. Generate a unique `JWT_SECRET` of at least 32 random characters per environment. Rotating it signs everyone out.
4. Use a MongoDB user limited to `readWrite` on this application's database only. Keep the Atlas IP access list
   narrow, leave TLS enabled, and rotate database credentials if they have ever been shared or committed.
5. Store `.env` files and credentials outside the repository (for example in a secrets manager). The Git history
   contains only placeholders, but future commits must never add real values.
6. Treat `VITE_GOOGLE_MAPS_API_KEY` as public. Restrict it to your production HTTP referrers and only the Maps
   JavaScript, Places and Geocoding APIs; rotate it if it has been exposed.
7. Run `npm audit` in `backend/` and `frontend/` as part of deployment, and commit the lockfiles.
8. Change or remove any seeded administrator account with a weak password before going live.

Residual risks:

* The frontend stores the JWT in `localStorage`, so a successful XSS could steal it. React escapes rendered text,
  the app does not use raw HTML injection, API JSON is HTML-escaped, and the static headers restrict framing and
  MIME sniffing. Moving to short-lived tokens in `HttpOnly`, `SameSite` cookies with CSRF protection is the
  stronger long-term design.
* A browser Google Maps key cannot be hidden on the client; its security depends on the referrer/API restrictions
  configured in Google Cloud.
* Audit logs and notifications live in MongoDB. Protect database backups and restrict database access accordingly.
