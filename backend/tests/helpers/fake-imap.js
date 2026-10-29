import { EventEmitter } from "node:events";
import { Readable } from "node:stream";

// Minimal in-memory IMAP server implementing the slice of the imapflow API
// ezmail uses. Sequence numbers are positions in a mailbox's message array;
// UIDs are per-mailbox and monotonically increasing, like a real server.

export const PASSWORD = "good-password";

export const imap = {
	boxes: new Map(),
	calls: [],
	uidplus: true,
	failMove: false,
	clients: [], // every FakeImapFlow created, for pushing IDLE events
	reset() {
		this.boxes = new Map();
		this.calls = [];
		this.uidplus = true;
		this.failMove = false;
		this.clients = [];
	},
	addBox(path, specialUse) {
		const box = { path, specialUse, nextUid: 1, uidValidity: 1n, messages: [] };
		this.boxes.set(path, box);
		return box;
	},
	addMessage(
		path,
		{ subject = "s", from = "a@x.io", to, date, seen = false, source, bodyStructure, parts } = {},
	) {
		const box = this.boxes.get(path);
		const uid = box.nextUid++;
		const raw = Buffer.from(source || `From: ${from}\r\nSubject: ${subject}\r\n\r\nbody ${uid}`);
		const split = raw.toString().split(/\r?\n\r?\n/);
		const headers = Buffer.from(`${split.shift() || ""}\r\n`);
		bodyStructure ||= { type: "text/plain", part: "1" };
		parts ||= { "1": Buffer.from(split.join("\r\n\r\n")) };
		box.messages.push({
			uid,
			flags: new Set(seen ? ["\\Seen"] : []),
			internalDate: date || new Date(Date.UTC(2026, 0, 1, 0, uid)),
			envelope: { subject, from: [{ address: from, name: "" }], to: to ? [{ address: to, name: "" }] : [] },
			bodyStructure,
			parts,
			headers,
			source: raw,
		});
		return uid;
	},
};

function headerValue(m, name) {
	const head = m.source.toString().split(/\r?\n\r?\n/)[0].replace(/\r?\n[ \t]+/g, " ");
	const line = head
		.split(/\r?\n/)
		.find((l) => l.toLowerCase().startsWith(`${name.toLowerCase()}:`));
	return line ? line.slice(name.length + 1).trim() : "";
}

function matches(m, query) {
	if (query.or) return query.or.some((q) => matches(m, q));
	if (query.header) {
		return Object.entries(query.header).every(([k, v]) =>
			headerValue(m, k).toLowerCase().includes(String(v).toLowerCase()),
		);
	}
	const text = String(query.text || "").toLowerCase();
	return m.envelope.subject.toLowerCase().includes(text);
}

function parseSeqRange(range, count) {
	const [lo, hi] = String(range)
		.split(":")
		.map((n) => (n === "*" ? count : Number(n)));
	return [lo, hi ?? lo];
}

export class FakeImapFlow extends EventEmitter {
	constructor(options) {
		super();
		this.options = options;
		this.mailbox = false;
		this.loggedOut = false;
		imap.clients.push(this);
	}

	async connect() {
		if (this.options.auth?.pass !== PASSWORD) {
			const err = new Error("Authentication failed");
			err.responseText = "Invalid credentials";
			throw err;
		}
	}

	async logout() {
		this.loggedOut = true;
	}

	box(path) {
		const b = imap.boxes.get(path);
		if (!b) throw new Error(`No such mailbox ${path}`);
		return b;
	}

	async list(opts = {}) {
		return [...imap.boxes.values()].map((b) => ({
			path: b.path,
			name: b.path,
			delimiter: "/",
			specialUse: b.specialUse,
			flags: new Set(),
			status: opts.statusQuery?.unseen
				? { unseen: b.messages.filter((m) => !m.flags.has("\\Seen")).length }
				: undefined,
		}));
	}

	async status(path) {
		const b = this.box(path);
		return { unseen: b.messages.filter((m) => !m.flags.has("\\Seen")).length };
	}

	async getMailboxLock(path) {
		const b = this.box(path);
		this.mailbox = { path, exists: b.messages.length, uidValidity: b.uidValidity, uidNext: b.nextUid };
		return { release: () => {} };
	}

	async mailboxOpen(path) {
		return this.getMailboxLock(path);
	}

	select(uids, { uid } = {}) {
		const msgs = this.box(this.mailbox.path).messages;
		if (uid) {
			const set = new Set([uids].flat().map(Number));
			return msgs.filter((m) => set.has(m.uid));
		}
		const [lo, hi] = parseSeqRange(uids, msgs.length);
		if (!lo || lo > msgs.length) throw new Error("Invalid messageset");
		return msgs.slice(lo - 1, hi);
	}

	async *fetch(range, _query, opts = {}) {
		imap.calls.push({ cmd: "fetch", range, uid: !!opts.uid });
		for (const m of this.select(range, opts)) yield { ...m };
	}

	async fetchOne(uid, _query, opts = {}) {
		imap.calls.push({ cmd: "fetchOne", uid: !!opts.uid, query: _query });
		return this.select(uid, opts)[0] || false;
	}

	async downloadMany(uid, parts, opts = {}) {
		const part = parts[0];
		imap.calls.push({ cmd: "download", uid: !!opts.uid, part });
		const message = this.select(uid, opts)[0];
		const data = message?.parts?.[part];
		return data ? { [part]: { content: data } } : {};
	}

	async download(uid, part, opts = {}) {
		imap.calls.push({ cmd: "downloadBody", uid: !!opts.uid, part });
		const data = this.select(uid, opts)[0]?.parts?.[part];
		return data ? { content: Readable.from([data]) } : {};
	}

	// Supports { text }, { header: { name: value } } (substring, like IMAP
	// HEADER) and { or: [query, ...] }.
	async search(query) {
		if (query.uid) {
			const min = Number(String(query.uid).split(":")[0]);
			return this.box(this.mailbox.path).messages.filter((m) => m.uid >= min).map((m) => m.uid);
		}
		return this.box(this.mailbox.path)
			.messages.filter((m) => matches(m, query))
			.map((m) => m.uid);
	}

	async messageFlagsAdd(uids, flags, opts) {
		for (const m of this.select(uids, opts)) for (const f of flags) m.flags.add(f);
		return true;
	}

	async messageFlagsRemove(uids, flags, opts) {
		for (const m of this.select(uids, opts)) for (const f of flags) m.flags.delete(f);
		return true;
	}

	async messageMove(uids, to, opts) {
		if (imap.failMove) throw new Error("simulated move failure");
		const src = this.box(this.mailbox.path);
		const dst = this.box(to);
		const moving = this.select(uids, opts);
		const uidMap = new Map();
		for (const m of moving) {
			src.messages.splice(src.messages.indexOf(m), 1);
			const newUid = dst.nextUid++;
			uidMap.set(m.uid, newUid);
			dst.messages.push({ ...m, uid: newUid });
		}
		return imap.uidplus ? { path: src.path, destination: to, uidMap } : { path: src.path, destination: to };
	}

	async mailboxCreate(path) {
		if (imap.boxes.has(path)) throw new Error("Mailbox exists");
		imap.addBox(path);
		return { path };
	}

	async messageDelete(uids, opts = {}) {
		const src = this.box(this.mailbox.path);
		const doomed = new Set(this.select(uids, opts));
		src.messages = src.messages.filter((m) => !doomed.has(m));
		return true;
	}

	async append(path, raw, flags = []) {
		const b = this.box(path);
		const uid = b.nextUid++;
		b.messages.push({
			uid,
			flags: new Set(flags),
			internalDate: new Date(),
			envelope: { subject: "(appended)", from: [] },
			source: Buffer.from(raw),
		});
		return { destination: path, uid };
	}
}
