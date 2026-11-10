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
- **Rate limits** (`rate-limit.service.js`): per 15 minutes, 10 password attempts and 30 discovery attempts per client address + mailbox (address from `X-Forwarded-For` only when `TRUST_PROXY=true`), a mailbox-wide ceiling of 100 failed passwords, and 5 code/recovery attempts per mailbox, held in memory. In-flight IMAP checks reserve slots. Excess attempts get `429` with `Retry-After`; limits reset on restart and are not shared across instances.

### Mail
- Requests use an `ImapFlow` client built from the session's credentials (`buildImapClient`); there is no shared account. `imap-pool.service.js` keeps up to three idle connections per mailbox for `IMAP_POOL_IDLE_MS` (30 s) and hands each to one caller at a time; a connection whose command threw is discarded, so release mailbox locks in `finally`. Connects time out after 15 s and idle sockets after 60 s (`REQUEST_TIMEOUTS`). The IDLE watcher and filter worker keep their own connections. Tests set `IMAP_POOL_IDLE_MS=0`; `tests/imap-pool.test.js` opts in.
- **Special folders** are resolved by RFC 6154 special-use flag first, then by name (`findSpecialFolder`, `TRASH_NAMES`, `SENT_NAMES`). The frontend mirrors this in `utils/folders.js`.
- **Listing** fetches the requested page in sequence/UID arrival order. Unread counts for all folders come from `LIST-STATUS`.
- **Attachments:** body-structure traversal defines indexes for display, download and forwarding. Downloads and forwarding fetch individual parts, with a 25 MiB limit. The message view fetches headers and displayable text parts, capped at 8 MiB total. The attachment endpoint uses `no-store`, `Content-Disposition: attachment`, `nosniff` and a sandbox CSP. `cid:` links use that endpoint.
- **Send:** MIME is built before SMTP submission and the same bytes are appended to Sent. `savedToSent` reports filing success; `sentSavingDisabled` distinguishes `SAVE_SENT=false` from a failure after delivery.
- **Folders:** `POST /mail/folders` creates a top-level folder (letters, digits, spaces, dashes, underscores — the set Sieve filters accept); 409 if it exists in any case. Deleting with no Trash folder creates one. `POST /mail/folders/rename` renames in place and `POST /mail/folders/delete` removes only empty folders without children (409 otherwise); INBOX and special-use folders get 400. Filter rules are not rewritten, so both return `filtersAffected`.
- **Search:** `search-query.js` turns the search box into an imapflow query (`from:`, `to:`, `subject:`, `is:`, `before:`/`after:`; dates are UTC days). Anything unrecognised stays plain text, and `has:attachment` is not supported.
- **Snippets:** `GET /mail/messages/:folder?snippets=1` adds `snippet` (up to 140 characters) per row from one partial body fetch per distinct part, decoded by `snippet.js`. It is best effort and never fails the list.
- **Drafts:** `POST /mail/drafts` appends the draft (Bcc kept) to the Drafts folder flagged `\Draft \Seen`, creating the folder if missing. With `replaces`, the old copy is removed only after the new one is stored and only if flagged `\Draft`; `replaced` reports it. `uid` comes from UIDPLUS `APPENDUID`, else a best-effort Message-ID lookup; if neither yields a UID the response has no `uid`, and the old copy is kept (`replaced: false`) when the new one's attachments were copied from it, so a duplicate may remain. `POST /mail/drafts/discard` is idempotent (`removed: false` for an unknown UID).
- **Profile:** `GET`/`PUT /profile` hold the display name and a plain-text signature (2000 characters after newline normalisation); `PUT` fields are optional.
- **Inline attachments:** `?inline=1` on the attachment endpoint serves PNG, JPEG, GIF and WebP with `Content-Disposition: inline`; other types ignore it.
- **TOTP codes** are single-use: the last consumed 30 s step is stored per mailbox (`totp:last-step:*`) and login or recovery must present a newer one.
- **Moves/deletes** return `movedUids` (UIDPLUS) so the client can undo. `POST /mail/delete` moves to Trash (creating it if missing) and returns `trash`; inside Trash it expunges permanently.
- **Threads:** `GET /mail/message/:folder/:uid/thread` searches INBOX, the open folder, Sent and Archive by `Message-ID` / `References`. A matching subject alone never links messages.
- **Filters:** ManageSieve uses the signed-in mailbox credentials and TLS. Only scripts matching ezmail's template are editable. Scripts are checked before upload, the previous managed version is retained, and custom active scripts are read-only. See the README for configuration and migration.
- **IMAP filter fallback:** explicit per-mailbox opt-in stores rules and an encrypted password in `fallback_filters`. A process-local scheduler polls enabled accounts; SQLite leases coordinate workers sharing a database. UIDVALIDITY and a per-message UID cursor prevent processing old mail on first enable and permit retries after failures. A changed UIDVALIDITY skips existing messages and raises a status warning. Each run that completes without error stores `last_success` (returned as `lastCheck`); it is cleared when the fallback is re-enabled. Disabling or deleting rules removes the stored password. Tests use fake IMAP; verify delivery and moves against a real server.
- **Filters UI:** `FiltersTab` tracks a saved baseline and reports unsaved edits to `SettingsModal` through `onDirtyChange`; the modal then confirms before closing or switching sections. `ConfirmPanel` handles Escape and Tab itself so the host dialog's handlers don't also fire. The "Test your rules" preview is client-side (`utils/filterRules.js`) and mirrors the server matcher in `filter-match.service.js`; keep the two in step.

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
- **MessageView:** HTML bodies render in a sandboxed `srcDoc` iframe wrapped by `emailDoc`, with a `<meta>` CSP from `emailCsp` that blocks remote content until the user opts in. The frame auto-sizes to its content. Text bodies that look like Markdown render through `marked` + DOMPurify into the same sandboxed frame.
- **ComposeView:** prefilled by `utils/reply.js` `buildDraft`. Auto-saves to `ezmail_draft:<mailbox>` and flushes on exit; uploaded files aren't saved locally. Old forwarding references without the current index version are removed with a warning. The server draft (`POST /mail/drafts`) is saved on close and at most every `DRAFT_SAVE_MS` (30 s) while editing. The periodic save is skipped (close-only) when `autoSaveSize` reaches 2 MiB: uploads (base64) plus attachments already in the draft that the save copies again. After a save, uploads become forwarded references into the new copy (no re-upload) unless the total exceeds `ATTACHMENT_BUDGET` (24 MiB, uploads and references together; the server caps forwarding at 25 MiB), in which case they stay uploads. Closing with files not yet stored shows "Saving draft…" until the save settles and asks before leaving if it failed; closing with none returns at once, and a failed save then shows a toast from MailPage (`onDraftSaveFailed`). "Edit draft" (`resumeDraft`) restores to/cc/bcc/subject/text in plain-text mode (the Markdown setting isn't stored) with attachments as references; inline (`related`) images aren't carried over. Discard confirms before deleting a copy from Drafts, and Send or Discard removes the server copy (a save still in flight is deleted when it lands). Without a UID from the server (no UIDPLUS and no Message-ID match) periodic saves stop and one more save is allowed, on close. Send waits `UNDO_SEND_MS` (5 s) so it can be undone; `onBusyChange` blocks navigation meanwhile and closing the tab sends nothing. The signature comes from `/profile`.
- **Browser storage:** `ezmail_notify`, `ezmail_previews` (message previews, on unless `off`), `ezmail_list_width`, `ezmail_theme`, `ezmail_draft:<mailbox>`, and `ezmail_contacts:<mailbox>` (recipient autocomplete, up to 200 entries, removed on logout by `utils/contacts.js` `clearContacts`). Server drafts and the signature are the only new server-side state; they live in the mailbox's Drafts folder and the `settings` table.
- **Server drafts, known limitations:**
  - Opening a new composer directly from an open composer (sidebar Compose) can race the previous composer's close-time save (`ComposeView` wrapper + `closingSaves.js`): the new one may hold references to a draft copy that was just replaced, so its save or send fails with a forwarded-attachment error, or a duplicate draft is left. Nothing is lost.
  - While a close waits for the draft save ("Saving draft…") the composer stays interactive; pressing Send then can be cancelled silently when the composer closes.
  - The waits on an in-flight draft save (before Send, on close, and "Saving your previous draft…") have no timeout; a stalled request holds them until it fails. Reloading restores the local draft.
  - Closing the browser tab does not save to the server, only the local draft (without uploaded files).
  - A composer holding only an attachment (no recipients, subject or body) is not saved to the server.
- **Drag to folder:** rows drag only on fine-pointer devices (`MessageList`); `FolderList` accepts the `DRAG_MIME` payload and MailPage `dropMessages` moves it (Trash goes via delete).
- **Shortcuts** are ignored while typing (`utils/keyboard.js` `isTypingTarget`).
- **Resizable list column** width is persisted in `ezmail_list_width`.

## TODO / deferred

- **415 guard (deferred by decision):** state-changing routes accept any content type; defence relies on the `SameSite=Strict` session cookie. Idea: a global `onBeforeHandle` returning 415 unless `application/json` (allowlisting multipart and body-less routes), optionally with an `Origin` / `Sec-Fetch-Site` check. This would be an API change; record it in `CHANGELOG.md` when done.
- **TOTP lockout / passwordless login:** one client can lock a mailbox's code attempts for 15 minutes (5 per 15 minutes per mailbox). Needs a redesign (password-first step or a trusted-device cookie). Per-client throttling was tried and reverted because it made guessing easier.
- **Silent IMAP failures:** `saveToSent` and flag changes (`changeFlags`) still report success when the IMAP operation silently fails.
- **Client state after logout:** local drafts stay in the browser after logout, and the contacts cache is cleared only on explicit logout, not on session expiry.
- **Email iframe CSP:** could add `base-uri` and `form-action` restrictions.
- **Search:** `after:` / `before:` dates are UTC days, not local time; `has:attachment` is unsupported.
- **PDF preview:** a safe preview is still open. Inline PDFs were removed because they would run on the app origin.

## Tests

- **Backend:** `bun test` in `backend/`. `bunfig.toml` preloads `tests/setup.js`, which mocks `imapflow` and `nodemailer` with `tests/helpers/fake-imap.js` / `fake-smtp.js` and points `DB_PATH` at a temporary file. `tests/helpers/http.js` calls the Elysia app in-process. Filter operations use a service-level fake; real ManageSieve and MIME workflows need manual server checks. So do snippets (partial fetch, charsets), server drafts (UIDPLUS), folder rename/delete and search operators on your IMAP server.
- **Frontend:** Vitest + happy-dom + Testing Library. `src/test/fetch.js` `mockApi` stubs `/api` responses, and `src/test/event-source.js` fakes SSE. happy-dom can't enforce CSP or real Notifications, so check those in a browser, along with drag-and-drop.

## Docker & CI

- `Dockerfile`: stage 1 builds the frontend (`oven/bun:1.4.3-alpine`, frozen lockfile). Stage 2 installs backend production deps, copies the backend and `frontend/dist`, and runs `bun start` (pm2-runtime). `config.js` serves `frontend/dist`, so keep that path. `.dockerignore` excludes tests.
- `.github/workflows/test.yml` runs on every push and PR: frozen installs, `biome lint`, backend tests, frontend tests, build.
- `.github/workflows/docker-publish.yml` runs on pushes to `master`. It tags `calypso666/ezmail:<package.json version>` and `:latest`, then sends an ntfy notification. It needs the secrets `DOCKER_USERNAME`, `DOCKER_PASSWORD` and `NTFY_URL`.
