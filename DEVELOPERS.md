# DEVELOPERS.md — ezmail

Developer guide for contributing to **ezmail**, a self-hosted webmail client. Companion to `README.md` (user-facing); this file is for people running/editing the code.

## Stack & conventions

Follow the surrounding `ez-*` family style (`ezhost`, `eziarr`):

- **Runtime** — Bun 1.3.14 (`~/.bun/bin/bun`; not on PATH by default — prefix `export PATH="$HOME/.bun/bin:$PATH"`).
- **Backend** — Bun + **Elysia**, `deadslog` logging, `bun:sqlite` for settings, ESM with explicit `.js` extensions.
- **Frontend** — React 19 + **Vite** + **Tailwind 4** + **React Router** + `lucide-react`; SWR for data.
- **Envelope** — APIs return `{ success, message, data }`. Backend routes declare a model on `body`/`query`/`response` for OpenAPI + runtime validation.
- **Formatting** — tabs, double quotes, semicolons, kebab-case filenames.

## Monorepo layout

```
ezmail/
├── backend/          # Elysia API + IMAP/SMTP proxy
│   ├── index.js      # app bootstrap (probes LLM before listen)
│   ├── config.js     # CLIENT_DIR, DATA_DIR, MAIL_SERVER, LLM from env
│   ├── db.js         # bun:sqlite settings store
│   ├── routes/       # auth.route.js, mail.route.js
│   ├── services/     # auth.service.js, mail.service.js, llm.service.js
│   ├── models/       # mail.model.js (Elysia TypeBox schemas)
│   ├── plugins/      # auth.plugin.js, protector.plugin.js (JWT guard)
│   └── .env          # infra + LLM config (git-ignored)
├── frontend/         # React SPA
│   ├── vite.config.js    # dev proxy /api + /openapi → :5000
│   └── src/
│       ├── App.jsx           # routes; /mail wrapped in RequireAuth
│       ├── RequireAuth.jsx   # redirects to /login when unauthenticated
│       ├── pages/            # MailPage, LoginPage
│       ├── components/       # MessageList, MessageView, ComposeView, SummaryColumn, FolderList
│       ├── context/auth.jsx
│       └── utils/apiCall.js  # fetch wrapper (Envelope, AbortController)
├── ecosystem.config.js   # pm2 ("server", PORT 5000)
├── Dockerfile            # multi-stage: frontend build → backend prod image
└── .github/workflows/docker-publish.yml
```

## Local dev

```bash
# one-time
bun install                      # installs backend + frontend deps

# backend
cd backend && cp .env.example .env   # set IMAP/SMTP host + LLM if desired
bun install
NODE_ENV=development bun index.js    # API on :5000, OpenAPI at /openapi

# frontend (separate terminal)
cd frontend
bun install
bun run dev                          # Vite on :5173, proxies /api → :5000
```

Open http://localhost:5173 — sign in with any mailbox + its password. The OpenAPI spec/UI (`/openapi`) is **dev-only** (hidden when `NODE_ENV=production`).

## Backend internals

### Auth model
- **Single-password Roundcube model**: the same mailbox password is used for web login **and** IMAP/SMTP.
- At login the backend authenticates the mailbox + password **directly against the IMAP server**; wrong mailbox **or** password returns the generic `Username or password is incorrect`.
- A JWT (`HttpOnly`, `SameSite=Strict`) carries `{ mailbox, password }`; secret lives in sqlite (`getSetting("jwtSecret")`). No mail credentials are persisted to disk.

### Every mail op mints its own client
Each request builds an `ImapFlow`/`nodemailer` client from the **logged-in user's** credentials. There is no shared/global account.

### key gotchas (backend)
- **Elysia** (v1) path params arrive inside `{ params }`; POST body inside `{ body }`; query inside `{ query }`. Destructure them in route handlers.
- **imapflow** `fetchOne(seq, opts)` uses a sequence number unless `{ uid: true }` is the third arg. `fetch(from:to)` ranges are sequence numbers too — keep `{ uid: false }`, while `msg.uid` is still the real UID.
- **`messageMove`/`messageCopy` do NOT take a source option** — they operate on the currently-open mailbox. You MUST `await client.mailboxOpen(from)` before a MOVE, or it silently matches nothing.
- **`bodyStructure` has no flat `attachments` array** — walk `childNodes` recursively and count nodes with `disposition` matching `/attachment|inline/i`.
- **imapflow** flags are a `Set` — normalize with the `toFlagsArray()` helper. `flags`/`delimiter`/`specialUse` can be `undefined`/`{}` — always null-guard.
- **Response validation rejects `null`** on `t.Optional(...)` fields — Elysia/TypeBox allows `undefined`, not `null`. Return `field || undefined`, never `field || null`, or the route 400s as `Bad request`.
- **UIDVALIDITY is not stable** across moves — never assume UIDs persist; verify moves by subject not original UID.
- **LLM**: `llm.service.js` sends `stream:false` (9router streams NDJSON otherwise); 15s timeout. Probe at boot → `LLM_PRESENT` in sqlite.

## Frontend internals

- **SWR** is the data layer: `useSWR` keyed by folder, `refreshInterval: 10000`, `revalidateOnFocus: false`, paused on background tabs.
- **Pagination**: page-based, 50/page, fixed bottom bar with numbered buttons (server-side slice — no load-more accumulation).
- **HTML email bodies** render inside a **sandboxed iframe** (`sandbox="allow-same-origin"`, `srcDoc`) so email CSS cannot bleed into app styling. Text-only bodies render as markdown via `marked` when they look like markdown (see `looksLikeMarkdown`).
- **Attachments**: compose sends files as base64 `content` (nodemailer attachment array). Viewer downloads via `atob` → Blob → objectURL → `<a download>`.
- **Resizable list column**: drag the separator edge (pattern from `c4lyp5o/rip`) — `listWidth` state, `document` mousemove/up listeners, persisted to `localStorage` key `ezmail_list_width`.
- **RequireAuth** wraps `/mail`; `/login` is public.

## Docker

`Dockerfile` is multi-stage:
1. **builder** — `oven/bun:1.3.14-alpine`, installs frontend deps, `bun run build` → `/app/frontend/dist`.
2. **prod** — `oven/bun:1.3.14-alpine` + `tzdata` + `curl`, installs `pm2`, runs `backend`, copies built client to `/app/frontend/dist`.

The backend's `config.js` sets `CLIENT_DIR = <root>/frontend/dist` and serves it via `@elysiajs/static`. **If you move the build output, keep `frontend/dist` in the image** or the app serves nothing.

`.github/workflows/docker-publish.yml` builds on push to `main` (and manual dispatch), tags `calypso666/ezmail:<version>` + `:latest`, pushes to Docker Hub, then ntfy-notifies. Requires repo secrets: `DOCKER_USERNAME`, `DOCKER_PASSWORD`, `NTFY_URL`.

## Conventions checklist before a PR

- [ ] Backend routes declare request/response models (OpenAPI gate passes in dev).
- [ ] Returns the `{ success, message, data }` envelope.
- [ ] No `null` on optional-typed response fields.
- [ ] Frontend builds clean: `cd frontend && bun run build`.
- [ ] Mail ops that move between folders `mailboxOpen` the source first.