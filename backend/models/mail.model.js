import { t } from "elysia";

const uidArray = t.Array(t.Union([t.Number(), t.String()]));

const Folder = t.Object({
	path: t.String(),
	name: t.String(),
	delimiter: t.String(),
	specialUse: t.Nullable(t.String()),
	flags: t.Array(t.String()),
	hasChildren: t.Boolean(),
	unread: t.Optional(t.Integer()),
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
	// Start of the body text; only with ?snippets=1, and absent when unavailable.
	snippet: t.Optional(t.String()),
});

export const MailModel = {
	listFoldersResponse: t.Object({
		success: t.Boolean(),
		message: t.Optional(t.String()),
		data: t.Optional(t.Array(Folder)),
	}),

	listMessagesQuery: t.Object({
		page: t.Optional(t.String()),
		pageSize: t.Optional(t.String()),
		sort: t.Optional(t.String()),
		search: t.Optional(t.String()),
		// "1" adds `snippet` to each row (one partial fetch per distinct body part).
		snippets: t.Optional(t.String()),
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
				cc: t.Optional(t.String()),
				// Only present when the stored message keeps a Bcc header (drafts).
				bcc: t.Optional(t.String()),
				replyTo: t.Optional(t.String()),
				messageId: t.Optional(t.String()),
				inReplyTo: t.Optional(t.String()),
				references: t.Optional(t.String()),
				// Bare addresses for building reply / reply-all recipients.
				addresses: t.Optional(
					t.Object({
						from: t.Array(t.String()),
						replyTo: t.Array(t.String()),
						to: t.Array(t.String()),
						cc: t.Array(t.String()),
						bcc: t.Optional(t.Array(t.String())),
					}),
				),
				date: t.Any(),
				mailedBy: t.Optional(t.String()),
				signedBy: t.Optional(t.String()),
				html: t.String(),
				text: t.String(),
				attachments: t.Array(
					t.Object({
						index: t.Integer(),
						filename: t.String(),
						contentType: t.String(),
						size: t.Integer(),
						contentId: t.Optional(t.String()),
						// inline part referenced from the HTML (cid:)
						related: t.Boolean(),
					}),
				),
			}),
		),
	}),

	setFlagsBody: t.Object({
		folder: t.String(),
		uids: uidArray,
		flags: t.Array(t.String()),
	}),

	setFlagsResponse: t.Object({
		success: t.Boolean(),
		message: t.Optional(t.String()),
		data: t.Optional(
			t.Object({
				uids: uidArray,
				flags: t.Array(t.String()),
				inboxUnseen: t.Optional(t.Integer()),
			}),
		),
	}),

	clearFlagsBody: t.Object({
		folder: t.String(),
		uids: uidArray,
		flags: t.Array(t.String()),
	}),

	clearFlagsResponse: t.Object({
		success: t.Boolean(),
		message: t.Optional(t.String()),
		data: t.Optional(
			t.Object({
				uids: uidArray,
				flags: t.Array(t.String()),
				inboxUnseen: t.Optional(t.Integer()),
			}),
		),
	}),

	moveMessageBody: t.Object({
		uids: uidArray,
		from: t.String({ minLength: 1 }),
		to: t.String({ minLength: 1 }),
	}),

	moveMessageResponse: t.Object({
		success: t.Boolean(),
		message: t.Optional(t.String()),
		data: t.Optional(
			t.Object({
				uids: uidArray,
				from: t.String(),
				to: t.String(),
				inboxUnseen: t.Optional(t.Integer()),
				// Destination UIDs (UIDPLUS) — lets the client undo the move.
				movedUids: t.Optional(t.Array(t.Integer())),
			}),
		),
	}),

	deleteMessageBody: t.Object({
		uids: uidArray,
		folder: t.String(),
	}),

	deleteMessageResponse: t.Object({
		success: t.Boolean(),
		message: t.Optional(t.String()),
		data: t.Optional(
			t.Object({
				uids: uidArray,
				folder: t.String(),
				inboxUnseen: t.Optional(t.Integer()),
				// Destination UIDs in Trash (UIDPLUS); only on a move to Trash.
				movedUids: t.Optional(t.Array(t.Integer())),
				// Trash path the messages were moved to; absent for a permanent delete.
				trash: t.Optional(t.String()),
			}),
		),
	}),

	createFolderBody: t.Object({
		name: t.String({ minLength: 1, maxLength: 64 }),
	}),

	createFolderResponse: t.Object({
		success: t.Boolean(),
		message: t.Optional(t.String()),
		data: t.Optional(t.Object({ path: t.String() })),
	}),

	renameFolderBody: t.Object({
		path: t.String({ minLength: 1 }),
		newName: t.String({ minLength: 1, maxLength: 64 }),
	}),

	renameFolderResponse: t.Object({
		success: t.Boolean(),
		message: t.Optional(t.String()),
		data: t.Optional(
			t.Object({
				path: t.String(),
				newPath: t.String(),
				// Saved filter rules target this folder (or a child); undefined when unknown.
				filtersAffected: t.Optional(t.Boolean()),
			}),
		),
	}),

	deleteFolderBody: t.Object({
		path: t.String({ minLength: 1 }),
	}),

	deleteFolderResponse: t.Object({
		success: t.Boolean(),
		message: t.Optional(t.String()),
		data: t.Optional(
			t.Object({
				path: t.String(),
				filtersAffected: t.Optional(t.Boolean()),
			}),
		),
	}),

	expungeFolderBody: t.Object({
		folder: t.String(),
	}),

	expungeFolderResponse: t.Object({
		success: t.Boolean(),
		message: t.Optional(t.String()),
		data: t.Optional(
			t.Object({
				folder: t.String(),
			}),
		),
	}),

	sendMessageBody: t.Object({
		to: t.String(),
		cc: t.Optional(t.String()),
		bcc: t.Optional(t.String()),
		subject: t.Optional(t.String()),
		text: t.Optional(t.String()),
		html: t.Optional(t.String()),
		markdown: t.Optional(t.Boolean()),
		inReplyTo: t.Optional(t.String()),
		references: t.Optional(t.String()),
		// Attachments of an existing message to include (forwarding).
		forwardAttachments: t.Optional(
			t.Object({
				folder: t.String(),
				uid: t.Union([t.Integer(), t.String()]),
				indexes: t.Array(t.Integer()),
			}),
		),
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
		data: t.Optional(t.Object({ savedToSent: t.Boolean(), sentSavingDisabled: t.Optional(t.Boolean()) })),
	}),

	threadResponse: t.Object({
		success: t.Boolean(),
		message: t.Optional(t.String()),
		data: t.Optional(
			t.Array(
				t.Object({
					folder: t.String(),
					uid: t.Integer(),
					subject: t.String(),
					from: t.String(),
					fromName: t.String(),
					date: t.Any(),
					seen: t.Boolean(),
				}),
			),
		),
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

// Server-side drafts (IMAP Drafts folder). The body is the send body with every
// field optional (a draft may be half-written) plus the draft it replaces.
MailModel.saveDraftBody = t.Object({
	...MailModel.sendMessageBody.properties,
	to: t.Optional(t.String()),
	// UID of the previous copy in Drafts, removed only after the new one is stored.
	replaces: t.Optional(t.Integer({ minimum: 1, maximum: 4294967295 })),
});

MailModel.saveDraftResponse = t.Object({
	success: t.Boolean(),
	message: t.Optional(t.String()),
	data: t.Optional(
		t.Object({
			// New draft UID when the server reports it (UIDPLUS APPENDUID).
			uid: t.Optional(t.Integer()),
			folder: t.String(),
			// Only with `replaces`: whether the previous draft was removed.
			replaced: t.Optional(t.Boolean()),
		}),
	),
});

MailModel.discardDraftBody = t.Object({
	uid: t.Integer({ minimum: 1, maximum: 4294967295 }),
});

MailModel.discardDraftResponse = t.Object({
	success: t.Boolean(),
	message: t.Optional(t.String()),
	data: t.Optional(
		t.Object({
			uid: t.Integer(),
			removed: t.Boolean(),
			folder: t.Optional(t.String()),
		}),
	),
});
