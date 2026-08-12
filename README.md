# ezmail 💌

A self-hosted webmail client — a Bun + Elysia backend that proxies IMAP/SMTP, and a React 19 + Vite + Tailwind 4 frontend. Part of the `ez-*` family alongside ezhost and eziarr.

## Architecture

Monorepo with two workspaces:

- **`backend/`** — Bun + Elysia. Sits between the browser and your mail server over IMAP (993) / SMTP (587). Mail flow: `imapflow` (reads) + `nodemailer` (sends) + `mailparser` (MIME/HTML body parsing).
- **`frontend/`** — React 19 + Vite + Tailwind 4 + React Router. Vite dev server proxies `/api` → backend.

```
ezmail/
├── backend/     # Elysia API, IMAP/SMTP services, JWT auth
├── frontend/    # React SPA
├── ecosystem.config.js   # pm2 ("server", PORT 5000)
└── logs/        # ezmail.log (deadslog)
```

## Multi-user login

ezmail is **not anchored to one account**. Any user logs in with their own mailbox + password:

- The backend authenticates the mailbox + password **directly against the IMAP server** at login.
- Wrong mailbox **or** wrong password returns a generic `Username or password is incorrect` (no leaking which one failed).
- On success a JWT (HttpOnly + SameSite=Strict cookie) carries the mailbox identity.
- Every mail operation (folders, messages, send, flags) builds its IMAP/SMTP client from the **logged-in user's** credentials — no global account.

## Configuration

IMAP/SMTP host/port/secure come **only** from `backend/.env` (infra config, never user-editable).

```env
IMAP_HOST=mail.example.com
IMAP_PORT=993
IMAP_SECURE=true
SMTP_HOST=mail.example.com
SMTP_PORT=587
SMTP_SECURE=false
```

The DB stores only the JWT signing secret — no mail credentials are persisted.

## LLM email summarization (optional)

ezmail can summarize emails with a local LLM (ollama or any OpenAI-compatible server):

1. Set `LLM_SERVER` (+ optional `LLM_SERVER_APIKEY`) in `backend/.env`.
2. On boot the backend probes the server (`/v1/models` or `/api/tags`). If reachable, it stores `LLM_PRESENT=true` in sqlite.
3. When `LLM_PRESENT` is true, opening an email shows a third, slidable **Summary** column that summarizes the message text via `POST /mail/summarize`. Switching messages cancels the in-flight request (AbortController).

Presence is checked at boot only — if the server is down at boot, summarization stays off until restart.

**Currently wired to 9router** (`LLM_SERVER=http://localhost:20128`, `LLM_MODEL=ZeroCost`) for testing. ZeroCost routes to a reasoning model — must send `stream:false` or 9router streams NDJSON and the non-stream JSON parse fails.

## Bulk selection & actions (Google-style)

- Checkboxes on each message; selection persists across opening a message (stored in parent state).
- When messages are selected, an action bar appears beside the folder name: **mark as read**, **move to** (popup listing folders), and **delete** (move to Trash).

## Getting started

```bash
# backend
cd backend
bun install
cp .env.example .env   # set your IMAP/SMTP host
NODE_ENV=development bun index.js   # PORT 5000

# frontend (separate terminal)
cd frontend
bun install
bun run dev            # Vite on 5173, /api proxied to 5000
```

Open http://localhost:5173 and sign in with any mailbox + its password.

## Production

```bash
pm2 start ecosystem.config.js   # runs backend on PORT 5000
```

Set `NODE_ENV` (production hides the `/openapi` spec and error details). The OpenAPI UI is dev-only.

## Security notes

- The JWT carries the mailbox password (needed for the IMAP/SMTP proxy). It's HttpOnly + SameSite=Strict. For stronger hardening, swap to a short-lived token or a server-side session store — recommended before public exposure.
- Mail credentials are never written to disk in the DB.

## Key gotchas

- **Elysia path params arrive as `{ params: { ... } }`**, not top-level — destructure `params` in route handlers (`getMessage`, `listMessages`).
- **imapflow** `fetchOne` first arg is a sequence number unless `{ uid: true }` is passed as the third arg.
- **imapflow** `flags`/`delimiter`/`specialUse` can be `undefined`/`{}` — always normalize with `Array.isArray` / null-guards.
- **mailparser** handles multipart, quoted-printable/base64, and attachments — prefer it over hand-rolling MIME walking.
- **imapflow errors** are rich objects — log `cmd`/`resp`/`status` (see `logImapError` in `mail.service.js`), not just `err.message`.