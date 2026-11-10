import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { simpleParser } from "mailparser";

// Minimal in-memory IMAP server implementing the slice of the imapflow API
// ezmail uses. Sequence numbers are positions in a mailbox's message array;
// UIDs are per-mailbox and monotonically increasing, like a real server.

export const PASSWORD = "good-password";

export const imap = {
	boxes: new Map(),
	calls: [],
	uidplus: true,
	failMove: false,
	failDelete: false,
	failStatus: false,
	failMailbox: false,
	failAppend: false, // true: append throws like a NO/BAD reply; "undefined": resolves undefined
	failSearch: false, // search resolves false, like imapflow on a failed SEARCH
	failBodyParts: false, // a fetch with bodyParts (snippets) throws
	// UIDs whose flags another session changed. Like a real server (RFC 9051
	// 7.5.2), the next fetch reports them as extra unsolicited FETCH rows
	// carrying only seq and FLAGS, plus UID during a UID FETCH (RFC 3501
	// 6.4.8); imapflow's fetch() yields those rows like requested ones.
	// An entry is a UID, or { uid, flags, before } to report given flags
	// and/or send the row ahead of the requested ones.
	flagUpdates: [],
	clients: [], // every FakeImapFlow created, for pushing IDLE events
	reset() {
		this.boxes = new Map();
		this.calls = [];
		this.uidplus = true;
		this.failMove = false;
		this.failDelete = false;
		this.failStatus = false;
		this.failMailbox = false;
		this.failAppend = false;
		this.failSearch = false;
		this.failBodyParts = false;
		this.flagUpdates = [];
		this.clients = [];
	},
	addBox(path, specialUse) {
		const box = { path, specialUse, nextUid: 1, uidValidity: 1n, messages: [] };
		this.boxes.set(path, box);
		return box;
	},
	addMessage(
		path,
		{ subject = "s", from = "a@x.io", to, date, seen = false, source, bodyStructure, parts, rawParts, noEnvelope } = {},
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
			// ENVELOPE NIL: imapflow leaves envelope unset
			envelope: noEnvelope
				? undefined
				: { subject, from: [{ address: from, name: "" }], to: to ? [{ address: to, name: "" }] : [] },
			bodyStructure,
			parts, // decoded bytes, like download()/downloadMany()
			rawParts, // transfer-encoded bytes, like FETCH BODY[part]; defaults to parts
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

const has = (haystack, needle) => String(haystack).toLowerCase().includes(String(needle).toLowerCase());
// Header text plus the envelope address/name, like IMAP FROM/TO substring search.
const addressText = (m, field) =>
	[headerValue(m, field), ...(m.envelope[field] || []).map((a) => `${a.name} <${a.address}>`)].join(" ");
// IMAP dates compare calendar days only (UTC here), ignoring the time.
const day = (d) => Math.floor(new Date(d).getTime() / 86400000);

// All keys must match (IMAP SEARCH ANDs its criteria).
function matches(m, query) {
	return Object.entries(query).every(([key, v]) => {
		switch (key) {
			case "or": return v.some((q) => matches(m, q));
			case "header":
				return Object.entries(v).every(([k, val]) => has(headerValue(m, k), val));
			case "text": return has(m.envelope.subject, v);
			case "subject": return has(m.envelope.subject, v);
			case "from":
			case "to": return has(addressText(m, key), v);
			case "seen": return m.flags.has("\\Seen") === !!v;
			case "flagged": return m.flags.has("\\Flagged") === !!v;
			case "since": return day(m.internalDate) >= day(v);
			case "before": return day(m.internalDate) < day(v);
			default: throw new Error(`fake-imap: unsupported search key ${key}`);
		}
	});
}

function mailboxError(command) {
	const err = new Error("Command failed");
	err.executedCommand = command;
	err.responseStatus = "NO";
	return err;
}

function parseSeqRange(range, count) {
	const [lo, hi] = String(range)
		.split(":")
		.map((n) => (n === "*" ? count : Number(n)));
	return [lo, hi ?? lo];
}

// --- tiny MIME reader for appended messages (latin1 strings keep bytes) ---
function splitHead(text) {
	const m = /\r?\n\r?\n/.exec(text);
	return m ? [text.slice(0, m.index), text.slice(m.index + m[0].length)] : [text, ""];
}

function headerMap(head) {
	const map = {};
	for (const line of head.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/)) {
		const i = line.indexOf(":");
		if (i > 0) map[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
	}
	return map;
}

function withParams(value) {
	const [type, ...rest] = String(value).split(";");
	const params = {};
	for (const r of rest) {
		const m = r.match(/^\s*([^=]+)=\s*"?([^"]*)"?\s*$/);
		if (m) params[m[1].trim().toLowerCase()] = m[2];
	}
	return { type: type.trim().toLowerCase(), params };
}

function decodeBody(body, encoding) {
	if (encoding === "base64") return Buffer.from(body.replace(/\s+/g, ""), "base64");
	if (encoding === "quoted-printable") {
		const text = body.replace(/=\r?\n/g, "");
		return Buffer.from(text.replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(Number.parseInt(h, 16))), "latin1");
	}
	return Buffer.from(body, "latin1");
}

// Builds an imapflow-shaped bodyStructure (no `part` on a single-part root),
// decoded `parts` and encoded `rawParts` keyed by part id.
function parseMime(text) {
	const parts = {};
	const rawParts = {};
	function node(chunk, part) {
		const [head, body] = splitHead(chunk);
		const h = headerMap(head);
		const ct = withParams(h["content-type"] || "text/plain");
		const n = { type: ct.type, parameters: ct.params, encoding: (h["content-transfer-encoding"] || "7bit").toLowerCase(), size: body.length };
		if (part) n.part = part;
		if (h["content-disposition"]) {
			const d = withParams(h["content-disposition"]);
			n.disposition = d.type;
			n.dispositionParameters = d.params;
		}
		if (h["content-id"]) n.id = h["content-id"];
		if (ct.type.startsWith("multipart/") && ct.params.boundary) {
			n.childNodes = [];
			for (const piece of body.split(`--${ct.params.boundary}`).slice(1)) {
				if (piece.startsWith("--")) break;
				const child = piece.replace(/^\r?\n/, "").replace(/\r?\n$/, "");
				n.childNodes.push(node(child, part ? `${part}.${n.childNodes.length + 1}` : String(n.childNodes.length + 1)));
			}
			return n;
		}
		const key = part || "1";
		rawParts[key] = Buffer.from(body, "latin1");
		parts[key] = decodeBody(body, n.encoding);
		return n;
	}
	const structure = node(text, "");
	return { structure, parts, rawParts, headers: Buffer.from(`${splitHead(text)[0]}\r\n`, "latin1") };
}

export class FakeImapFlow extends EventEmitter {
	constructor(options) {
		super();
		this.options = options;
		this.mailbox = false;
		this.loggedOut = false;
		imap.clients.push(this);
	}

	get usable() {
		return !this.loggedOut;
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
			name: b.path.split("/").pop(),
			delimiter: "/",
			parentPath: b.path.includes("/") ? b.path.slice(0, b.path.lastIndexOf("/")) : "",
			specialUse: b.specialUse,
			flags: new Set(),
			status: opts.statusQuery?.unseen
				? { unseen: b.messages.filter((m) => !m.flags.has("\\Seen")).length }
				: undefined,
		}));
	}

	// Like imapflow 2.11: resolves to false when STATUS fails (imap.failStatus).
	async status(path, query = {}) {
		if (imap.failStatus) return false;
		const b = this.box(path);
		const res = { path, unseen: b.messages.filter((m) => !m.flags.has("\\Seen")).length };
		if (query.messages) res.messages = b.messages.length;
		return res;
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

	// Honours bodyParts [{ key, start, maxLength }] like imapflow 2.11: a Map
	// keyed by the lower-cased part id, holding the (still encoded) Buffer slice.
	async *fetch(range, query = {}, opts = {}) {
		const bodyParts = query?.bodyParts;
		imap.calls.push({ cmd: "fetch", range, uid: !!opts.uid, ...(bodyParts ? { bodyParts } : {}) });
		if (bodyParts && imap.failBodyParts) throw mailboxError("FETCH");
		const msgs = this.box(this.mailbox.path).messages;
		const updates = imap.flagUpdates.splice(0).map((u) => (typeof u === "number" ? { uid: u } : u));
		const unsolicited = function* (before) {
			for (const u of updates.filter((x) => !!x.before === before)) {
				const seq = msgs.findIndex((m) => m.uid === u.uid) + 1;
				if (seq) yield { seq, flags: new Set(u.flags || msgs[seq - 1].flags), ...(opts.uid ? { uid: u.uid } : {}) };
			}
		};
		yield* unsolicited(true);
		for (const m of this.select(range, opts)) {
			const out = { ...m, seq: msgs.indexOf(m) + 1 };
			if (bodyParts?.length) {
				out.bodyParts = new Map();
				for (const bp of bodyParts) {
					const key = typeof bp === "string" ? bp : bp.key;
					const data = m.rawParts?.[key] || m.parts?.[key];
					if (!data) continue;
					const start = bp.start || 0;
					out.bodyParts.set(key.toLowerCase(), data.subarray(start, bp.maxLength ? start + bp.maxLength : undefined));
				}
			}
			yield out;
		}
		yield* unsolicited(false);
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
		imap.calls.push({ cmd: "search", query });
		if (imap.failSearch) return false;
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

	// Like imapflow 2.11: a failed MOVE (server NO, missing destination)
	// resolves to false instead of throwing.
	async messageMove(uids, to, opts) {
		if (imap.failMove) return imap.failMove === "undefined" ? undefined : false;
		if (!imap.boxes.has(to)) return false;
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

	// Like imapflow 2.11: ALREADYEXISTS resolves to { created: false }.
	async mailboxCreate(path) {
		if (imap.boxes.has(path)) return { path, created: false };
		imap.addBox(path);
		return { path, created: true };
	}

	// Like imapflow 2.11: resolves to { path, newPath } and throws on a NO
	// (missing source, existing target, imap.failMailbox). Children move too.
	async mailboxRename(path, newPath) {
		imap.calls.push({ cmd: "rename", path, newPath });
		if (imap.failMailbox || !imap.boxes.has(path) || imap.boxes.has(newPath)) throw mailboxError("RENAME");
		for (const [p, b] of [...imap.boxes]) {
			if (p !== path && !p.startsWith(`${path}/`)) continue;
			imap.boxes.delete(p);
			b.path = newPath + p.slice(path.length);
			imap.boxes.set(b.path, b);
		}
		return { path, newPath };
	}

	// Like imapflow 2.11: resolves to { path } and throws on a NO.
	async mailboxDelete(path) {
		imap.calls.push({ cmd: "delete", path });
		if (imap.failMailbox || !imap.boxes.has(path)) throw mailboxError("DELETE");
		imap.boxes.delete(path);
		return { path };
	}

	// Like imapflow 2.11: a failed STORE/EXPUNGE resolves to false.
	async messageDelete(uids, opts = {}) {
		imap.calls.push({ cmd: "messageDelete", path: this.mailbox?.path, uids });
		if (imap.failDelete) return imap.failDelete === "undefined" ? undefined : false;
		const src = this.box(this.mailbox.path);
		const doomed = new Set(this.select(uids, opts));
		src.messages = src.messages.filter((m) => !doomed.has(m));
		return true;
	}

	// Like imapflow 2.11: throws when the server answers NO/BAD (failAppend),
	// resolves undefined when unauthenticated (failAppend = "undefined"), and reports uid/uidValidity only with UIDPLUS (APPENDUID). The stored message
	// is parsed so it can be listed and opened through the normal routes.
	async append(path, raw, flags = []) {
		imap.calls.push({ cmd: "append", path, flags: [...flags] });
		if (imap.failAppend === "undefined") return undefined;
		if (imap.failAppend) throw mailboxError("APPEND");
		const b = this.box(path);
		const source = Buffer.from(raw);
		const parsed = await simpleParser(source);
		const addrs = (field) => (field?.value || []).map((a) => ({ address: a.address, name: a.name || "" }));
		const mime = parseMime(source.toString("latin1"));
		const uid = b.nextUid++;
		b.messages.push({
			uid,
			flags: new Set(flags),
			internalDate: new Date(),
			envelope: {
				subject: parsed.subject || "",
				from: addrs(parsed.from),
				to: addrs(parsed.to),
				cc: addrs(parsed.cc),
				bcc: addrs(parsed.bcc),
				date: parsed.date,
			},
			bodyStructure: mime.structure,
			parts: mime.parts,
			rawParts: mime.rawParts,
			headers: mime.headers,
			source,
		});
		const res = { destination: path, path: this.mailbox?.path };
		return imap.uidplus ? { ...res, uid, uidValidity: b.uidValidity } : res;
	}
}
