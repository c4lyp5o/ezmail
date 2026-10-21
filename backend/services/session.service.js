import crypto from "node:crypto";
import { db } from "../db.js";
import { decryptSecret, encryptSecret } from "./crypto.service.js";

// Server-side sessions: the cookie carries only a random 256-bit token; the
// mailbox password (needed for the IMAP/SMTP proxy) stays encrypted in sqlite
// and logout actually revokes the session.

const hash = (token) => crypto.createHash("sha256").update(token).digest("hex");

export function purgeExpiredSessions(now = Date.now()) {
	db.query("DELETE FROM sessions WHERE expires_at <= ?").run(now);
}

export function createSession(mailbox, password, ttlSeconds) {
	purgeExpiredSessions();
	const token = crypto.randomBytes(32).toString("base64url");
	db.query(
		"INSERT INTO sessions (id, mailbox, pass_enc, expires_at) VALUES (?, ?, ?, ?)",
	).run(hash(token), mailbox, encryptSecret(password), Date.now() + ttlSeconds * 1000);
	return token;
}

// Returns { mailbox, password } for a live session token, else null.
export function getSession(token) {
	if (typeof token !== "string" || !token) return null;
	const row = db
		.query("SELECT mailbox, pass_enc, expires_at FROM sessions WHERE id = ?")
		.get(hash(token));
	if (!row || row.expires_at <= Date.now()) return null;
	const password = decryptSecret(row.pass_enc);
	return password == null ? null : { mailbox: row.mailbox, password };
}

export function deleteSession(token) {
	if (typeof token !== "string" || !token) return;
	db.query("DELETE FROM sessions WHERE id = ?").run(hash(token));
}
