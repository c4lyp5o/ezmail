import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DB_PATH } from "./config.js";

mkdirSync(path.dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH, { create: true });
db.run("PRAGMA journal_mode = WAL;");
db.run("PRAGMA busy_timeout = 5000;");
db.run("PRAGMA foreign_keys = ON;");

db.run(`
	CREATE TABLE IF NOT EXISTS settings (
		key TEXT PRIMARY KEY,
		value TEXT
	);
`);

// Server-side sessions. `id` is the SHA-256 of the cookie token (a leaked db
// doesn't yield live cookies); the mailbox password is AES-GCM encrypted.
db.run(`
	CREATE TABLE IF NOT EXISTS sessions (
		id TEXT PRIMARY KEY,
		mailbox TEXT NOT NULL,
		pass_enc TEXT NOT NULL,
		expires_at INTEGER NOT NULL
	);
`);

// Optional IMAP filtering survives logout; credentials use the session key.
db.run(`
	CREATE TABLE IF NOT EXISTS fallback_filters (
		mailbox TEXT PRIMARY KEY,
		username TEXT NOT NULL,
		pass_enc TEXT,
		rules_json TEXT NOT NULL,
		enabled INTEGER NOT NULL DEFAULT 0,
		uid_validity TEXT NOT NULL,
		last_uid INTEGER NOT NULL,
		revision INTEGER NOT NULL DEFAULT 1,
		last_error TEXT,
		lease_until INTEGER NOT NULL DEFAULT 0,
		lease_owner TEXT
	);
`);

export function getSetting(key) {
	const row = db.query("SELECT value FROM settings WHERE key = ?").get(key);
	return row?.value ?? null;
}

export function setSetting(key, value) {
	db.query(
		`
		INSERT INTO settings (key, value) VALUES (?, ?)
		ON CONFLICT(key) DO UPDATE SET value = excluded.value;
		`,
	).run(key, value);
}

export function deleteSetting(key) {
	db.query("DELETE FROM settings WHERE key = ?").run(key);
}
