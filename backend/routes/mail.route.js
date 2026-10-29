import { Elysia, t } from "elysia";
import { MailModel } from "../models/mail.model.js";
import { MailService } from "../services/mail.service.js";
import { summarizeText } from "../services/llm.service.js";
import { PushService } from "../services/push.service.js";

export const MailRoutes = new Elysia({ prefix: "/api/v1/mail" })
	.get("/events", PushService.events, {
		detail: {
			summary: "Live mailbox events (SSE)",
			description:
				"Server-Sent Events fed by IMAP IDLE on INBOX: {type: ready|new|changed|closed|error}. Hints only — clients refetch.",
			tags: ["Mail"],
		},
	})
	.get("/folders", MailService.listFolders, {
		response: MailModel.listFoldersResponse,
		detail: {
			summary: "List mail folders",
			description: "Lists all IMAP folders/mailboxes for the account.",
			tags: ["Mail"],
		},
	})
	.post("/folders", MailService.createFolder, {
		body: MailModel.createFolderBody,
		response: {
			200: MailModel.createFolderResponse,
			400: MailModel.createFolderResponse,
			409: MailModel.createFolderResponse,
			502: MailModel.createFolderResponse,
		},
		detail: {
			summary: "Create a folder",
			description:
				"Creates a top-level folder. Names use letters, numbers, spaces, dashes and underscores so filters can target them. 409 when it already exists.",
			tags: ["Mail"],
		},
	})
	.get("/messages/:folder", MailService.listMessages, {
		response: MailModel.listMessagesResponse,
		detail: {
			summary: "List messages in a folder",
			description: "Paginated envelope listing for a folder (default INBOX).",
			tags: ["Mail"],
		},
	})
	.get("/message/:folder/:uid", MailService.getMessage, {
		params: t.Object({
			folder: t.String(),
			uid: t.String(),
		}),
		response: MailModel.getMessageResponse,
		detail: {
			summary: "Get a single message",
			description: "Fetches full body (text/html) + flags for one message.",
			tags: ["Mail"],
		},
	})
	.get("/message/:folder/:uid/thread", MailService.getThread, {
		params: t.Object({ folder: t.String(), uid: t.String() }),
		response: MailModel.threadResponse,
		detail: {
			summary: "Conversation for a message",
			description:
				"Messages in INBOX and Sent linked to this one by Message-ID / References / In-Reply-To, oldest first (includes the message itself).",
			tags: ["Mail"],
		},
	})
	.get("/message/:folder/:uid/attachment/:index", MailService.getAttachment, {
		params: t.Object({
			folder: t.String(),
			uid: t.String(),
			index: t.String(),
		}),
		detail: {
			summary: "Download an attachment",
			description:
				"Streams one attachment's bytes (also backs inline cid: images). Always served as a download with a sandboxing CSP.",
			tags: ["Mail"],
		},
	})
	.post("/flags", MailService.setFlags, {
		body: MailModel.setFlagsBody,
		response: MailModel.setFlagsResponse,
		detail: {
			summary: "Set message flags",
			description: "Adds flags (e.g. \\Seen, \\Flagged) to a message by UID.",
			tags: ["Mail"],
		},
	})
	.post("/unflag", MailService.clearFlags, {
		body: MailModel.clearFlagsBody,
		response: MailModel.clearFlagsResponse,
		detail: {
			summary: "Clear message flags",
			description: "Removes flags from a message by UID.",
			tags: ["Mail"],
		},
	})
	.post("/move", MailService.moveMessage, {
		body: MailModel.moveMessageBody,
		response: MailModel.moveMessageResponse,
		detail: {
			summary: "Move a message",
			description: "Moves a message between folders by UID.",
			tags: ["Mail"],
		},
	})
	.post("/delete", MailService.deleteMessage, {
		body: MailModel.deleteMessageBody,
		detail: {
			summary: "Permanently delete a message",
			description:
				"Flags a message as \\Deleted and expunges it from the folder (permanent, used on Trash items).",
			tags: ["Mail"],
		},
	})
	.post("/expunge", MailService.expungeFolder, {
		body: MailModel.expungeFolderBody,
		detail: {
			summary: "Empty a folder permanently",
			description:
				"Flags every message in the folder as \\Deleted and expunges the mailbox (delete-all).",
			tags: ["Mail"],
		},
	})
	.post("/send", MailService.sendMessage, {
		body: MailModel.sendMessageBody,
		response: MailModel.sendMessageResponse,
		detail: {
			summary: "Send an email",
			description: "Sends an email via SMTP.",
			tags: ["Mail"],
		},
	})
	.post(
		"/summarize",
		async ({ body }) => {
			const result = await summarizeText(body?.text);
			return result;
		},
		{
			body: MailModel.summarizeBody,
			response: MailModel.summarizeResponse,
			detail: {
				summary: "Summarize an email",
				description: "Summarizes message text via the configured local LLM.",
				tags: ["Mail"],
			},
		},
	);
