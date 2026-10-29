import crypto from "node:crypto";
import { db } from "../db.js";
import { generalLogger as logger } from "../logger.js";
import { decryptSecret, encryptSecret } from "./crypto.service.js";
import { firstMatchingFilter } from "./filter-match.service.js";
import { buildImapClient } from "./mail.service.js";

const BATCH_SIZE = 100;
const INTERVAL_MS = 60_000;
const LEASE_MS = 5 * 60_000;
const keyFor = (mailbox) => mailbox.trim().toLowerCase();

export function getFallback(mailbox) {
	const row = db.query("SELECT * FROM fallback_filters WHERE mailbox = ?").get(keyFor(mailbox));
	if (!row) return null;
	return { mode: "imap", enabled: !!row.enabled, rules: JSON.parse(row.rules_json), lastError: row.last_error || undefined };
}

// Called after successful login to keep a persistent worker's credential current.
export function refreshFallbackPassword(mailbox, password) {
	db.query("UPDATE fallback_filters SET username = ?, pass_enc = ? WHERE mailbox = ? AND enabled = 1").run(mailbox, encryptSecret(password), keyFor(mailbox));
}

async function connect(user, fn) {
	const client = buildImapClient(user, { connectionTimeout: 30_000, greetingTimeout: 30_000, socketTimeout: 30_000 });
	try { await client.connect(); return await fn(client); }
	finally { await client.logout().catch(() => {}); }
}

async function currentInboxCursor(user) {
	return connect(user, async (client) => {
		const lock = await client.getMailboxLock("INBOX");
		try {
			const box = client.mailbox;
			if (!box?.uidValidity || !Number.isSafeInteger(box.uidNext) || box.uidNext < 1) throw new Error("IMAP server did not provide inbox UID state");
			return { validity: String(box.uidValidity), uid: box.uidNext - 1 };
		} finally { lock.release(); }
	});
}

// First activation starts at the current high-water mark: existing mail is not moved.
export async function saveFallback(user, rules, enabled) {
	const mailbox = keyFor(user.mailbox);
	const existing = db.query("SELECT enabled FROM fallback_filters WHERE mailbox = ?").get(mailbox);
	const cursor = enabled && !existing?.enabled ? await currentInboxCursor(user) : null;
	db.query(`INSERT INTO fallback_filters (mailbox, username, pass_enc, rules_json, enabled, uid_validity, last_uid)
		VALUES (?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(mailbox) DO UPDATE SET username = excluded.username, pass_enc = excluded.pass_enc, rules_json = excluded.rules_json,
		enabled = excluded.enabled, uid_validity = CASE WHEN ? THEN excluded.uid_validity ELSE fallback_filters.uid_validity END,
		last_uid = CASE WHEN ? THEN excluded.last_uid ELSE fallback_filters.last_uid END,
		revision = fallback_filters.revision + 1, last_error = NULL`)
		.run(mailbox, user.mailbox, enabled ? encryptSecret(user.password) : null, JSON.stringify(rules), enabled ? 1 : 0,
			cursor?.validity || "", cursor?.uid || 0, cursor ? 1 : 0, cursor ? 1 : 0);
}

export function removeFallback(mailbox) {
	db.query("DELETE FROM fallback_filters WHERE mailbox = ?").run(keyFor(mailbox));
}

async function ensureFolder(client, folder, known) {
	if (folder.toUpperCase() === "INBOX") return;
	if (!known.loaded) {
		known.paths = new Set((await client.list()).map((entry) => entry.path));
		known.loaded = true;
	}
	if (!known.paths.has(folder)) {
		try { if (!(await client.mailboxCreate(folder))) throw new Error("Could not create destination folder"); }
		catch (err) {
			const again = await client.list();
			if (!again.some((entry) => entry.path === folder)) throw err;
		}
		known.paths.add(folder);
	}
}

export async function runFallbackMailbox(mailbox) {
	const key = keyFor(mailbox);
	const owner = crypto.randomUUID();
	const acquired = db.query("UPDATE fallback_filters SET lease_owner = ?, lease_until = ? WHERE mailbox = ? AND enabled = 1 AND lease_until < ?")
		.run(owner, Date.now() + LEASE_MS, key, Date.now());
	if (!acquired.changes) return;
	const row = db.query("SELECT * FROM fallback_filters WHERE mailbox = ? AND lease_owner = ?").get(key, owner);
	try {
		const password = row?.pass_enc && decryptSecret(row.pass_enc);
		if (!password) throw new Error("Stored credentials unavailable; sign in and save the filters again.");
		const rules = JSON.parse(row.rules_json);
		await connect({ mailbox: row.username, password }, async (client) => {
			const lock = await client.getMailboxLock("INBOX");
			try {
				const box = client.mailbox;
				if (!box?.uidValidity || !Number.isSafeInteger(box.uidNext) || box.uidNext < 1) throw new Error("IMAP server did not provide inbox UID state");
				if (String(box.uidValidity) !== row.uid_validity) {
					db.query("UPDATE fallback_filters SET uid_validity = ?, last_uid = ?, last_error = ? WHERE mailbox = ? AND revision = ? AND lease_owner = ?")
						.run(String(box.uidValidity), box.uidNext - 1, "Inbox identity changed; existing messages were skipped.", key, row.revision, owner);
					return;
				}
				const found = await client.search({ uid: `${row.last_uid + 1}:*` }, { uid: true });
				if (!Array.isArray(found)) throw new Error("Could not search inbox");
				const uids = (found || []).filter((uid) => uid > row.last_uid).sort((a, b) => a - b).slice(0, BATCH_SIZE);
				if (!uids.length && row.last_error !== "Inbox identity changed; existing messages were skipped.") {
					db.query("UPDATE fallback_filters SET last_error = NULL WHERE mailbox = ? AND revision = ? AND lease_owner = ?").run(key, row.revision, owner);
				}
				const known = { loaded: false, paths: new Set() };
				for (const uid of uids) {
					const stillActive = db.query("UPDATE fallback_filters SET lease_until = ? WHERE mailbox = ? AND enabled = 1 AND revision = ? AND lease_owner = ?")
						.run(Date.now() + LEASE_MS, key, row.revision, owner);
					if (!stillActive.changes) break;
					const message = await client.fetchOne(uid, { envelope: true }, { uid: true });
					if (message) {
						if (!message.envelope) throw new Error("Message envelope unavailable");
						const rule = firstMatchingFilter(rules, message.envelope);
						if (rule && rule.folder.toUpperCase() !== "INBOX") {
							await ensureFolder(client, rule.folder, known);
							const current = db.query("SELECT enabled, revision, lease_owner FROM fallback_filters WHERE mailbox = ?").get(key);
							if (!current?.enabled || current.revision !== row.revision || current.lease_owner !== owner) break;
							// mailboxOpen must precede messageMove, even after listing folders.
							if (!(await client.messageMove(uid, rule.folder, { uid: true }))) throw new Error("Could not move message");
						}
					}
					db.query("UPDATE fallback_filters SET last_uid = ?, last_error = NULL WHERE mailbox = ? AND revision = ? AND lease_owner = ?")
						.run(uid, key, row.revision, owner);
				}
			} finally { lock.release(); }
		});
	} catch (err) {
		logger.warn(`[FILTERS] IMAP fallback failed: ${err.message}`);
		db.query("UPDATE fallback_filters SET last_error = ? WHERE mailbox = ? AND lease_owner = ?")
			.run("Filtering failed. Check the mailbox connection and credentials; ezmail will retry.", key, owner);
	} finally {
		db.query("UPDATE fallback_filters SET lease_owner = NULL, lease_until = 0 WHERE mailbox = ? AND lease_owner = ?").run(key, owner);
	}
}

export async function runFallbackFilters() {
	const rows = db.query("SELECT mailbox FROM fallback_filters WHERE enabled = 1").all();
	for (const row of rows) await runFallbackMailbox(row.mailbox);
}

export function startFallbackWorker() {
	let running = false;
	const tick = async () => {
		if (running) return;
		running = true;
		try { await runFallbackFilters(); }
		catch (err) { logger.error(`[FILTERS] fallback worker failed: ${err.message}`); }
		finally { running = false; }
	};
	void tick();
	const timer = setInterval(tick, INTERVAL_MS);
	timer.unref?.();
	return () => clearInterval(timer);
}
