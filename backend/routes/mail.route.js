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
	.post("/folders/rename", MailService.renameFolder, {
		body: MailModel.renameFolderBody,
		response: {
			200: MailModel.renameFolderResponse,
			400: MailModel.renameFolderResponse,
			404: MailModel.renameFolderResponse,
			409: MailModel.renameFolderResponse,
			502: MailModel.renameFolderResponse,
		},
		detail: {
			summary: "Rename a folder",
			description:
				"Renames a user folder in place (same parent). INBOX and special-use folders are refused (400); 404 when the folder doesn't exist; 409 when the target exists. Filter rules are not rewritten: `filtersAffected` warns when they reference the folder.",
			tags: ["Mail"],
		},
	})
	.post("/folders/delete", MailService.deleteFolder, {
		body: MailModel.deleteFolderBody,
		response: {
			200: MailModel.deleteFolderResponse,
			400: MailModel.deleteFolderResponse,
			404: MailModel.deleteFolderResponse,
			409: MailModel.deleteFolderResponse,
			502: MailModel.deleteFolderResponse,
		},
		detail: {
			summary: "Delete an empty folder",
			description:
				"Deletes a user folder with no messages and no child folders (409 otherwise). INBOX and special-use folders are refused (400). `filtersAffected` warns when filter rules reference it.",
			tags: ["Mail"],
		},
	})
	.get("/messages/:folder", MailService.listMessages, {
		query: MailModel.listMessagesQuery,
		response: MailModel.listMessagesResponse,
		detail: {
			summary: "List messages in a folder",
			description:
				"Paginated envelope listing for a folder (default INBOX). `?snippets=1` adds a `snippet` (start of the body text, at most 140 characters) to each row; best effort, never fails the list.",
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
			description: "Fetches full body (text/html) + flags for one message. 404 when it no longer exists.",
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
		query: t.Object({ inline: t.Optional(t.String()) }),
		detail: {
			summary: "Download an attachment",
			description:
				"Streams one attachment's bytes (also backs inline cid: images). Served as a download with a sandboxing CSP; with `?inline=1`, PNG/JPEG/GIF/WebP are served `inline` (other types ignore the flag).",
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
		response: MailModel.deleteMessageResponse,
		detail: {
			summary: "Delete messages",
			description:
				"Outside Trash: moves to Trash (created if missing) and returns `trash` and, with UIDPLUS, `movedUids`. Inside Trash: flags \\Deleted and expunges (permanent, no `trash`).",
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
	.post("/drafts", MailService.saveDraft, {
		body: MailModel.saveDraftBody,
		response: {
			200: MailModel.saveDraftResponse,
			400: MailModel.saveDraftResponse,
			401: MailModel.saveDraftResponse,
			502: MailModel.saveDraftResponse,
		},
		detail: {
			summary: "Save a draft",
			description:
				"Stores the draft (Bcc kept) in the Drafts folder (created if missing) flagged \\Draft \\Seen. `uid` is returned when the server reports it (UIDPLUS), otherwise looked up by Message-ID on a best-effort basis. With `replaces`, that UID is removed from Drafts after the new copy is stored, only if it is flagged \\Draft; `replaced` says whether it was. `replaced: false` after a successful save means the earlier copy was not removed and may remain (e.g. the mailbox does not keep \\Draft).",
			tags: ["Mail"],
		},
	})
	.post("/drafts/discard", MailService.discardDraft, {
		body: MailModel.discardDraftBody,
		response: {
			200: MailModel.discardDraftResponse,
			401: MailModel.discardDraftResponse,
			502: MailModel.discardDraftResponse,
		},
		detail: {
			summary: "Discard a draft",
			description:
				"Removes one message from the Drafts folder if it is flagged \\Draft. Idempotent: an unknown or non-draft UID answers 200 with `removed: false`.",
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
