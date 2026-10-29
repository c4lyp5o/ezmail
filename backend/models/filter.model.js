import { t } from "elysia";

// One Gmail-style filter rule: messages where <field> <match> <value>
// are filed into <folder> by Dovecot Sieve at delivery time.
const FilterRule = t.Object({
	field: t.Union([t.Literal("from"), t.Literal("subject"), t.Literal("to")]),
	match: t.Union([t.Literal("contains"), t.Literal("is")]),
	value: t.String({ minLength: 1, maxLength: 256 }),
	folder: t.String({ minLength: 1, maxLength: 64 }),
});

export const FilterModel = {
	getResponse: t.Object({
		success: t.Boolean(),
		message: t.Optional(t.String()),
		data: t.Optional(
			t.Object({
				mailbox: t.String(),
				enabled: t.Boolean(),
				rules: t.Array(FilterRule),
				sieveSource: t.Optional(t.String()),
				conflict: t.Optional(t.Boolean()),
				mode: t.Optional(t.Union([t.Literal("sieve"), t.Literal("imap"), t.Literal("unavailable")])),
				lastError: t.Optional(t.String()),
				lastCheck: t.Optional(t.Number()),
			}),
		),
	}),

	putBody: t.Object({
		rules: t.Array(FilterRule, { maxItems: 50 }),
		enabled: t.Boolean(),
		mode: t.Optional(t.Union([t.Literal("sieve"), t.Literal("imap")])),
	}),

	putResponse: t.Object({
		success: t.Boolean(),
		message: t.Optional(t.String()),
		data: t.Optional(
			t.Object({
				ruleCount: t.Integer(),
				enabled: t.Boolean(),
			}),
		),
	}),

	deleteResponse: t.Object({
		success: t.Boolean(),
		message: t.Optional(t.String()),
		data: t.Optional(t.Object({ removed: t.Boolean() })),
	}),
};
