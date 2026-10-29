# Contributing to ezmail

Thanks for helping! This page covers setup, workflow and what a PR needs. For architecture, see [DEVELOPERS.md](DEVELOPERS.md).

## Setup

1. Install [Bun](https://bun.sh) 1.4.3 (the version used by CI and Docker).
2. Install dependencies and configure the backend:
   ```bash
   bun install
   cp backend/.env.example backend/.env   # set IMAP_HOST / SMTP_HOST
   bun dev                                # backend :5000, frontend :5173
   ```
3. You need a reachable IMAP/SMTP server to use the app; tests don't. A local [docker-mailserver](https://github.com/docker-mailserver/docker-mailserver) works well. The OpenAPI UI is at http://localhost:5000/openapi in development.

## Branches

- `master` is released. Every push to it publishes a Docker image.
- `development` is the integration branch. Branch off it (`feat/…`, `fix/…`) and open PRs against it.

## Checks (all run in CI)

Run these before opening a PR:

```bash
bunx biome lint .           # lint (from the repo root)
bun run test:backend        # bun test, IMAP/SMTP mocked
bun run test:frontend       # vitest + happy-dom
bun run build:client        # production build
```

Many existing files aren't Biome-formatted yet, so CI runs `lint` only. Don't reformat files you aren't otherwise changing.

## Writing changes

- Keep diffs small and focused; avoid unrelated refactors.
- Backend routes declare request/response models. **Undeclared response fields are stripped by Elysia**, and optional fields must be `undefined`, not `null`.
- Responses use the `{ success, message, data }` envelope with proper HTTP status codes. Upstream mail failures return 502.
- Take the mailbox from the session (`getUser(cookie)`), never from the request body.
- Add or update tests with every behaviour change. Backend tests go in `backend/tests/*.test.js`, using the fake IMAP/SMTP in `tests/helpers/`. Frontend tests go next to the component as `*.test.jsx`.
- Only change lockfiles when you intend a dependency change, and commit the lockfile with it.
- Put new environment variables in `backend/.env.example` and the README configuration table.
- Mark breaking changes (API shape, schema, sessions, env vars) in the commit message and in [CHANGELOG.md](CHANGELOG.md).

## Commits

Use [Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `perf:`, `test:`, `docs:`, `ci:`, `build:`, `chore(deps):`. Use `!` for breaking changes (`feat!:`). The subject line says what changed for the user; the body explains why.

## Pull requests

- Describe the change, how you tested it, and anything checked by hand against a real mail server or browser. Fake IMAP and happy-dom don't cover everything.
- Update the docs (README, DEVELOPERS, CHANGELOG) when behaviour or configuration changes.
- Releases bump `version` in the root, backend and frontend `package.json` together.

## Reporting bugs and security issues

Open a GitHub issue for bugs. For vulnerabilities, follow [SECURITY.md](SECURITY.md) rather than filing a public issue.
