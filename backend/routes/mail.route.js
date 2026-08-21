import { Elysia, t } from "elysia";
import { MailModel } from "../models/mail.model.js";
import { MailService } from "../services/mail.service.js";
import { summarizeText } from "../services/llm.service.js";

export const MailRoutes = new Elysia({ prefix: "/api/v1/mail" })
	.get("/folders", MailService.listFolders, {
		response: MailModel.listFoldersResponse,
		detail: {
			summary: "List mail folders",
			description: "Lists all IMAP folders/mailboxes for the account.",
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
