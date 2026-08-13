import { t } from "elysia";

const Folder = t.Object({
	path: t.String(),
	name: t.String(),
	delimiter: t.String(),
	specialUse: t.Nullable(t.String()),
	flags: t.Array(t.String()),
	hasChildren: t.Boolean(),
});

const MessageListItem = t.Object({
	uid: t.Integer(),
	subject: t.String(),
	from: t.String(),
	fromName: t.String(),
	date: t.Any(),
	flags: t.Array(t.String()),
	seen: t.Boolean(),
	attachments: t.Integer(),
});

export const MailModel = {
	listFoldersResponse: t.Object({
		success: t.Boolean(),
		message: t.Optional(t.String()),
		data: t.Optional(t.Array(Folder)),
	}),

	listMessagesResponse: t.Object({
		success: t.Boolean(),
		message: t.Optional(t.String()),
		data: t.Optional(
			t.Object({
				messages: t.Array(MessageListItem),
				total: t.Integer(),
				page: t.Integer(),
				pageSize: t.Integer(),
				sort: t.Optional(t.String()),
				search: t.Optional(t.String()),
			}),
		),
	}),

	getMessageResponse: t.Object({
		success: t.Boolean(),
		message: t.Optional(t.String()),
		data: t.Optional(
			t.Object({
				uid: t.Integer(),
				folder: t.String(),
				envelope: t.Any(),
				flags: t.Array(t.String()),
				internalDate: t.Any(),
				subject: t.String(),
				from: t.String(),
				fromName: t.String(),
				to: t.String(),
				replyTo: t.Optional(t.String()),
				date: t.Any(),
				mailedBy: t.Optional(t.String()),
				signedBy: t.Optional(t.String()),
				html: t.String(),
				text: t.String(),
				attachments: t.Array(
					t.Object({
						filename: t.String(),
						contentType: t.String(),
						size: t.Integer(),
						content: t.Optional(t.String()),
						contentId: t.Optional(t.String()),
					}),
				),
			}),
		),
	}),

	setFlagsBody: t.Object({
		folder: t.String(),
		uid: t.Number(),
		flags: t.Array(t.String()),
	}),

	setFlagsResponse: t.Object({
		success: t.Boolean(),
		message: t.Optional(t.String()),
		data: t.Optional(
			t.Object({
				uid: t.Integer(),
				flags: t.Array(t.String()),
			}),
		),
	}),

	clearFlagsBody: t.Object({
		folder: t.String(),
		uid: t.Number(),
		flags: t.Array(t.String()),
	}),

	clearFlagsResponse: t.Object({
		success: t.Boolean(),
		message: t.Optional(t.String()),
		data: t.Optional(
			t.Object({
				uid: t.Integer(),
				flags: t.Array(t.String()),
			}),
		),
	}),

	moveMessageBody: t.Object({
		uid: t.Number(),
		from: t.String(),
		to: t.String(),
	}),

	deleteMessageBody: t.Object({
		uid: t.Number(),
		folder: t.String(),
	}),

	expungeFolderBody: t.Object({
		folder: t.String(),
	}),

	moveMessageResponse: t.Object({
		success: t.Boolean(),
		message: t.Optional(t.String()),
		data: t.Optional(
			t.Object({
				uid: t.Integer(),
				from: t.String(),
				to: t.String(),
			}),
		),
	}),

	sendMessageBody: t.Object({
		to: t.String(),
		cc: t.Optional(t.String()),
		subject: t.Optional(t.String()),
		text: t.Optional(t.String()),
		html: t.Optional(t.String()),
		markdown: t.Optional(t.Boolean()),
		attachments: t.Optional(
			t.Array(
				t.Object({
					filename: t.String(),
					contentType: t.Optional(t.String()),
					content: t.Optional(t.String()), // base64
				}),
			),
		),
	}),

	sendMessageResponse: t.Object({
		success: t.Boolean(),
		message: t.String(),
	}),

	summarizeBody: t.Object({
		text: t.String(),
	}),

	summarizeResponse: t.Object({
		success: t.Boolean(),
		message: t.Optional(t.String()),
		data: t.Optional(
			t.Object({
				summary: t.String(),
			}),
		),
	}),
};