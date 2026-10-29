# Changelog

All notable changes to ezmail are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Changed
- **Breaking filter configuration:** filters now use ManageSieve instead of writing under `MAIL_DATA_DIR`. Configure `SIEVE_HOST`, `SIEVE_PORT`, and `SIEVE_TLS`; existing files are retained for manual recovery and are not migrated automatically.
- HTTP request bodies are limited to 32 MiB, including the base64 representation of outgoing attachments.
- Message display downloads headers and text parts instead of the full MIME source; displayable text is limited to 8 MiB per message.
- **Attachment indexes now follow IMAP body-structure order.** Previously saved forwarding drafts may need to be recreated. Downloads and forwarded attachments are limited to 25 MiB.
- Message list sorting now uses mailbox arrival order, including across pages, instead of sorting each page by date. API consumers relying on per-page date ordering should adjust.
- Login discovery is rate limited, and password attempts are counted before IMAP verification.

### Added
- TOTP users can update a changed mailbox password using their authenticator code and current password via `POST /api/v1/totp/recover`.
- Send responses indicate when saving to Sent is disabled; the composer warns when saving fails.

### Fixed
- Pending TOTP re-enrollment preserves the active credentials until confirmation.
- Preserve drafts when leaving the composer, report failed bulk actions, and release mailbox locks on flag errors.

## [2.0.0] - 2026-10-21

### Breaking
- **Server-side sessions replace the password-carrying JWT.** Everyone must sign in again once. The `@elysiajs/jwt` dependency is removed, and the old `ezmail_access` cookie is cleared automatically.
- Major dependency upgrades: imapflow 2.5, nodemailer 10, react-router 8 (replaces `react-router-dom`), Vite 8, @vitejs/plugin-react 6, lucide-react 1.x, qr 0.7, concurrently 10.
- `/api/v1/totp/status` now requires a session for the same mailbox.
- The client-sent `fromName` is ignored; the From name comes from Settings → Profile.

### Added
- Reply, reply-all and forward. Forwarded attachments are copied on the server.
- Keyboard shortcuts (`?` lists them), Shift+arrow / PgUp / PgDn / Home / End range selection, and undo for moves and deletes.
- Locally auto-saved drafts; Ctrl/⌘+Enter sends.
- A copy of each sent message is saved to Sent (`SAVE_SENT=false` turns this off).
- Unread counts on all folders.
- Live INBOX updates through IMAP IDLE → server-sent events, opt-in desktop notifications, and an unread count in the tab title.
- Conversation view linked by `Message-ID` / `References`.
- Per-mailbox display name (Settings → Profile).
- Swipe left to archive (or delete) on mobile.
- Passwordless TOTP login: TOTP mailboxes leave the password blank.
- Rate limiting for login (10 per 15 min) and TOTP codes (5 per 15 min), returning `429` with `Retry-After`.
- Attachment download endpoint `GET /api/v1/mail/message/:folder/:uid/attachment/:index`.
- Test suites (bun test, and Vitest + happy-dom), a CI workflow, and project docs (CONTRIBUTING, AGENTS, SECURITY, CHANGELOG).

### Changed
- Attachments download on demand instead of being inlined as base64, and inline `cid:` images load from the endpoint.
- Server-side pagination fetches only the requested page.
- Trash, Sent and Archive are found by IMAP special-use role, not by name.
- The Docker image uses Bun 1.4.3 and installs from the lockfile; tests are excluded from the image.
- Bun's idle timeout is raised to 120s so long LLM summaries complete.

### Fixed
- Mail server failures return 502 instead of 200.
- All remote email content (CSS backgrounds, fonts, media) is blocked via the frame CSP, not just `<img>`.
- Fixed: double-wrapped delete response, empty-Trash expunge, From-name encoding.
- The selection clears when switching folders, and each opened message is fetched once.
- The summary panel's close button had no icon; it now shows one.
- Ollama and OpenAI-compatible LLM servers are detected and called on the matching endpoint.
- `COOKIE_SECURE` is honoured.

## [1.7.1]

Baseline for this changelog. See the git history for earlier changes.
