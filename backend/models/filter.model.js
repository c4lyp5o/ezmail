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
			}),
		),
	}),

	putBody: t.Object({
		rules: t.Array(FilterRule, { maxItems: 50 }),
		enabled: t.Boolean(),
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
