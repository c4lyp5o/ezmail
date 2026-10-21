# Security Policy

## Reporting a vulnerability

Please **don't open a public issue**. Report privately through GitHub's [private vulnerability reporting](https://github.com/c4lyp5o/ezmail/security/advisories/new) and include the affected version, reproduction steps and the impact. You should get a response within a week.

## Supported versions

Only the latest release (the `master` branch and the `calypso666/ezmail:latest` image) receives fixes.

## Design summary

- Credentials are verified against your IMAP server. ezmail has no accounts of its own.
- The browser holds only an opaque random session token (HttpOnly, SameSite=Strict, and Secure in production). Sessions are stored server-side, keyed by a hash of that token.
- Mailbox passwords are kept server-side, encrypted with AES-GCM using `TOTP_ENC_KEY`, because IMAP/SMTP needs them on every request. Protect `backend/data/` and the key accordingly.
- HTML mail is sanitised and rendered in a sandboxed iframe with a CSP that blocks all remote content until the user opts in. Attachments are served with `Content-Disposition: attachment`, `nosniff` and a sandbox CSP.
- Login and TOTP code attempts are rate-limited per mailbox.

## Known limitations

- Rate limits are per mailbox and in memory. An attacker can temporarily lock out a mailbox, and the counts reset when the server restarts. Put a per-IP limit at your reverse proxy if ezmail is exposed publicly.
- With passwordless TOTP, the first login step reveals whether a mailbox has TOTP enabled. This step is rate-limited.
- A server compromise exposes the stored, encrypted passwords of active sessions and TOTP enrolments, together with the key if it lives on the same host.

## Deployment recommendations

- Run behind HTTPS with `NODE_ENV=production`.
- Set a stable, random `TOTP_ENC_KEY` (64 characters) and keep it out of the image.
- Keep the backend on a trusted network path to your mail server (IMAPS / SMTP with STARTTLS).
