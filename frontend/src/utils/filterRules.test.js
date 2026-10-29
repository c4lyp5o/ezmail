import { expect, test } from "vitest";
import { describeRule, ruleMatches } from "./filterRules.js";

const rule = (over) => ({ field: "from", match: "contains", value: "example.com", folder: "Bills", ...over });

test("sender and recipient match addresses, not display names", () => {
	expect(ruleMatches(rule(), { from: "Ann <ann@Example.com>" })).toBe(true);
	expect(ruleMatches(rule({ value: "ann" }), { from: "Ann Example <bob@x.io>" })).toBe(false);
	expect(ruleMatches(rule({ field: "to", match: "is", value: "b@x.io" }), { to: "a@x.io, B@x.io" })).toBe(true);
});

test("incomplete rules and empty samples never match", () => {
	expect(ruleMatches(rule({ folder: "" }), { from: "a@example.com" })).toBe(false);
	expect(ruleMatches(rule(), { subject: "example.com" })).toBe(false);
});

test("describes a rule as a sentence", () => {
	expect(describeRule(rule({ field: "subject", match: "is", value: "hi", folder: "Fin" }))).toBe('If Subject is exactly "hi", move to Fin.');
});
