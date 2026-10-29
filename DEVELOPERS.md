# DEVELOPERS.md — ezmail

Architecture and internals for people editing the code. Setup and workflow are covered in [CONTRIBUTING.md](CONTRIBUTING.md); user-facing documentation is in [README.md](README.md).

## Stack & conventions

Follow the surrounding `ez-*` family style (`ezhost`, `eziarr`):

- **Runtime:** Bun 1.4.3, the same version as CI and Docker. If `bun` isn't on PATH, run `export PATH="$HOME/.bun/bin:$PATH"`.
- **Backend:** Bun + **Elysia**, `imapflow` (IMAP), `nodemailer` (SMTP), `mailparser` (MIME), `bun:sqlite`, `deadslog` logging. ESM with explicit `.js` extensions.
- **Frontend:** React 19 + **Vite 8** + **Tailwind 4** + **react-router 8** (import from `"react-router"`, not `react-router-dom`) + SWR + `lucide-react`.
- **Envelope:** APIs return `{ success, message, data }`. Routes declare `body`/`query`/`params`/`response` models for OpenAPI and runtime validation.
- **Style:** tabs, double quotes, semicolons, kebab-case backend filenames, PascalCase React components. Lint with Biome (`biome.json`).

## Layout

```
ezmail/
├── backend/
│   ├── index.js          # bootstrap: LLM probe, plugins, routes, listen (skipped when NODE_ENV=test)
│   ├── config.js         # paths, MAIL_SERVER, DB_PATH, LLM from env
│   ├── db.js             # bun:sqlite: settings, sessions, totp, profiles
│   ├── logger.js         # deadslog → logs/ezmail.log
│   ├── routes/           # auth, mail, filter, profile, health
│   ├── services/
│   │   ├── auth.service.js        # login, TOTP login/enrol, me, logout
│   │   ├── session.service.js     # server-side session store
│   │   ├── crypto.service.js      # AES-GCM for stored passwords
│   │   ├── totp.service.js        # TOTP secrets + verification
│   │   ├── rate-limit.service.js  # in-memory login/code limiters
│   │   ├── mail.service.js        # IMAP/SMTP operations
│   │   ├── push.service.js        # IMAP IDLE → SSE fan-out
│   │   ├── profile.service.js     # display name
│   │   ├── filter.service.js      # Dovecot Sieve filters
│   │   └── llm.service.js         # summaries (Ollama / OpenAI-compatible)
│   ├── models/           # Elysia TypeBox schemas
│   ├── plugins/          # auth.plugin.js (getUser, SESSION_COOKIE), protector
│   └── tests/            # bun test; helpers/ has fake IMAP/SMTP
├── frontend/
│   ├── vite.config.js    # dev proxy /api + /openapi → :5000; vitest config
│   └── src/
│       ├── App.jsx, RequireAuth.jsx
│       ├── pages/        # MailPage (state hub, shortcuts, SSE), LoginPage
│       ├── components/   # MessageList, MessageView, ComposeView, SummaryColumn, FolderList, SettingsModal + tabs
│       ├── context/      # auth, theme
│       ├── utils/        # apiCall, reply (buildDraft), folders (specialFolder), keyboard
│       └── test/         # vitest setup, mockApi, fake EventSource
├── .github/workflows/    # test.yml (CI), docker-publish.yml
├── Dockerfile            # frontend build → backend prod image (pm2)
└── ecosystem.config.js   # pm2 app "server", PORT 5000
```

## Backend internals

### Auth and sessions
- Single-password model: the mailbox password is used for both web login and IMAP/SMTP. Login is verified with a real IMAP connect, and failures return the generic `Username or password is incorrect`.
- On success, `createSession` stores `{ mailbox, encrypted password, expiry }` in the `sessions` table. The row is keyed by the **SHA-256 of a random 32-byte token**, and the token itself goes in the `ezmail_session` cookie (HttpOnly, SameSite=Strict). `getUser(cookie)` resolves it, and logout deletes the row.
- The encryption key comes from `TOTP_ENC_KEY`, then `JWT_SECRET`, then a generated `jwtSecret` setting. Changing it invalidates every session and TOTP enrolment.
- **TOTP (passwordless):** `POST /login` returns `{ totp: true }` for enrolled mailboxes, and the client then calls `/login/code`. Pending enrolments are separate from active credentials. `POST /totp/recover` requires a valid code and current IMAP password to refresh the encrypted password.
- **Rate limits** (`rate-limit.service.js`): 10 password attempts, 5 code/recovery attempts and 30 discovery attempts per mailbox per 15 minutes, held in memory. In-flight IMAP checks reserve slots. Excess attempts get `429` with `Retry-After`; limits reset on restart and are not shared across instances.

### Mail
- Every request builds its own `ImapFlow`/nodemailer client from the session's credentials (`buildImapClient`). There is no shared account.
- **Special folders** are resolved by RFC 6154 special-use flag first, then by name (`findSpecialFolder`, `TRASH_NAMES`, `SENT_NAMES`). The frontend mirrors this in `utils/folders.js`.
- **Listing** fetches the requested page in sequence/UID arrival order. Unread counts for all folders come from `LIST-STATUS`.
- **Attachments:** body-structure traversal defines indexes for display, download and forwarding. Downloads and forwarding fetch individual parts, with a 25 MiB limit. The message view fetches headers and displayable text parts, capped at 8 MiB total. The attachment endpoint uses `no-store`, `Content-Disposition: attachment`, `nosniff` and a sandbox CSP. `cid:` links use that endpoint.
- **Send:** MIME is built before SMTP submission and the same bytes are appended to Sent. `savedToSent` reports filing success; `sentSavingDisabled` distinguishes `SAVE_SENT=false` from a failure after delivery.
- **Moves/deletes** return `movedUids` (UIDPLUS) so the client can undo.
- **Threads:** `GET /mail/message/:folder/:uid/thread` searches INBOX and Sent by `Message-ID` / `References`. A matching subject alone never links messages.
- **Filters:** ManageSieve uses the signed-in mailbox credentials and TLS. Only scripts matching ezmail's template are editable. Scripts are checked before upload, the previous managed version is retained, and custom active scripts are read-only. See the README for configuration and migration.
- **IMAP filter fallback:** explicit per-mailbox opt-in stores rules and an encrypted password in `fallback_filters`. A process-local scheduler polls enabled accounts; SQLite leases coordinate workers sharing a database. UIDVALIDITY and a per-message UID cursor prevent processing old mail on first enable and permit retries after failures. A changed UIDVALIDITY skips existing messages and raises a status warning. Disabling or deleting rules removes the stored password. Tests use fake IMAP; verify delivery and moves against a real server.

### Live updates
- `push.service.js` keeps **one IDLE connection per mailbox**, shared by all of that user's SSE subscribers, and closes it when the last subscriber leaves. `GET /api/v1/mail/events` streams events, with a 20s heartbeat.
- `index.js` listens with `idleTimeout: 120` and a 32 MiB request-body limit. Bun's default idle timeout of 30s would cut off slow LLM summaries.

### Gotchas
- **Elysia** path params arrive inside `{ params }`, the body in `{ body }`, the query in `{ query }`.
- **Elysia strips response fields not declared in the model.** Add new fields to `models/` or they silently vanish.
- **Response validation rejects `null`** on `t.Optional(...)`. Return `field || undefined`.
- **imapflow** `fetchOne(seq, opts)` takes a sequence number unless `{ uid: true }` is the third argument. `fetch(from:to)` ranges are sequence numbers; `msg.uid` is still the real UID.
- **`messageMove`/`messageCopy` act on the open mailbox.** `await client.mailboxOpen(from)` first, or nothing matches.
- **`bodyStructure`** has no flat attachments list; walk `childNodes`.
- **imapflow** flags are a `Set` (use `toFlagsArray()`). `specialUse`, `delimiter` and `flags` may be `undefined`.
- **imapflow errors** are rich objects; log via `logImapError` (`cmd`/`resp`/`status`).
- **UIDs are not stable across moves.** Use `movedUids`, never the original UID.
- **LLM:** `llm.service.js` sends `stream:false` and auto-detects Ollama vs OpenAI-compatible endpoints.

## Frontend internals

- **SWR** is the data layer. INBOX refreshes every 10s, or 60s while the SSE stream is live. Polling pauses in background tabs, and `revalidateOnFocus` is off.
- **MailPage** owns view state, selection, global shortcuts, the undo toast, the EventSource and notifications (`ezmail_notify` in localStorage).
- **MessageList** handles list navigation keys, Shift range selection, and swipe (`useSwipe`; `swipeAction` comes from MailPage).
- **MessageView:** HTML bodies render in a sandboxed `srcDoc` iframe wrapped by `emailDoc`, with a `<meta>` CSP from `emailCsp` that blocks remote content until the user opts in. The frame auto-sizes to its content. Text bodies that look like Markdown render through `marked` + DOMPurify.
- **ComposeView:** prefilled by `utils/reply.js` `buildDraft`. Auto-saves to `ezmail_draft:<mailbox>` and flushes on exit; uploaded files aren't saved. Old forwarding references without the current index version are removed with a warning.
- **Shortcuts** are ignored while typing (`utils/keyboard.js` `isTypingTarget`).
- **Resizable list column** width is persisted in `ezmail_list_width`.

## Tests

- **Backend:** `bun test` in `backend/`. `bunfig.toml` preloads `tests/setup.js`, which mocks `imapflow` and `nodemailer` with `tests/helpers/fake-imap.js` / `fake-smtp.js` and points `DB_PATH` at a temporary file. `tests/helpers/http.js` calls the Elysia app in-process. Filter operations use a service-level fake; real ManageSieve and MIME workflows need manual server checks.
- **Frontend:** Vitest + happy-dom + Testing Library. `src/test/fetch.js` `mockApi` stubs `/api` responses, and `src/test/event-source.js` fakes SSE. happy-dom can't enforce CSP or real Notifications, so check those in a browser.

## Docker & CI

- `Dockerfile`: stage 1 builds the frontend (`oven/bun:1.4.3-alpine`, frozen lockfile). Stage 2 installs backend production deps, copies the backend and `frontend/dist`, and runs `bun start` (pm2-runtime). `config.js` serves `frontend/dist`, so keep that path. `.dockerignore` excludes tests.
- `.github/workflows/test.yml` runs on every push and PR: frozen installs, `biome lint`, backend tests, frontend tests, build.
- `.github/workflows/docker-publish.yml` runs on pushes to `master`. It tags `calypso666/ezmail:<package.json version>` and `:latest`, then sends an ntfy notification. It needs the secrets `DOCKER_USERNAME`, `DOCKER_PASSWORD` and `NTFY_URL`.
