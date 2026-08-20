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

export const MailService = {
	// --- folders ---
	listFolders: async ({ jwt, cookie, status }) => {
		const user = await getUser(jwt, cookie);
		if (!user?.mailbox || !user?.password) return status(401, { success: false, message: "Unauthorized" });
		return withClient(user, status, async (client) => {
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
  listMessages: async ({ jwt, cookie, params, query, status }) => {
    const user = await getUser(jwt, cookie);
		if (!user?.mailbox || !user?.password) return status(401, { success: false, message: "Unauthorized" });
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
            return { messages: [], total: 0, page, pageSize: size, sort, search };
          }
        }

        // 4. Fetch candidate messages
        const all = [];
        if (searchUids) {
          const uidList = [...searchUids].sort((a, b) => a - b);
          for await (const msg of client.fetch(
            uidList,
            { envelope: true, flags: true, internalDate: true, bodyStructure: true, source: false },
            { uid: true }
          )) {
            all.push(msg);
          }
        } else {
          // Safe to call "1:*" because client.mailbox.exists > 0
          for await (const msg of client.fetch(
            "1:*",
            { envelope: true, flags: true, internalDate: true, bodyStructure: true, source: false },
            { uid: false }
          )) {
            all.push(msg);
          }
        }

        // 5. Sort by date
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
      } finally {
        // 6. Always release the lock
        lock.release();
      }
    });
  },

	// --- single message full body + flags ---
	getMessage: async ({ jwt, cookie, params, status }) => {
		const user = await getUser(jwt, cookie);
		if (!user?.mailbox || !user?.password) return status(401, { success: false, message: "Unauthorized" });
		const { folder, uid } = params;
		return withClient(user, status, async (client) => {
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
	setFlags: async ({ jwt, cookie, body, status }) => {
		const user = await getUser(jwt, cookie);
		if (!user?.mailbox || !user?.password) return status(401, { success: false, message: "Unauthorized" });
		const { folder, uids, flags } = body;
		return withClient(user, status, async (client) => {
      const lock = await client.getMailboxLock(folder);
			await client.messageFlagsAdd(uids, flags, { uid: true });
      lock.release();
			return { uids: uids, flags: flags };
		});
	},

	clearFlags: async ({ jwt, cookie, body, status }) => {
		const user = await getUser(jwt, cookie);
		if (!user?.mailbox || !user?.password) return status(401, { success: false, message: "Unauthorized" });
		const { folder, uids, flags } = body;
		return withClient(user, status, async (client) => {
      const lock = await client.getMailboxLock(folder);
			await client.messageFlagsRemove(uids, flags, { uid: true });
      lock.release();
			return { uids: uids, flags: flags };
		});
	},

	// --- move message ---
	moveMessage: async ({ jwt, cookie, body, status }) => {
		const user = await getUser(jwt, cookie);
		if (!user?.mailbox || !user?.password) return status(401, { success: false, message: "Unauthorized" });
		const { uids, from, to } = body;
		const targetUids = Array.isArray(uids) ? uids.map(Number) : uids;
		return withClient(user, status, async (client) => {
      const lock = await client.getMailboxLock(from);
			await client.messageMove(targetUids, to, { uid: true });
      lock.release();
			return { uids: targetUids, from: from, to: to };
		});
	},

	// Permanently delete a single message: flag \Deleted then expunge it from the
	// mailbox. Used when deleting from Trash — the message is removed for good.
	deleteMessage: async ({ jwt, cookie, body, status }) => {
		const user = await getUser(jwt, cookie);
		if (!user?.mailbox || !user?.password) return status(401, { success: false, message: "Unauthorized" });
		const { uids, folder } = body;
    const targetUids = Array.isArray(uids) ? uids.map(Number) : uids;
		return withClient(user, status, async (client) => {
      const lock = await client.getMailboxLock(folder);
      if (folder !== "Trash") {
        await client.messageMove(targetUids, "Trash", { uid: true });
      } else {
        await client.messageDelete(targetUids, { uid: true });
      }
      lock.release();
      return { success: true, data: { uids: targetUids, folder: folder } };
		});
	},

	// Permanently delete every message in a folder (e.g. empty Trash). Flags all
	// messages as \Deleted and expunges the mailbox.
	expungeFolder: async ({ jwt, cookie, body, status }) => {
		const user = await getUser(jwt, cookie);
		if (!user?.mailbox || !user?.password) return status(401, { success: false, message: "Unauthorized" });
		const { folder } = body;
		return withClient(user, status, async (client) => {
      const lock = await client.getMailboxLock(folder);
			await client.messageDelete("1:*");
      lock.release();
			return { success: true, data: { folder: folder } };
		});
	},

	// --- send ---
	sendMessage: async ({ jwt, cookie, body, status }) => {
		const user = await getUser(jwt, cookie);
    if (!user?.mailbox || !user?.password) return status(401, { success: false, message: "Unauthorized" });

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