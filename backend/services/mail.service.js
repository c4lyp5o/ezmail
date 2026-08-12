import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import { simpleParser } from "mailparser";
import { marked } from "marked";
import sanitizeHtml from "sanitize-html";
import { MAIL_SERVER } from "../config.js";
import { getUser } from "../plugins/auth.plugin.js";
import { generalLogger as logger } from "../logger.js";

// Builds an IMAP client bound to the authenticated user's mailbox. No global
// account — the credentials come from the JWT (issued only after IMAP auth).
function buildImapClient({ mailbox, password }) {
	return new ImapFlow({
		host: MAIL_SERVER.imapHost,
		port: MAIL_SERVER.imapPort,
		secure: MAIL_SERVER.imapSecure,
		auth: {
			user: mailbox,
			pass: password,
		},
		logger: false,
	});
}

async function withClient(user, fn) {
	if (!user?.mailbox || !user?.password) {
		return { success: false, message: "Unauthorized" };
	}
	const client = buildImapClient(user);
	try {
		await client.connect();
		const result = await fn(client);
		return { success: true, data: result };
	} catch (err) {
		logImapError(err);
		return { success: false, message: "Mail command failed" };
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
			logger.error(`[MAIL] 💥[imap] full response: ${JSON.stringify(err.response)}`);
		}
	}
}

export const MailService = {
	// --- folders ---
	listFolders: async ({ jwt, cookie }) => {
		const user = await getUser(jwt, cookie);
		return withClient(user, async (client) => {
			const list = await client.list();
			return list
				.filter((f) => f.path !== "[Gmail]")
				.map((f) => ({
					path: f.path,
					name: f.name,
					delimiter: f.delimiter == null ? "/" : String(f.delimiter),
					specialUse: f.specialUse || null,
					flags: toFlagsArray(f.flags),
					hasChildren: !!f.hasChildren,
				}));
		});
	},

	// --- message list (envelope only) ---
	listMessages: async ({ jwt, cookie, params, query }) => {
		const user = await getUser(jwt, cookie);
		const folder = params?.folder;
		const page = Number(query?.page) || 1;
		const pageSizeRaw = Number(query?.pageSize) || 50;
		const size = Math.min(pageSizeRaw, 100);
		const sort = query?.sort || "desc"; // 'asc' | 'desc' by date
		const search = (query?.search || "").trim();
		return withClient(user, async (client) => {
			const mailbox = await client.mailboxOpen(folder || "INBOX");

			// If a search term is present, run a server-side SEARCH and restrict
			// to those UIDs (matches subject, from, body text).
			let searchUids = null;
			if (search) {
				const uids = await client.search({ text: search }, { uid: true });
				if (Array.isArray(uids) && uids.length) searchUids = new Set(uids);
				else return { messages: [], total: 0, page, pageSize: size, sort, search };
			}

			// Collect ALL candidate messages (search-filtered or whole folder).
			// We fetch the envelope+date for the whole (filtered) set so we can
			// sort by date authoritatively and paginate correctly.
			const all = [];
			if (searchUids) {
				const uidList = [...searchUids].sort((a, b) => a - b);
				for await (const msg of client.fetch(uidList, { envelope: true, flags: true, internalDate: true, bodyStructure: true, source: false }, { uid: true })) {
					all.push(msg);
				}
			} else {
				for await (const msg of client.fetch("1:*", { envelope: true, flags: true, internalDate: true, bodyStructure: true, source: false }, { uid: false })) {
					all.push(msg);
				}
			}

			// Sort by date (internalDate/date) asc or desc.
			all.sort((a, b) => {
				const da = new Date(a.internalDate || a.date || 0).getTime();
				const db = new Date(b.internalDate || b.date || 0).getTime();
				return sort === "asc" ? da - db : db - da;
			});

			const total = all.length;
			const from = (page - 1) * size;
			const pageItems = all.slice(from, from + size);
			const messages = pageItems.map((msg) => mapEnvelope(msg));

			return { messages, total, page, pageSize: size, sort, search };
		});
	},

	// --- single message full body + flags ---
	getMessage: async ({ jwt, cookie, params }) => {
		const user = await getUser(jwt, cookie);
		const { folder, uid } = params;
		return withClient(user, async (client) => {
			await client.mailboxOpen(folder || "INBOX");
			const msg = await client.fetchOne(
				Number(uid),
				{
					envelope: true,
					flags: true,
					internalDate: true,
					source: true,
				},
				{ uid: true },
			);

			if (!msg) {
				logger.warn(`[MAIL] fetchOne returned null for uid=${uid} folder=${folder}`);
				return null;
			}

			// Parse the raw source with mailparser: handles multipart,
			// quoted-printable/base64, HTML+text alternatives, attachments.
			let parsed;
			try {
				parsed = await simpleParser(msg.source);
			} catch (err) {
				logger.error(`[MAIL] 💥[parse] ${err.message}`);
				parsed = null;
			}

			const attachments = (parsed?.attachments || [])
				.map((a) => {
					const buf = a.content ? Buffer.from(a.content) : null;
					return {
						filename: a.filename || "attachment",
						contentType: a.contentType || "application/octet-stream",
						size: a.size || buf?.length || 0,
						content: buf ? buf.toString("base64") : "",
						contentId: a.contentId || undefined,
					};
				});

			// Extra display headers for the toggleable detail panel.
			const hdrs = parsed?.headers || {};
			const replyTo =
				(parsed?.replyTo?.text || "") ||
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
				from: parsed?.from?.text || msg.envelope?.from?.[0]?.address || "unknown",
				fromName: parsed?.from?.value?.[0]?.name || "",
				to: parsed?.to?.text || "",
				replyTo: replyTo || "",
				date: parsed?.date || msg.internalDate,
				mailedBy,
				signedBy,
				html: parsed?.html || "",
				text: parsed?.text || "",
				attachments,
			};
		});
	},

	// --- set flags (read/unread/delete) ---
	setFlags: async ({ jwt, cookie, body }) => {
		const user = await getUser(jwt, cookie);
		const { folder, uid, flags } = body;
		return withClient(user, async (client) => {
			await client.mailboxOpen(folder || "INBOX");
			await client.messageFlagsAdd(Number(uid), flags, { uid: true });
			return { uid: Number(uid), flags };
		});
	},

	clearFlags: async ({ jwt, cookie, body }) => {
		const user = await getUser(jwt, cookie);
		const { folder, uid, flags } = body;
		return withClient(user, async (client) => {
			await client.mailboxOpen(folder || "INBOX");
			await client.messageFlagsRemove(Number(uid), flags, { uid: true });
			return { uid: Number(uid), flags };
		});
	},

	// --- move message ---
	moveMessage: async ({ jwt, cookie, body }) => {
		const user = await getUser(jwt, cookie);
		const { uid, from, to } = body;
		return withClient(user, async (client) => {
			// Must open the source mailbox BEFORE moving — imapflow's messageMove
			// operates on the currently-selected mailbox. Without this, no mailbox
			// is selected on a fresh connection and the MOVE matches nothing.
			await client.mailboxOpen(from || "INBOX");
			await client.messageMove(Number(uid), to, { uid: true });
			return { uid: Number(uid), from: from || "INBOX", to };
		});
	},

	// --- send ---
	sendMessage: async ({ jwt, cookie, body }) => {
		const user = await getUser(jwt, cookie);
		if (!user?.mailbox || !user?.password) {
			return { success: false, message: "Unauthorized" };
		}

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

			await transporter.sendMail({
				from: `"${body.fromName || user.mailbox}" <${user.mailbox}>`,
				to: body.to,
				cc: body.cc || undefined,
				subject: body.subject || "",
				text: body.text || "",
				html: html || undefined,
				attachments: attachments.length ? attachments : undefined,
			});
			logger.info(`[MAIL] ${user.mailbox} sent message to ${body.to}`);
			return { success: true, message: "Sent" };
		} catch (err) {
			logger.error(`[MAIL] 💥[smtp] ${err.message}`);
			return { success: false, message: err.message };
		}
	},
};

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
		attachments: countAttachments(msg.bodyStructure),
	};
}

// imapflow's bodyStructure nests parts in childNodes; attachments carry a
// disposition of "attachment"/"inline". Count them recursively.
function countAttachments(bs) {
	let count = 0;
	const walk = (n) => {
		if (!n) return;
		if (n.disposition && /attachment|inline/i.test(n.disposition)) count++;
		(n.childNodes || []).forEach(walk);
	};
	walk(bs?.childNodes ? { childNodes: bs.childNodes } : null);
	return count;
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