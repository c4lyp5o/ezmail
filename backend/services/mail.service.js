import crypto from "node:crypto";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { marked } from "marked";
import nodemailer from "nodemailer";
import MailComposer from "nodemailer/lib/mail-composer";
import sanitizeHtml from "sanitize-html";
import { MAIL_SERVER } from "../config.js";
import { generalLogger as logger } from "../logger.js";
import { getUser } from "../plugins/auth.plugin.js";
import { createPool } from "./imap-pool.service.js";
import { getDisplayName } from "./profile.service.js";
import { parseSearchQuery } from "./search-query.js";
import { snippetFromPart } from "./snippet.js";

// Builds an IMAP client bound to the authenticated user's mailbox. No global
// account — the credentials come from the server-side session (created only
// after IMAP auth).
export function buildImapClient({ mailbox, password }, options = {}) {
	return new ImapFlow({
		host: MAIL_SERVER.imapHost,
		port: MAIL_SERVER.imapPort,
		secure: MAIL_SERVER.imapSecure,
		auth: {
			user: mailbox,
			pass: password,
		},
		logger: false,
		...options,
	});
}

const pool = createPool(buildImapClient);
export const closeImapPool = () => pool.closeIdle();

const withImap = (user, fn) => pool.use(user, fn);

async function withClient(user, status, fn) {
	if (!user?.mailbox || !user?.password) {
		return status
			? status(401, { success: false, message: "Unauthorized" })
			: { success: false, message: "Unauthorized" };
	}
	try {
		return { success: true, data: await pool.use(user, fn) };
	} catch (err) {
		logImapError(err);
		const body = { success: false, message: "Mail command failed" };
		return status ? status(502, body) : body;
	}
}

// imapflow throws rich errors with protocol detail. In dev we want the full
// picture; in production we still log the command and response text (no
// credentials ever) so outages are diagnosable from the log alone.
function logImapError(err) {
	const isProd = process.env.NODE_ENV === "production";
	const detail = {
		message: err.message,
		command: err.executedCommand,
		responseText: err.responseText,
		responseStatus: err.responseStatus,
		commandFailed: err.command === "BAD" || err.command === "NO",
	};

	if (isProd) {
		logger.error(
			`[MAIL] 💥[imap] ${detail.message} | ${detail.command || ""} | ${detail.responseText || ""}`,
		);
	} else {
		logger.error(
			`[MAIL] 💥[imap] ${detail.message} | cmd: ${detail.command || "n/a"} | resp: ${detail.responseText || "n/a"} | status: ${detail.responseStatus || "n/a"}`,
		);
		if (err.response) {
			logger.error(
				`[MAIL] 💥[imap] full response: ${JSON.stringify(err.response)}`,
			);
		}
	}
}

// Bare addresses from a mailparser address field (object or array of them).
function addressList(field) {
	const groups = Array.isArray(field) ? field : field ? [field] : [];
	return groups
		.flatMap((g) => g.value || [])
		.flatMap((a) => (a.group ? a.group : [a]))
		.map((a) => a.address)
		.filter(Boolean);
}

// Destination UIDs from a MOVE/COPY result (only when the server has UIDPLUS).
function destinationUids(res) {
	return res?.uidMap ? [...res.uidMap.values()].map(Number) : undefined;
}

// Finds a special-use folder (RFC 6154), falling back to common names —
// servers call Trash "Deleted Items", "Bin", etc.
async function findSpecialFolder(client, use, namePattern) {
	return specialIn(await client.list(), use, namePattern);
}
const specialIn = (list, use, namePattern) =>
	(list.find((f) => f.specialUse === use) || list.find((f) => namePattern.test(f.name)))?.path;
const TRASH_NAMES = /^(trash|bin|deleted( items| messages)?)$/i;
const SENT_NAMES = /^sent( items| mail| messages)?$/i;
// Same character set the Sieve filters accept, so a new folder can always be a rule target.
const NEW_FOLDER_NAME = /^[A-Za-z0-9][A-Za-z0-9 _-]*$/;
const ARCHIVE_NAMES = /^(archive|archives|all mail)$/i;

// Saves a copy of a sent message to the account's Sent folder. Most IMAP
// servers (docker-mailserver/Dovecot included) don't do this on SMTP submit.
// Set SAVE_SENT=false for servers that already do (e.g. Gmail) to avoid dupes.
async function saveToSent(user, raw) {
	if (process.env.SAVE_SENT === "false") return false;
	try {
		return await withImap(user, async (client) => {
			const sent = await findSpecialFolder(client, "\\Sent", SENT_NAMES);
			if (!sent) return false;
			await client.append(sent, raw, ["\\Seen"]);
			return true;
		});
	} catch (err) {
		logImapError(err);
		return false;
	}
}

// Fetches and parses one message's full source (mailparser), or null.
async function fetchParsed(client, folder, uid) {
	await client.mailboxOpen(folder || "INBOX");
	const msg = await client.fetchOne(Number(uid), { source: true }, { uid: true });
	if (!msg) return null;
	return { msg, parsed: await simpleParser(msg.source, { keepCidLinks: true }) };
}

// imapflow leaves `part` off the root of a single-part message, but the body is
// still addressable as part "1". Without this such messages open blank.
const withRootPart = (structure) =>
	structure && !structure.part && !structure.childNodes?.length ? { ...structure, part: "1" } : structure;

// A single traversal defines the indexes exposed by the message API and used
// for both downloads and forwarding. Do not descend into attached messages.
function attachmentParts(structure) {
	const parts = [];
	function visit(node, related = false) {
		if (!node) return;
		const disposition = String(node.disposition || "").toLowerCase();
		const type = String(node.type || "").toLowerCase();
		// A nameless inline text/plain or text/html part is the message body.
		const bodyText = type === "text/plain" || type === "text/html";
		const attached = disposition === "attachment" ||
			(disposition === "inline" && !bodyText) ||
			!!node.dispositionParameters?.filename || !!node.parameters?.name ||
			(related && !!node.id);
		if (attached && node.part) {
			parts.push({
				part: node.part,
				filename: node.dispositionParameters?.filename || node.parameters?.name || "attachment",
				contentType: node.type || "application/octet-stream",
				size: node.size || 0,
				contentId: node.id || undefined,
				related: related && !!node.id,
			});
			return;
		}
		for (const child of node.childNodes || []) visit(child, related || String(node.type).toLowerCase() === "multipart/related");
	}
	visit(withRootPart(structure));
	return parts;
}

const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const MAX_ENCODED_ATTACHMENT_BYTES = 36 * 1024 * 1024;
async function loadAttachment(client, uid, part) {
	if (!Number.isFinite(part.size) || part.size > MAX_ENCODED_ATTACHMENT_BYTES)
		throw new Error("Attachment exceeds the encoded size limit");
	// downloadMany decodes transfer encoding without charset or flowed-text
	// transformations, preserving the original attachment bytes.
	const result = await client.downloadMany(Number(uid), [part.part], {
		uid: true, maxBytes: MAX_ENCODED_ATTACHMENT_BYTES + 1,
	});
	const content = result?.[part.part]?.content;
	if (!Buffer.isBuffer(content)) throw new Error("Attachment not found");
	if (content.length > MAX_ATTACHMENT_BYTES) throw new Error("Attachment exceeds 25 MiB limit");
	return content;
}

// The displayable text/plain and text/html body nodes (attachments excluded).
function textBodyNodes(structure, attachments) {
	const attachmentIds = new Set(attachments.map((part) => part.part));
	const candidates = { "text/plain": [], "text/html": [] };
	function visit(node) {
		if (!node || attachmentIds.has(node.part)) return;
		const type = String(node.type || "").toLowerCase();
		if (candidates[type] && node.part) candidates[type].push(node);
		for (const child of node.childNodes || []) visit(child);
	}
	visit(withRootPart(structure));
	return candidates;
}

// Fetch only displayable text parts; attachment bodies are downloaded on demand.
async function loadDisplayBodies(client, uid, structure, attachments) {
	const candidates = textBodyNodes(structure, attachments);
	const bodies = { text: "", html: "" };
	let total = 0;
	for (const [type, key] of [["text/plain", "text"], ["text/html", "html"]]) {
		for (const { part } of candidates[type]) {
			const result = await client.download(Number(uid), part, { uid: true, maxBytes: 8 * 1024 * 1024 + 1 });
			if (!result?.content) throw new Error("Message body part not found");
			const chunks = [];
			let size = 0;
			for await (const chunk of result.content) {
				size += chunk.length;
				total += chunk.length;
				if (total > 8 * 1024 * 1024) {
					result.content.destroy();
					throw new Error("Message body exceeds 8 MiB limit");
				}
				chunks.push(chunk);
			}
			bodies[key] += Buffer.concat(chunks, size).toString("utf8");
		}
	}
	return bodies;
}

// Snippets: one partial BODY.PEEK fetch per distinct text part id on the page.
const SNIPPET_BYTES = 512;
const SNIPPET_MAX_GROUPS = 6;

// Adds `snippet` to the mapped rows in place. Never throws: on any failure
// the rows simply keep no snippet.
async function addSnippets(client, pageItems, rows) {
	const groups = new Map(); // part id -> [{ uid, node, row }]
	pageItems.forEach((msg, i) => {
		const nodes = textBodyNodes(msg.bodyStructure, attachmentParts(msg.bodyStructure));
		const node = nodes["text/plain"][0] || nodes["text/html"][0];
		if (!node || !msg.uid) return;
		if (!groups.has(node.part)) groups.set(node.part, []);
		groups.get(node.part).push({ uid: msg.uid, node, row: rows[i] });
	});
	// Largest groups first, so the cap drops the fewest rows.
	const chosen = [...groups].sort((a, b) => b[1].length - a[1].length).slice(0, SNIPPET_MAX_GROUPS);
	for (const [part, members] of chosen) {
		try {
			const byUid = new Map(members.map((m) => [m.uid, m]));
			const query = { uid: true, bodyParts: [{ key: part, start: 0, maxLength: SNIPPET_BYTES }] };
			for await (const msg of client.fetch([...byUid.keys()], query, { uid: true })) {
				const m = byUid.get(msg?.uid);
				const buf = msg?.bodyParts?.get?.(part.toLowerCase());
				if (!m || !buf) continue;
				m.row.snippet = snippetFromPart(buf, {
					type: m.node.type,
					encoding: m.node.encoding,
					charset: m.node.parameters?.charset,
				});
			}
		} catch (err) {
			// Stop here: a broken connection would fail every remaining group too.
			logger.warn(`[MAIL] snippet fetch failed for part ${part}: ${err.message}`);
			return;
		}
	}
}

const attachmentUrl = (folder, uid, index) =>
	`/api/v1/mail/message/${encodeURIComponent(folder)}/${uid}/attachment/${index}`;

// Points cid: references at the attachment endpoint instead of letting
// mailparser inline every image as base64 into the HTML.
function rewriteCidLinks(html, attachments, folder, uid) {
	if (!html) return html;
	const byCid = new Map(
		attachments
			.map((a, i) => [a.contentId?.replace(/^<|>$/g, ""), i])
			.filter(([cid]) => cid),
	);
	return html.replace(/(["'(])cid:([^"')\s]+)/gi, (m, q, cid) =>
		byCid.has(cid) ? `${q}${attachmentUrl(folder, uid, byCid.get(cid))}` : m,
	);
}

// RFC 6266 filename for Content-Disposition (ASCII fallback + UTF-8).
function contentDisposition(filename, type = "attachment") {
	const ascii = filename.replace(/[^\x20-\x7e]|["\\]/g, "_");
	return `${type}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

// Types that may be served inline (?inline=1) for previews, mapped to the
// fixed Content-Type and CSP sent. Never SVG/HTML or anything scriptable.
const IMAGE_CSP = "default-src 'none'; sandbox";
const INLINE_TYPES = new Map([
	["image/png", IMAGE_CSP],
	["image/jpeg", IMAGE_CSP],
	["image/gif", IMAGE_CSP],
	["image/webp", IMAGE_CSP],
]);

// The allowlisted media type (the Map's own key string) for a declared
// Content-Type, ignoring case and parameters; undefined when not allowlisted.
function inlineType(declared) {
	const bare = String(declared || "").split(";")[0].trim().toLowerCase();
	for (const key of INLINE_TYPES.keys()) if (key === bare) return key;
	return undefined;
}

function mapEnvelope(msg) {
	const from = msg.envelope?.from?.[0];
	const flags = toFlagsArray(msg.flags);
	return {
		uid: msg.uid,
		subject: msg.envelope?.subject || "(no subject)",
		from: from?.address || from?.name || "unknown",
		fromName: from?.name || "",
		date: msg.envelope?.date || msg.internalDate,
		flags,
		seen: flags.includes("\\Seen"),
		attachments: attachmentParts(msg.bodyStructure).length,
	};
}

// imapflow returns message flags as a Set (not an Array). Normalize to a
// plain array so Array.isArray checks and .includes() work everywhere.
function toFlagsArray(flags) {
	if (Array.isArray(flags)) return flags;
	if (flags && typeof flags[Symbol.iterator] === "function") {
		return [...flags];
	}
	return [];
}

// Fresh INBOX unseen count for the response, or undefined when the server
// can't say (the client keeps its current badge).
async function currentInboxUnseen(client) {
	try {
		return Number((await client.status("INBOX", { unseen: true }))?.unseen) || 0;
	} catch {
		return undefined;
	}
}

// imapflow resolves a failed MOVE (server NO, missing destination) to false
// rather than throwing; make it throw so withClient answers 502. imapflow also
// returns false for an empty UID list, which is a no-op, not a failure.
async function moveOrThrow(client, uids, to) {
	if (Array.isArray(uids) && !uids.length) return undefined;
	const moved = await client.messageMove(uids, to, { uid: true });
	if (!moved) throw new Error(`Could not move messages to ${to}`);
	return moved;
}

// A renamable/deletable folder from the server's own LIST (the client's path is
// only a lookup key), or { error: [status, message] }. INBOX, special-use
// folders and the folders findSpecialFolder resolves by name are refused.
async function userFolder(client, path) {
	const list = await client.list();
	const folder = list.find((f) => f.path === path);
	if (!folder) return { error: [404, "Folder not found."] };
	const resolved = [
		specialIn(list, "\\Trash", TRASH_NAMES),
		specialIn(list, "\\Sent", SENT_NAMES),
		specialIn(list, "\\Archive", ARCHIVE_NAMES),
	];
	if (folder.path.toUpperCase() === "INBOX" || folder.specialUse || resolved.includes(folder.path))
		return { error: [400, "INBOX and system folders can't be renamed or deleted."] };
	return { list, folder, resolved, delimiter: folder.delimiter ? String(folder.delimiter) : "" };
}

// Whether saved filter rules file into `path` or a folder below it. Read-only
// and best effort: undefined when the rules can't be read (e.g. ManageSieve down).
async function filtersReference(cookie, path, delimiter) {
	try {
		const { FilterService } = await import("./filter.service.js");
		const data = (await FilterService.get({ cookie, status: () => undefined }))?.data;
		if (!data || data.mode === "unavailable" || data.conflict || !Array.isArray(data.rules)) return undefined;
		const target = path.toLowerCase();
		return data.rules.some((rule) => {
			const folder = String(rule.folder || "").toLowerCase();
			return folder === target || (!!delimiter && folder.startsWith(target + delimiter.toLowerCase()));
		});
	} catch {
		return undefined;
	}
}

// Maps a folder-command result to the response: { error } → that status.
async function folderResponse(res, status, cookie, data) {
	if (res?.data?.error) {
		const [code, message] = res.data.error;
		return status(code, { success: false, message });
	}
	if (!res?.data) return res;
	const filtersAffected = await filtersReference(cookie, res.data.path, res.data.delimiter);
	return { success: true, data: { ...data(res.data), filtersAffected } };
}

// --- message composition shared by send and drafts ---

// If the sender used markdown and no explicit html was provided, convert
// markdown → HTML, then sanitize so any markdown-embedded HTML/scripts can't
// execute in recipients' mail clients.
function composeHtml(body) {
	if (body.html || !body.markdown || !body.text) return body.html;
	try {
		return sanitizeHtml(marked.parse(body.text));
	} catch {
		return undefined;
	}
}

// Uploaded (base64) plus forwarded attachments, or { error } for a 400.
// Throws on IMAP failure or when forwarded attachments exceed the limit.
async function composeAttachments(user, body) {
	const attachments = (body.attachments || []).map((a) => ({
		filename: a.filename,
		contentType: a.contentType || "application/octet-stream",
		content: Buffer.from(a.content || "", "base64"),
	}));

	// Forwarded attachments are copied from the original message here,
	// so the browser never has to download and re-upload them.
	const fwd = body.forwardAttachments;
	if (fwd?.indexes?.length) {
		if (fwd.indexes.length > 100) return { error: "Too many forwarded attachments" };
		const forwarded = await withImap(user, async (client) => {
			await client.mailboxOpen(fwd.folder || "INBOX");
			const original = await client.fetchOne(Number(fwd.uid), { bodyStructure: true }, { uid: true });
			const parts = attachmentParts(original?.bodyStructure);
			if (fwd.indexes.some((i) => !parts[i])) return null;
			const result = [];
			let total = 0;
			for (const i of fwd.indexes) {
				const a = parts[i];
				const content = await loadAttachment(client, fwd.uid, a);
				total += content.length;
				if (total > MAX_ATTACHMENT_BYTES) throw new Error("Forwarded attachments exceed 25 MiB limit");
				result.push({ filename: a.filename, contentType: a.contentType, content });
			}
			return result;
		});
		if (!forwarded) return { error: "Forwarded attachment not found" };
		attachments.push(...forwarded);
	}
	return { attachments };
}

function composeMail(user, body, html, attachments) {
	const domain = user.mailbox.split("@")[1] || "localhost";
	return {
		from: {
			name: getDisplayName(user.mailbox) || user.mailbox,
			address: user.mailbox,
		},
		to: body.to || undefined,
		cc: body.cc || undefined,
		bcc: body.bcc || undefined,
		subject: body.subject || "",
		text: body.text || "",
		html: html || undefined,
		attachments: attachments.length ? attachments : undefined,
		inReplyTo: body.inReplyTo || undefined,
		references: body.references || undefined,
		// Fixed id + date so the Sent copy is the same message as the one
		// delivered (threading in other clients matches it up).
		messageId: `<${crypto.randomUUID()}@${domain}>`,
		date: new Date(),
	};
}

// --- drafts ---
const DRAFTS_NAMES = /^drafts?$/i;

// Creates a folder, tolerating only an explicit already-exists.
async function createIfMissing(client, path) {
	try {
		// imapflow returns { created: false } on ALREADYEXISTS (another tab, or unlisted).
		await client.mailboxCreate(path);
	} catch (err) {
		// Tolerate only an explicit already-exists; "doesn't exist", [NONEXISTENT] etc. are failures.
		const already = err.serverResponseCode
			? err.serverResponseCode === "ALREADYEXISTS"
			: /already ?exists/i.test(`${err.responseText || ""} ${err.response || ""} ${err.message}`);
		if (!already) throw err;
	}
}

// The account's Drafts folder by role (then name); with `create`, made if missing.
async function draftsFolder(client, create) {
	const found = await findSpecialFolder(client, "\\Drafts", DRAFTS_NAMES);
	if (found || !create) return found;
	await createIfMissing(client, "Drafts");
	return "Drafts";
}

// Removes one message from the Drafts folder, only if it carries \Draft.
// false when it doesn't exist or isn't a draft; throws when the delete fails.
// Note: a mailbox that doesn't accept \Draft as a permanent flag makes imapflow
// drop it silently, so the copy never matches here and stays (replaced: false).
async function removeDraft(client, drafts, uid) {
	const lock = await client.getMailboxLock(drafts);
	try {
		const msg = await client.fetchOne(uid, { uid: true, flags: true }, { uid: true });
		if (!msg || !toFlagsArray(msg.flags).includes("\\Draft")) return false;
		if (!(await client.messageDelete([uid], { uid: true }))) throw new Error(`Could not remove draft ${uid}`);
		return true;
	} finally {
		lock.release();
	}
}

// Without UIDPLUS the APPEND reply has no UID: look the copy up by its unique
// Message-ID. Best-effort; undefined on any failure or no match.
async function findDraftUid(client, drafts, messageId) {
	if (!messageId) return undefined;
	try {
		const lock = await client.getMailboxLock(drafts);
		try {
			// imapflow resolves false on a failed SEARCH, undefined without a mailbox.
			const found = await client.search({ header: { "message-id": messageId } }, { uid: true });
			if (!Array.isArray(found) || !found.length) return undefined;
			const uid = Math.max(...found);
			return Number.isInteger(uid) && uid > 0 ? uid : undefined;
		} finally {
			lock.release();
		}
	} catch (err) {
		logImapError(err);
		return undefined;
	}
}

async function changeFlags(method, cookie, body, status) {
	const user = await getUser(cookie);
	if (!user?.mailbox || !user?.password)
		return status(401, { success: false, message: "Unauthorized" });
	const { folder, uids, flags } = body;
	return withClient(user, status, async (client) => {
		const lock = await client.getMailboxLock(folder);
		try { await client[method](uids, flags, { uid: true }); }
		finally { lock.release(); }
		return { uids, flags, inboxUnseen: await currentInboxUnseen(client) };
	});
}

export const MailService = {
	// --- folders ---
	listFolders: async ({ cookie, status }) => {
		const user = await getUser(cookie);
		if (!user?.mailbox || !user?.password)
			return status(401, { success: false, message: "Unauthorized" });
		return withClient(user, status, async (client) => {
			const list = await client.list({ statusQuery: { unseen: true } });
			const folders = list
				.filter((f) => f.path !== "[Gmail]")
				.map((f) => ({
					path: f.path,
					name: f.name,
					delimiter: f.delimiter == null ? "/" : String(f.delimiter),
					specialUse: f.specialUse || null,
					flags: toFlagsArray(f.flags),
					hasChildren: !!f.hasChildren,
					unread: Number(f.status?.unseen) || 0,
				}));

			return folders;
		});
	},

	// --- create a top-level folder ---
	createFolder: async ({ cookie, body, status }) => {
		const user = await getUser(cookie);
		if (!user?.mailbox || !user?.password)
			return status(401, { success: false, message: "Unauthorized" });
		const name = body.name.trim();
		if (!NEW_FOLDER_NAME.test(name) || name.toUpperCase() === "INBOX")
			return status(400, { success: false, message: "Use letters, numbers, spaces, dashes and underscores." });
		const res = await withClient(user, status, async (client) => {
			const existing = await client.list();
			if (existing.some((f) => f.path.toLowerCase() === name.toLowerCase())) return { path: name, created: false };
			const made = await client.mailboxCreate(name);
			// imapflow reports ALREADYEXISTS (e.g. an unlisted folder) as created: false.
			return { path: made?.path || name, created: made?.created !== false };
		});
		if (res?.data?.created === false)
			return status(409, { success: false, message: "A folder with that name already exists." });
		return res?.data ? { success: true, data: { path: res.data.path } } : res;
	},

	// --- rename a user folder (keeps its parent) ---
	renameFolder: async ({ cookie, body, status }) => {
		const user = await getUser(cookie);
		if (!user?.mailbox || !user?.password)
			return status(401, { success: false, message: "Unauthorized" });
		const newName = body.newName.trim();
		if (!NEW_FOLDER_NAME.test(newName) || newName.toUpperCase() === "INBOX")
			return status(400, { success: false, message: "Use letters, numbers, spaces, dashes and underscores." });
		const res = await withClient(user, status, async (client) => {
			const found = await userFolder(client, body.path);
			if (found.error) return found;
			const { list, folder, resolved, delimiter } = found;
			// Renaming a parent would move any system folder nested below it.
			if (delimiter && list.some((f) => f.path.startsWith(folder.path + delimiter) && (f.specialUse || resolved.includes(f.path))))
				return { error: [400, "This folder contains a system folder and can't be renamed."] };
			if (delimiter && newName.includes(delimiter))
				return { error: [400, "Folder names can't contain the hierarchy delimiter."] };
			const parent = folder.parentPath ??
				(delimiter && folder.path.includes(delimiter) ? folder.path.slice(0, folder.path.lastIndexOf(delimiter)) : "");
			const newPath = parent ? `${parent}${delimiter}${newName}` : newName;
			if (newPath === folder.path) return { error: [400, "The folder already has that name."] };
			if (list.some((f) => f.path !== folder.path && f.path.toLowerCase() === newPath.toLowerCase()))
				return { error: [409, "A folder with that name already exists."] };
			// imapflow throws on NO, but resolves undefined when not authenticated.
			const renamed = await client.mailboxRename(folder.path, newPath);
			if (!renamed) throw new Error(`Could not rename ${folder.path}`);
			return { path: folder.path, newPath: renamed.newPath || newPath, delimiter };
		});
		return folderResponse(res, status, cookie, ({ path, newPath }) => ({ path, newPath }));
	},

	// --- delete an empty user folder ---
	deleteFolder: async ({ cookie, body, status }) => {
		const user = await getUser(cookie);
		if (!user?.mailbox || !user?.password)
			return status(401, { success: false, message: "Unauthorized" });
		const res = await withClient(user, status, async (client) => {
			const found = await userFolder(client, body.path);
			if (found.error) return found;
			const { list, folder, delimiter } = found;
			const children = toFlagsArray(folder.flags).includes("\\HasChildren") ||
				(!!delimiter && list.some((f) => f.path.startsWith(folder.path + delimiter)));
			if (children) return { error: [409, "Delete or move this folder's subfolders first."] };
			// imapflow resolves STATUS failures to false; never delete on an unknown count.
			const info = await client.status(folder.path, { messages: true });
			const count = Number(info?.messages);
			if (!info || !Number.isInteger(count)) throw new Error(`Could not count messages in ${folder.path}`);
			if (count > 0) return { error: [409, "Only empty folders can be deleted. Move or delete its messages first."] };
			const deleted = await client.mailboxDelete(folder.path);
			if (!deleted) throw new Error(`Could not delete ${folder.path}`);
			return { path: folder.path, delimiter };
		});
		return folderResponse(res, status, cookie, ({ path }) => ({ path }));
	},

	// --- message list (envelope only) ---
	listMessages: async ({ cookie, params, query, status }) => {
		const user = await getUser(cookie);
		if (!user?.mailbox || !user?.password)
			return status(401, { success: false, message: "Unauthorized" });
		const folder = params?.folder;
		// Whole numbers >= 1; anything else would build an invalid sequence set.
		const page = Math.max(1, Math.floor(Number(query?.page) || 1));
		const pageSizeRaw = Math.max(1, Math.floor(Number(query?.pageSize) || 50));
		const size = Math.min(pageSizeRaw, 100);
		const sort = query?.sort || "desc"; // 'asc' | 'desc' by date
		const search = (query?.search || "").trim();
		const wantSnippets = query?.snippets === "1" || query?.snippets === "true";

		return withClient(user, status, async (client) => {
			const targetFolder = folder || "INBOX";

			// 1. Acquire mailbox lock (recommended by imapflow over mailboxOpen)
			const lock = await client.getMailboxLock(targetFolder);

			try {
				// 2. CHECK IF FOLDER IS EMPTY (Fixes the "Invalid messageset" error)
				if (!client.mailbox || client.mailbox.exists === 0) {
					return { messages: [], total: 0, page, pageSize: size, sort, search };
				}

				// 3. If search term is present, search UIDs
				let searchUids = null;
				if (search) {
					const uids = await client.search(parseSearchQuery(search), { uid: true });
					if (Array.isArray(uids) && uids.length) {
						searchUids = new Set(uids);
					} else {
						return {
							messages: [],
							total: 0,
							page,
							pageSize: size,
							sort,
							search,
						};
					}
				}

				// 4. Fetch only the requested page. Arrival order (sequence/UID)
				// stands in for date order, so a page never costs a full-folder
				// FETCH — that ran on every 10s poll and grew with the mailbox.
				const fetchOpts = {
					envelope: true,
					flags: true,
					internalDate: true,
					bodyStructure: true,
					source: false,
				};
				const from = (page - 1) * size;
				let total;
				let range;
				let byUid;
				if (searchUids) {
					const ordered = [...searchUids].sort((a, b) =>
						sort === "asc" ? a - b : b - a,
					);
					total = ordered.length;
					range = ordered.slice(from, from + size);
					byUid = true;
				} else {
					total = client.mailbox.exists;
					const lo =
						sort === "asc" ? from + 1 : Math.max(1, total - from - size + 1);
					const hi = sort === "asc" ? Math.min(total, from + size) : total - from;
					range = hi >= lo ? `${lo}:${hi}` : null;
					byUid = false;
				}

				const pageItems = [];
				if (range?.length) {
					for await (const msg of client.fetch(range, fetchOpts, {
						uid: byUid,
					})) {
						pageItems.push(msg);
					}
				}

				// IMAP returns sequence/UID order; reverse for newest arrival first.
				if (sort !== "asc") pageItems.reverse();
				const messages = pageItems.map((msg) => mapEnvelope(msg));
				if (wantSnippets && messages.length) await addSnippets(client, pageItems, messages);

				return { messages, total, page, pageSize: size, sort, search };
			} finally {
				// 6. Always release the lock
				lock.release();
			}
		});
	},

	// --- single message full body + flags ---
	getMessage: async ({ cookie, params, status }) => {
		const user = await getUser(cookie);
		if (!user?.mailbox || !user?.password)
			return status(401, { success: false, message: "Unauthorized" });
		const { folder, uid } = params;
		const res = await withClient(user, status, async (client) => {
			await client.mailboxOpen(folder || "INBOX");
			const msg = await client.fetchOne(
				Number(uid),
				{
					envelope: true,
					flags: true,
					internalDate: true,
					headers: true,
					bodyStructure: true,
				},
				{ uid: true },
			);

			if (!msg) {
				logger.warn(
					`[MAIL] fetchOne returned null for uid=${uid} folder=${folder}`,
				);
				return null;
			}

			// Parse headers independently so the message body need not include attachments.
			let parsed;
			try {
				parsed = await simpleParser(Buffer.concat([msg.headers || Buffer.alloc(0), Buffer.from("\r\n")]), { keepCidLinks: true });
			} catch (err) {
				logger.error(`[MAIL] 💥[parse] ${err.message}`);
				parsed = null;
			}

			// Metadata only — bytes come from the attachment endpoint on demand.
			const rawAttachments = attachmentParts(msg.bodyStructure);
			const bodies = await loadDisplayBodies(client, uid, msg.bodyStructure, rawAttachments);
			const attachments = rawAttachments.map((a, index) => ({
				index,
				filename: a.filename || "attachment",
				contentType: a.contentType || "application/octet-stream",
				size: a.size || 0,
				contentId: a.contentId || undefined,
				related: a.related,
			}));

			// Extra display headers for the toggleable detail panel.
			const hdrs = parsed?.headers;
			// mailparser returns plain strings for most headers, objects for structured ones.
			const header = (name) => {
				const raw = hdrs?.get?.(name);
				const first = Array.isArray(raw) ? raw[0] : raw;
				return typeof first === "string" ? first : String(first?.value ?? "");
			};
			const replyTo = parsed?.replyTo?.text || "";
			const mailedBy = header("x-mailer") || header("user-agent");
			const signedBy = header("x-dkim-signature").match(/d=([^\s;]+)/i)?.[1] || "";

			return {
				uid: msg.uid,
				folder: folder || "INBOX",
				envelope: msg.envelope,
				flags: toFlagsArray(msg.flags),
				internalDate: msg.internalDate,
				subject: parsed?.subject || msg.envelope?.subject || "(no subject)",
				from:
					parsed?.from?.text || msg.envelope?.from?.[0]?.address || "unknown",
				fromName: parsed?.from?.value?.[0]?.name || "",
				to: parsed?.to?.text || "",
				cc: parsed?.cc?.text || "",
				// Only drafts normally keep a Bcc header; undefined otherwise.
				bcc: parsed?.bcc?.text || undefined,
				replyTo: replyTo || "",
				messageId: parsed?.messageId || undefined,
				inReplyTo: parsed?.inReplyTo || undefined,
				references: [parsed?.references || []].flat().join(" ") || undefined,
				addresses: {
					from: addressList(parsed?.from),
					replyTo: addressList(parsed?.replyTo),
					to: addressList(parsed?.to),
					cc: addressList(parsed?.cc),
					bcc: parsed?.bcc ? addressList(parsed.bcc) : undefined,
				},
				date: parsed?.date || msg.internalDate,
				mailedBy,
				signedBy,
				html:
					rewriteCidLinks(bodies.html, rawAttachments, folder || "INBOX", msg.uid) ||
					"",
				text: bodies.text,
				attachments,
			};
		});
		// Missing or expunged message.
		if (res?.success && !res.data) return status(404, { success: false, message: "Not Found" });
		return res;
	},

	// --- conversation: messages linked by Message-ID / References ---
	// Searches INBOX and Sent for the message's ancestors (its References /
	// In-Reply-To ids) and descendants (mail whose References mention it).
	getThread: async ({ cookie, params, status }) => {
		const user = await getUser(cookie);
		if (!user?.mailbox || !user?.password)
			return status(401, { success: false, message: "Unauthorized" });
		const { folder, uid } = params;
		return withClient(user, status, async (client) => {
			const found = await fetchParsed(client, folder, uid);
			const p = found?.parsed;
			if (!p?.messageId) return [];

			// Bound the search on very long threads, but never drop the message's own id.
			const refs = [...[p.references || []].flat(), p.inReplyTo].filter(Boolean);
			const ids = [...new Set([p.messageId, ...refs.slice(-24)])];
			const terms = [
				...ids.map((id) => ({ header: { "message-id": id } })),
				{ header: { references: p.messageId } },
			];
			const query = terms.length > 1 ? { or: terms } : terms[0];

			const sent = await findSpecialFolder(client, "\\Sent", SENT_NAMES);
			const archive = await findSpecialFolder(client, "\\Archive", ARCHIVE_NAMES);
			const boxes = [...new Set(["INBOX", folder, sent, archive].filter(Boolean))];
			const items = [];
			for (const box of boxes) {
				const lock = await client.getMailboxLock(box);
				try {
					const uids = await client.search(query, { uid: true });
					if (!uids?.length) continue;
					for await (const m of client.fetch(
						uids,
						{ envelope: true, flags: true, internalDate: true },
						{ uid: true },
					)) {
						const from = m.envelope?.from?.[0];
						items.push({
							folder: box,
							uid: m.uid,
							subject: m.envelope?.subject || "(no subject)",
							from: from?.address || from?.name || "unknown",
							fromName: from?.name || "",
							date: m.envelope?.date || m.internalDate,
							seen: toFlagsArray(m.flags).includes("\\Seen"),
						});
					}
				} finally {
					lock.release();
				}
			}
			items.sort((a, b) => new Date(a.date) - new Date(b.date));
			return items;
		});
	},

	// --- one attachment's bytes (download, inline cid: images) ---
	getAttachment: async ({ cookie, params, query, status }) => {
		const user = await getUser(cookie);
		if (!user?.mailbox || !user?.password)
			return status(401, { success: false, message: "Unauthorized" });
		const { folder, uid, index } = params;
		let found;
		try {
			found = await withImap(user, async (client) => {
				await client.mailboxOpen(folder || "INBOX");
				const msg = await client.fetchOne(Number(uid), { bodyStructure: true }, { uid: true });
				const part = attachmentParts(msg?.bodyStructure)[Number(index)];
				if (!part) return null;
				return { ...part, content: await loadAttachment(client, uid, part) };
			});
		} catch (err) {
			logImapError(err);
			return status(502, { success: false, message: "Mail command failed" });
		}
		const a = found;
		if (!a) return status(404, { success: false, message: "Not Found" });

		// ?inline=1 for an allowlisted type: shown in place, with a fixed
		// Content-Type from the allowlist and no sniffing. Otherwise ignored.
		const inline = query?.inline === "1" ? inlineType(a.contentType) : undefined;
		if (inline) {
			return new Response(a.content, {
				headers: {
					"Content-Type": inline,
					"Content-Disposition": contentDisposition(a.filename || "attachment", "inline"),
					"Content-Length": String(a.content.length),
					"X-Content-Type-Options": "nosniff",
					"Content-Security-Policy": INLINE_TYPES.get(inline),
					"Cache-Control": "no-store",
				},
			});
		}

		// Served from our own origin, so never let it render as a page:
		// always a download on navigation, no sniffing, sandboxed if opened.
		return new Response(a.content, {
			headers: {
				"Content-Type": a.contentType || "application/octet-stream",
				"Content-Disposition": contentDisposition(a.filename || "attachment"),
				"Content-Length": String(a.content.length),
				"X-Content-Type-Options": "nosniff",
				"Content-Security-Policy": "default-src 'none'; sandbox",
				"Cache-Control": "no-store",
			},
		});
	},

	// --- set / clear flags (read/unread/delete) ---
	setFlags: ({ cookie, body, status }) => changeFlags("messageFlagsAdd", cookie, body, status),
	clearFlags: ({ cookie, body, status }) => changeFlags("messageFlagsRemove", cookie, body, status),

	// --- move message ---
	moveMessage: async ({ cookie, body, status }) => {
		const user = await getUser(cookie);
		if (!user?.mailbox || !user?.password)
			return status(401, { success: false, message: "Unauthorized" });
		const { uids, from, to } = body;
		const targetUids = Array.isArray(uids) ? uids.map(Number) : uids;
		return withClient(user, status, async (client) => {
			const lock = await client.getMailboxLock(from);
			let movedUids;
			try {
				movedUids = destinationUids(await moveOrThrow(client, targetUids, to));
			} finally {
				lock.release();
			}
			const inboxUnseen = await currentInboxUnseen(client);
			return { uids: targetUids, from: from, to: to, inboxUnseen, movedUids };
		});
	},

	// Delete messages: outside Trash a move to Trash (`trash` + `movedUids` in
	// the response); inside Trash permanent (flag \Deleted + expunge, no `trash`).
	deleteMessage: async ({ cookie, body, status }) => {
		const user = await getUser(cookie);
		if (!user?.mailbox || !user?.password)
			return status(401, { success: false, message: "Unauthorized" });
		const { uids, folder } = body;
		const targetUids = Array.isArray(uids) ? uids.map(Number) : uids;
		return withClient(user, status, async (client) => {
			let trash = await findSpecialFolder(client, "\\Trash", TRASH_NAMES);
			if (!trash) {
				// Some mailboxes have no Trash yet; create it rather than failing the delete.
				trash = "Trash";
				await createIfMissing(client, trash);
			}
			const toTrash = folder !== trash;
			let movedUids;
			const lock = await client.getMailboxLock(folder);
			try {
				if (toTrash) {
					movedUids = destinationUids(await moveOrThrow(client, targetUids, trash));
				} else if (targetUids.length && !(await client.messageDelete(targetUids, { uid: true }))) {
					throw new Error("Could not delete messages");
				}
			} finally {
				lock.release();
			}
			const inboxUnseen = await currentInboxUnseen(client);
			return { uids: targetUids, folder: folder, inboxUnseen, movedUids, trash: toTrash ? trash : undefined };
		});
	},

	// Permanently delete every message in a folder (e.g. empty Trash). Flags all
	// messages as \Deleted and expunges the mailbox.
	expungeFolder: async ({ cookie, body, status }) => {
		const user = await getUser(cookie);
		if (!user?.mailbox || !user?.password)
			return status(401, { success: false, message: "Unauthorized" });
		const { folder } = body;
		return withClient(user, status, async (client) => {
			const lock = await client.getMailboxLock(folder);
			try {
				if (client.mailbox?.exists && !(await client.messageDelete("1:*")))
					throw new Error("Could not empty folder");
			} finally {
				lock.release();
			}
			return { folder: folder };
		});
	},

	// --- send ---
	sendMessage: async ({ cookie, body, status }) => {
		const user = await getUser(cookie);
		if (!user?.mailbox || !user?.password)
			return status(401, { success: false, message: "Unauthorized" });

		const transporter = nodemailer.createTransport({
			host: MAIL_SERVER.smtpHost,
			port: MAIL_SERVER.smtpPort,
			secure: MAIL_SERVER.smtpSecure,
			auth: {
				user: user.mailbox,
				pass: user.password,
			},
		});

		try {
			const files = await composeAttachments(user, body);
			if (files.error) return status(400, { success: false, message: files.error });
			const mail = composeMail(user, body, composeHtml(body), files.attachments);
			// Complete MIME construction before SMTP accepts the message.
			const raw = await new MailComposer(mail).compile().build();
			await transporter.sendMail({ ...mail, raw });
			logger.info(`[MAIL] ${user.mailbox} sent message to ${body.to}`);
			const sentSavingDisabled = process.env.SAVE_SENT === "false";
			let savedToSent = false;
			try {
				savedToSent = await saveToSent(user, raw);
			} catch (err) {
				logger.error(`[MAIL] Sent copy failed: ${err.message}`);
			}
			return { success: true, message: "Sent", data: { savedToSent, sentSavingDisabled } };
		} catch (err) {
			logger.error(`[MAIL] 💥[smtp] ${err.message}`);
			return status(502, { success: false, message: err.message });
		}
	},

	// --- drafts (IMAP Drafts folder) ---
	// Composed exactly like a sent message, but keeps Bcc. The previous copy
	// (`replaces`) is removed only after the new one is stored, and a failure
	// there never fails the save.
	saveDraft: async ({ cookie, body, status }) => {
		const user = await getUser(cookie);
		if (!user?.mailbox || !user?.password)
			return status(401, { success: false, message: "Unauthorized" });
		let raw;
		let messageId;
		try {
			const files = await composeAttachments(user, body);
			if (files.error) return status(400, { success: false, message: files.error });
			const mail = composeMail(user, body, composeHtml(body), files.attachments);
			messageId = mail.messageId; // unique per save: finds the copy without UIDPLUS
			const node = new MailComposer(mail).compile();
			node.keepBcc = true; // the draft copy only; send never keeps Bcc
			raw = await node.build();
		} catch (err) {
			logImapError(err);
			return status(502, { success: false, message: "Mail command failed" });
		}
		return withClient(user, status, async (client) => {
			const folder = await draftsFolder(client, true);
			// imapflow throws when the server answers NO/BAD to APPEND, and
			// resolves to undefined when unauthenticated or without a destination.
			const appended = await client.append(folder, raw, ["\\Draft", "\\Seen"]);
			if (!appended) throw new Error(`Could not save draft to ${folder}`);
			let uid = Number(appended.uid);
			if (!(Number.isInteger(uid) && uid > 0)) uid = await findDraftUid(client, folder, messageId);
			let replaced;
			if (body.replaces) {
				try {
					replaced = await removeDraft(client, folder, body.replaces);
				} catch (err) {
					logImapError(err);
					replaced = false;
				}
			}
			return { uid, folder, replaced };
		});
	},

	// Removes one draft (Drafts folder only, must carry \Draft). Idempotent.
	discardDraft: async ({ cookie, body, status }) => {
		const user = await getUser(cookie);
		if (!user?.mailbox || !user?.password)
			return status(401, { success: false, message: "Unauthorized" });
		return withClient(user, status, async (client) => {
			const folder = await draftsFolder(client, false);
			if (!folder) return { uid: body.uid, removed: false };
			return { uid: body.uid, removed: await removeDraft(client, folder, body.uid), folder };
		});
	},
};
