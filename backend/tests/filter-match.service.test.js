import { describe, expect, test } from "bun:test";
import { firstMatchingFilter, matchFilter } from "../services/filter-match.service.js";

describe("fallback filter matching", () => {
	const envelope = { subject: "Your INVOICE", from: [{ name: "Finance", address: "Billing@Example.com" }], to: [{ group: [{ address: "Team@example.com" }] }] };
	test("matches subjects and mailbox addresses with ASCII case folding", () => {
		expect(matchFilter({ field: "subject", match: "contains", value: "invoice" }, envelope)).toBe(true);
		expect(matchFilter({ field: "from", match: "is", value: "billing@example.com" }, envelope)).toBe(true);
		expect(matchFilter({ field: "from", match: "contains", value: "Finance" }, envelope)).toBe(false);
		expect(matchFilter({ field: "to", match: "is", value: "team@example.com" }, envelope)).toBe(true);
	});
	test("only the first matching rule is selected", () => {
		const rules = [{ field: "subject", match: "contains", value: "invoice", folder: "Bills" }, { field: "from", match: "contains", value: "example", folder: "Other" }];
		expect(firstMatchingFilter(rules, envelope)).toBe(rules[0]);
		expect(firstMatchingFilter(rules, { subject: "hello" })).toBeUndefined();
	});
});
