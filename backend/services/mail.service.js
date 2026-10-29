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
import { getDisplayName } from "./profile.service.js";

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

async function withImap(user, fn) {
	const client = buildImapClient(user);
	try {
		await client.connect();
		return await fn(client);
	} finally {
		await client.logout().catch(() => {});
	}
}

async function withClient(user, status, fn) {
	if (!user?.mailbox || !user?.password) {
		return status
			? status(401, { success: false, message: "Unauthorized" })
			: { success: false, message: "Unauthorized" };
	}
	const client = buildImapClient(user);
	try {
		await client.connect();
		const result = await fn(client);
		return { success: true, data: result };
	} catch (err) {
		logImapError(err);
		const body = { success: false, message: "Mail command failed" };
		return status ? status(502, body) : body;
	} finally {
		await client.logout().catch(() => {});
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
	const list = await client.list();
	return (
		list.find((f) => f.specialUse === use) ||
		list.find((f) => namePattern.test(f.name))
	)?.path;
}
const TRASH_NAMES = /^(trash|bin|deleted( items| messages)?)$/i;
const SENT_NAMES = /^sent( items| mail| messages)?$/i;

// Saves a copy of a sent message to the account's Sent folder. Most IMAP
// servers (docker-mailserver/Dovecot included) don't do this on SMTP submit.
// Set SAVE_SENT=false for servers that already do (e.g. Gmail) to avoid dupes.
async function saveToSent(user, raw) {
	if (process.env.SAVE_SENT === "false") return false;
	const client = buildImapClient(user);
	try {
		await client.connect();
		const sent = await findSpecialFolder(client, "\\Sent", SENT_NAMES);
		if (!sent) return false;
		await client.append(sent, raw, ["\\Seen"]);
		return true;
	} catch (err) {
		logImapError(err);
		return false;
	} finally {
		await client.logout().catch(() => {});
	}
}

// Fetches and parses one message's full source (mailparser), or null.
async function fetchParsed(client, folder, uid) {
	await client.mailboxOpen(folder || "INBOX");
	const msg = await client.fetchOne(Number(uid), { source: true }, { uid: true });
	if (!msg) return null;
	return { msg, parsed: await simpleParser(msg.source, { keepCidLinks: true }) };
}

// A single traversal defines the indexes exposed by the message API and used
// for both downloads and forwarding. Do not descend into attached messages.
function attachmentParts(structure) {
	const parts = [];
	function visit(node, related = false) {
		if (!node) return;
		const disposition = String(node.disposition || "").toLowerCase();
		const attached = disposition === "attachment" || disposition === "inline" ||
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
	visit(structure);
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

// Fetch only displayable text parts; attachment bodies are downloaded on demand.
async function loadDisplayBodies(client, uid, structure, attachments) {
	const attachmentIds = new Set(attachments.map((part) => part.part));
	const candidates = { "text/plain": [], "text/html": [] };
	function visit(node) {
		if (!node || attachmentIds.has(node.part)) return;
		const type = String(node.type || "").toLowerCase();
		if (candidates[type] && node.part) candidates[type].push(node.part);
		for (const child of node.childNodes || []) visit(child);
	}
	visit(structure);
	const bodies = { text: "", html: "" };
	let total = 0;
	for (const [type, key] of [["text/plain", "text"], ["text/html", "html"]]) {
		for (const part of candidates[type]) {
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
function contentDisposition(filename) {
	const ascii = filename.replace(/[^\x20-\x7e]|["\\]/g, "_");
	return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
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

	// --- message list (envelope only) ---
	listMessages: async ({ cookie, params, query, status }) => {
		const user = await getUser(cookie);
		if (!user?.mailbox || !user?.password)
			return status(401, { success: false, message: "Unauthorized" });
		const folder = params?.folder;
		const page = Number(query?.page) || 1;
		const pageSizeRaw = Number(query?.pageSize) || 50;
		const size = Math.min(pageSizeRaw, 100);
		const sort = query?.sort || "desc"; // 'asc' | 'desc' by date
		const search = (query?.search || "").trim();

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
					const uids = await client.search({ text: search }, { uid: true });
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
		return withClient(user, status, async (client) => {
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
			const hdrs = parsed?.headers || {};
			const replyTo =
				parsed?.replyTo?.text ||
				"" ||
				(hdrs.get?.("reply-to")?.[0]?.value ?? "");
			const mailedBy =
				(hdrs.get?.("x-mailer")?.[0]?.value ?? "") ||
				(hdrs.get?.("user-agent")?.[0]?.value ?? "");
			const signedBy = hdrs.get?.("x-dkim-signature")
				? (() => {
						const raw = hdrs.get("x-dkim-signature")?.[0]?.value || "";
						const m = raw.match(/d=([^\s;]+)/i);
						return m ? m[1] : "";
					})()
				: "";

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
				replyTo: replyTo || "",
				messageId: parsed?.messageId || undefined,
				references: [parsed?.references || []].flat().join(" ") || undefined,
				addresses: {
					from: addressList(parsed?.from),
					replyTo: addressList(parsed?.replyTo),
					to: addressList(parsed?.to),
					cc: addressList(parsed?.cc),
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

			const ids = [
				...new Set(
					[p.messageId, p.inReplyTo, ...[p.references || []].flat()].filter(Boolean),
				),
			].slice(-25); // bound the search on very long threads
			const terms = [
				...ids.map((id) => ({ header: { "message-id": id } })),
				{ header: { references: p.messageId } },
			];
			const query = terms.length > 1 ? { or: terms } : terms[0];

			const sent = await findSpecialFolder(client, "\\Sent", SENT_NAMES);
			const boxes = [...new Set(["INBOX", folder, sent].filter(Boolean))];
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
	getAttachment: async ({ cookie, params, status }) => {
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

	// --- set flags (read/unread/delete) ---
	setFlags: async ({ cookie, body, status }) => {
		const user = await getUser(cookie);
		if (!user?.mailbox || !user?.password)
			return status(401, { success: false, message: "Unauthorized" });
		const { folder, uids, flags } = body;
		return withClient(user, status, async (client) => {
			const lock = await client.getMailboxLock(folder);
			try { await client.messageFlagsAdd(uids, flags, { uid: true }); }
			finally { lock.release(); }
			// Piggyback fresh INBOX unseen on the same connection (no extra
			// request from the client).
			let inboxUnseen;
			try {
				const s = await client.status("INBOX", { unseen: true });
				inboxUnseen = Number(s?.unseen) || 0;
			} catch {
				// leave undefined — client keeps its current badge
			}
			return { uids: uids, flags: flags, inboxUnseen };
		});
	},

	clearFlags: async ({ cookie, body, status }) => {
		const user = await getUser(cookie);
		if (!user?.mailbox || !user?.password)
			return status(401, { success: false, message: "Unauthorized" });
		const { folder, uids, flags } = body;
		return withClient(user, status, async (client) => {
			const lock = await client.getMailboxLock(folder);
			try { await client.messageFlagsRemove(uids, flags, { uid: true }); }
			finally { lock.release(); }
			// Piggyback fresh INBOX unseen on the same connection.
			let inboxUnseen;
			try {
				const s = await client.status("INBOX", { unseen: true });
				inboxUnseen = Number(s?.unseen) || 0;
			} catch {
				// leave undefined — client keeps its current badge
			}
			return { uids: uids, flags: flags, inboxUnseen };
		});
	},

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
				movedUids = destinationUids(
					await client.messageMove(targetUids, to, { uid: true }),
				);
			} finally {
				lock.release();
			}
			// Piggyback fresh INBOX unseen on the same connection.
			let inboxUnseen;
			try {
				const s = await client.status("INBOX", { unseen: true });
				inboxUnseen = Number(s?.unseen) || 0;
			} catch {
				// leave undefined — client keeps its current badge
			}
			return { uids: targetUids, from: from, to: to, inboxUnseen, movedUids };
		});
	},

	// Permanently delete a single message: flag \Deleted then expunge it from the
	// mailbox. Used when deleting from Trash — the message is removed for good.
	deleteMessage: async ({ cookie, body, status }) => {
		const user = await getUser(cookie);
		if (!user?.mailbox || !user?.password)
			return status(401, { success: false, message: "Unauthorized" });
		const { uids, folder } = body;
		const targetUids = Array.isArray(uids) ? uids.map(Number) : uids;
		return withClient(user, status, async (client) => {
			// Outside Trash a delete is a move to Trash; inside it, permanent.
			const trash =
				(await findSpecialFolder(client, "\\Trash", TRASH_NAMES)) || "Trash";
			const lock = await client.getMailboxLock(folder);
			try {
				if (folder !== trash) {
					await client.messageMove(targetUids, trash, { uid: true });
				} else {
					await client.messageDelete(targetUids, { uid: true });
				}
			} finally {
				lock.release();
			}
			// Piggyback fresh INBOX unseen on the same connection.
			let inboxUnseen;
			try {
				const s = await client.status("INBOX", { unseen: true });
				inboxUnseen = Number(s?.unseen) || 0;
			} catch {
				// leave undefined — client keeps its current badge
			}
			return { uids: targetUids, folder: folder, inboxUnseen };
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
				if (client.mailbox?.exists) await client.messageDelete("1:*");
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
			// If the sender used markdown and no explicit html was provided,
			// convert markdown → HTML so the reader can render it nicely.
			let html = body.html;
			if (body.markdown && !html && body.text) {
				try {
					// Convert markdown → HTML, then sanitize so any markdown-embedded
					// HTML/scripts can't execute in recipients' mail clients.
					html = sanitizeHtml(marked.parse(body.text));
				} catch {
					html = undefined;
				}
			}

			// Build nodemailer attachments from base64 payloads.
			const attachments = (body.attachments || []).map((a) => ({
				filename: a.filename,
				contentType: a.contentType || "application/octet-stream",
				content: Buffer.from(a.content || "", "base64"),
			}));

			// Forwarded attachments are copied from the original message here,
			// so the browser never has to download and re-upload them.
			const fwd = body.forwardAttachments;
			if (fwd?.indexes?.length) {
				if (fwd.indexes.length > 100) return status(400, { success: false, message: "Too many forwarded attachments" });
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
				if (!forwarded) return status(400, { success: false, message: "Forwarded attachment not found" });
				attachments.push(...forwarded);
			}

			const domain = user.mailbox.split("@")[1] || "localhost";
			const mail = {
				from: {
					name: getDisplayName(user.mailbox) || user.mailbox,
					address: user.mailbox,
				},
				to: body.to,
				cc: body.cc || undefined,
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
};
