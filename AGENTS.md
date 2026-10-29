# AGENTS.md

Instructions for AI coding agents working in this repository. Humans should read [CONTRIBUTING.md](CONTRIBUTING.md) and [DEVELOPERS.md](DEVELOPERS.md); this file is the condensed version.

## Project

ezmail is self-hosted webmail. `backend/` is Bun + Elysia, proxying IMAP (imapflow) and SMTP (nodemailer) using the signed-in user's credentials. `frontend/` is a React 19 + Vite 8 + Tailwind 4 SPA using SWR and react-router 8.

## Commands

Bun may not be on PATH; prefix commands with `export PATH="$HOME/.bun/bin:$PATH"`.

| Task | Command (from repo root) |
| --- | --- |
| Install | `bun install` |
| Dev servers | `bun dev` (backend :5000, frontend :5173) |
| Backend tests | `bun run test:backend` |
| Frontend tests | `bun run test:frontend` |
| Lint | `bunx biome lint .` |
| Build | `bun run build:client` |

Run the backend tests, frontend tests and lint before saying a change is done; CI runs the same steps (`.github/workflows/test.yml`). Never report checks as passing unless you ran them.

## Rules

- Make minimal, task-scoped diffs. Don't reformat untouched files; most aren't Biome-formatted, and CI lints only.
- Match the code style: tabs, double quotes, semicolons, ESM with explicit `.js` extensions in the backend.
- Import routing from `"react-router"`, never `react-router-dom`.
- Don't edit `bun.lock` files unless the dependency change is intentional.
- Never commit `.env`, `backend/data/`, or `logs/`.
- Flag breaking changes to the API, DB schema, sessions or env vars explicitly, and record them in `CHANGELOG.md`.

## Backend pitfalls

- **Elysia strips response fields not in the route's `response` model.** Add new fields to `backend/models/` or they disappear.
- `t.Optional` fields reject `null`; return `undefined`.
- Handlers get `{ params, query, body, cookie, status, set }`. Get the user with `getUser(cookie)` from `plugins/auth.plugin.js`, and never trust a mailbox sent by the client.
- imapflow: `fetchOne` takes a sequence number unless the third argument is `{ uid: true }`. Call `mailboxOpen(source)` before `messageMove`/`messageCopy`. Flags are a `Set`.
- Find Trash/Sent/Archive with `findSpecialFolder` (special-use flag first), not hard-coded names.
- Mail upstream errors → 502; auth errors → 401; rate limit → 429 with `Retry-After`.
- `index.js` doesn't listen when `NODE_ENV=test`. Tests import the app and call it in-process via `tests/helpers/http.js`.

## Testing

- Backend: `backend/tests/setup.js` (preloaded via `bunfig.toml`) mocks imapflow/nodemailer with `tests/helpers/fake-imap.js` and `fake-smtp.js`, using a temporary SQLite `DB_PATH`. Extend the fakes when a feature needs a new IMAP capability.
- Frontend: Vitest + happy-dom + Testing Library. Mock the API with `mockApi` (`src/test/fetch.js`) and SSE with `src/test/event-source.js`.
- Nothing here talks to a real mail server. Say so when a change (IDLE, MIME, attachments, CSP) still needs a manual check.

## Security-sensitive areas

Review these carefully and add tests for them: `services/session.service.js`, `crypto.service.js`, `auth.service.js`, `rate-limit.service.js`, `filter.service.js` (writes files under `MAIL_DATA_DIR`), the attachment endpoint headers, and `MessageView`'s iframe sandbox/CSP (`emailCsp`, `emailDoc`).
