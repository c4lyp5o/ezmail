# ezmail 💌

A self-hosted webmail client. A Bun + Elysia backend talks IMAP/SMTP to your mail server; a React 19 + Vite + Tailwind 4 frontend runs in the browser. Part of the `ez-*` family alongside ezhost and eziarr.

## Features

- **Any mailbox can sign in.** Credentials are checked directly against your IMAP server; there are no ezmail accounts.
- **Reading:** server-side pagination, search, sort, and unread counts on every folder. Conversation view built from `Message-ID` / `References` across INBOX and Sent.
- **Live updates:** new mail arrives over IMAP IDLE, streamed to the browser with server-sent events. Optional desktop notifications and an unread count in the tab title.
- **Writing:** compose, reply, reply-all and forward (attachments are copied on the server). Optional Markdown body. Drafts auto-save locally. A copy of each sent message is saved to Sent. Ctrl/⌘+Enter sends.
- **Organising:** bulk select with checkboxes or Shift+arrows, move, archive, delete, mark read. Undo for moves and deletes. Swipe left on mobile to archive.
- **Safe rendering:** HTML mail is sanitised and shown in a sandboxed iframe with a strict Content-Security-Policy. Remote images, CSS backgrounds, fonts and media stay blocked until you allow them for that message. Attachments download on demand.
- **Security:** server-side sessions, optional passwordless TOTP login, rate-limited login and code attempts.
- **Extras:** per-mailbox display name, server-side filters (Dovecot Sieve), optional LLM summaries, light/dark theme, keyboard shortcuts.

## Quick start

Requires [Bun](https://bun.sh) 1.4+.

```bash
bun install                         # installs root, backend and frontend deps
cp backend/.env.example backend/.env
# edit backend/.env: at least IMAP_HOST and SMTP_HOST
bun dev                             # backend :5000 + Vite :5173
```

Open http://localhost:5173 and sign in with any mailbox on your server and its password.

## Configuration

Everything is set in `backend/.env` (see [`backend/.env.example`](backend/.env.example)). Server settings are never editable from the UI.

| Variable | Default | Purpose |
| --- | --- | --- |
| `IMAP_HOST` | — (required) | IMAP server. The backend refuses to start while this is unset. |
| `IMAP_PORT` / `IMAP_SECURE` | `993` / `true` | IMAP port and implicit TLS. |
| `SMTP_HOST` | — | SMTP submission server. |
| `SMTP_PORT` / `SMTP_SECURE` | `587` / `false` | `false` means STARTTLS on 587; use `465` / `true` for implicit TLS. |
| `PORT` | `5000` | HTTP port. |
| `NODE_ENV` | — | `production` hides `/openapi` and error details, and forces Secure cookies. |
| `COOKIE_SECURE` | auto | Force the Secure cookie flag (e.g. TLS terminated at a reverse proxy). |
| `TOTP_ENC_KEY` | generated | Key that encrypts stored mailbox passwords (sessions and TOTP). Set a stable random 64-char string in production. Changing it signs everyone out and invalidates TOTP enrolments. |
| `JWT_SECRET` | — | Legacy fallback for `TOTP_ENC_KEY`. |
| `SAVE_SENT` | `true` | Append sent mail to the Sent folder. Set `false` if your server already does (e.g. Gmail). |
| `SIEVE_HOST` | `IMAP_HOST` | ManageSieve server hostname. |
| `SIEVE_PORT` | `4190` | ManageSieve server port. |
| `SIEVE_TLS` | `starttls` | ManageSieve TLS mode: `starttls` or `implicit`. |
| `LLM_SERVER` / `LLM_SERVER_APIKEY` / `LLM_MODEL` | — | Optional Ollama or OpenAI-compatible server for summaries. |
| `DB_PATH` | `backend/data/ezmail.db` | SQLite file. |

Filters use ManageSieve with the signed-in mailbox credentials. The server must
offer TLS and `CHECKSCRIPT`; mail remains usable if ManageSieve is unavailable.
Active scripts are editable only when they exactly match ezmail's generated
template. Other active scripts are shown read-only and must be managed
externally. New scripts use new names, preserving older scripts on the server.
The old `MAIL_DATA_DIR` files remain on disk and are not migrated automatically;
back them up and migrate them manually with a ManageSieve client if needed.
Avoid concurrent external edits while saving filters in ezmail.

### LLM summaries (optional)

Set `LLM_SERVER` (and `LLM_MODEL`, plus `LLM_SERVER_APIKEY` if needed). At boot the backend probes the server (`/v1/models` or `/api/tags`). If it answers, opening a message shows a slide-out **Summary** column. Presence is only checked at boot, so restart after bringing the LLM server up.

## Production

### Docker

```bash
docker build -t ezmail .
docker run -d -p 5000:5000 \
  --env-file backend/.env -e NODE_ENV=production \
  -v ezmail-data:/app/backend/data \
  ezmail
```

Mount `/app/backend/data` so sessions, TOTP enrolments and settings survive restarts. Published images: `calypso666/ezmail:<version>` and `:latest`.

### pm2

```bash
bun run build:client
bun start            # pm2-runtime, NODE_ENV=production, PORT 5000
```

### Behind a reverse proxy

- Terminate TLS at the proxy and set `COOKIE_SECURE=true` (implied by `NODE_ENV=production`).
- `GET /api/v1/mail/events` is a long-lived server-sent events stream. Disable response buffering and allow long read timeouts for it. ezmail sends `X-Accel-Buffering: no`, which covers nginx; other proxies may need their own setting.
- Each signed-in user with an open tab holds one extra IMAP connection for live updates. Dovecot's default `mail_max_userip_connections` is 10, so raise it if users keep many tabs or devices open.

## Keyboard shortcuts

Press `?` in the app for the full list.

| Key | Action |
| --- | --- |
| `j` / `k`, `↓` / `↑` | Next / previous message |
| `Shift` + arrows, `PgUp` / `PgDn`, `Home` / `End` | Extend selection |
| `Enter` / `o` | Open message |
| `x` | Toggle selection |
| `c` | Compose |
| `r` / `a` / `f` | Reply / reply all / forward |
| `e` | Archive |
| `#` / `Delete` | Delete |
| `z` | Undo |
| `/` | Search |
| `Esc` | Clear selection or close |

## Security model

- Login is verified against IMAP. Errors are generic and never say whether the mailbox or the password was wrong.
- The browser holds only an opaque session token in an HttpOnly, SameSite=Strict cookie. The mailbox password is kept server-side, encrypted with `TOTP_ENC_KEY`, so IMAP/SMTP can be proxied. Logging out deletes the session.
- With TOTP enabled, a mailbox signs in with a 6-digit code instead of its password.
- See [SECURITY.md](SECURITY.md) for reporting vulnerabilities and known limitations.

## Documentation

- [DEVELOPERS.md](DEVELOPERS.md): architecture, internals, gotchas
- [CONTRIBUTING.md](CONTRIBUTING.md): workflow, tests, commit style
- [AGENTS.md](AGENTS.md): instructions for AI coding agents
- [SECURITY.md](SECURITY.md): security policy
- [CHANGELOG.md](CHANGELOG.md): release notes

## License

See [LICENSE.md](LICENSE.md).
