#!/bin/sh
# PM2 shim: run the ESM backend with bun directly.
# PM2's fork+bun interpreter wrapper does require() which cannot load
# top-level-await ESM (backend/index.js) — causing intermittent crashes.
# exec replaces the shell so signals reach bun and PM2 tracks the right pid.
exec bun run backend/index.js