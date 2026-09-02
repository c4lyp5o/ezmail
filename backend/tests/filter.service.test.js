import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	generateSieveScript,
	homeDir,
	mailboxParts,
	writeFilters,
} from "../services/filter.service.js";

// Redirect the mail store into a throwaway dir for the whole suite.
const TMP = mkdtempSync(path.join(tmpdir(), "ezmail-filters-"));
process.env.MAIL_DATA_DIR = TMP;

const GOOD_RULES = [
	{
		field: "subject",
		match: "contains",
		value: "[eztest]",
		folder: "Sieve-Demo",
	},
	{ field: "from", match: "is", value: "boss@example.com", folder: "Boss" },
];

describe("generateSieveScript", () => {
	test("emits require + fileinto with :create", () => {
		const s = generateSieveScript(GOOD_RULES);
		expect(s).toContain('require ["fileinto", "mailbox"];');
		expect(s).toContain('if header :contains "Subject" "[eztest]"');
		expect(s).toContain('fileinto :create "Sieve-Demo";');
		expect(s).toContain('address :is "from" "boss@example.com"');
		// every rule ends with stop
		expect((s.match(/stop;/g) || []).length).toBe(2);
	});

	test("escapes quotes and backslashes in values", () => {
		const s = generateSieveScript([
			{ field: "subject", match: "contains", value: 'evil"\\x', folder: "F" },
		]);
		expect(s).toContain('header :contains "Subject" "evil\\"\\\\x"');
		// the raw unescaped value must not appear bare
		expect(s).not.toContain('"evil"');
	});

	test("to-address rules use the address test", () => {
		const s = generateSieveScript([
			{ field: "to", match: "contains", value: "team", folder: "Team" },
		]);
		expect(s).toContain('address :contains "to" "team"');
	});
});

describe("mailboxParts safety", () => {
	test("splits normal addresses", () => {
		expect(mailboxParts("maxine@calypsocloud.one")).toEqual({
			local: "maxine",
			domain: "calypsocloud.one",
		});
	});
	test("rejects traversal and bad charset", () => {
		expect(mailboxParts("../etc@x.com")).toBeNull();
		expect(mailboxParts("a/b@x.com")).toBeNull();
		expect(mailboxParts("no-at-sign")).toBeNull();
		expect(mailboxParts("@domain-only.com")).toBeNull();
		expect(mailboxParts("")).toBeNull();
	});
});

describe("writeFilters file layout", () => {
	test("writes sieve + json sidecar under <domain>/<local>/home/", () => {
		const n = writeFilters("maxine@calypsocloud.one", GOOD_RULES, true);
		expect(n).toBe(2);
		const home = path.join(TMP, "calypsocloud.one", "maxine", "home");
		const sieve = readFileSync(path.join(home, ".dovecot.sieve"), "utf8");
		expect(sieve).toContain('fileinto :create "Sieve-Demo";');
		const sidecar = JSON.parse(
			readFileSync(path.join(home, ".ezmail-filters.json"), "utf8"),
		);
		expect(sidecar.enabled).toBe(true);
		expect(sidecar.rules).toHaveLength(2);
	});

	test("invalid rule values are rejected wholesale", () => {
		expect(() =>
			writeFilters(
				"maxine@calypsocloud.one",
				[
					{
						field: "subject",
						match: "contains",
						value: "ok",
						folder: "../evil",
					},
				],
				true,
			),
		).toThrow("Invalid filter rule(s)");
	});

	test("traversal mailbox is rejected outright", () => {
		expect(homeDir("../../etc@x.com")).toBeNull();
		expect(() => writeFilters("../../etc@x.com", GOOD_RULES, true)).toThrow(
			"invalid mailbox",
		);
	});

	test("disabled write keeps rules but removes the sieve script", () => {
		writeFilters("maxine@calypsocloud.one", GOOD_RULES, false);
		const home = path.join(TMP, "calypsocloud.one", "maxine", "home");
		expect(existsSync(path.join(home, ".dovecot.sieve"))).toBe(false);
		const sidecar = JSON.parse(
			readFileSync(path.join(home, ".ezmail-filters.json"), "utf8"),
		);
		expect(sidecar.enabled).toBe(false);
		expect(sidecar.rules).toHaveLength(2);
	});
});

afterAll(() => {
	try {
		rmSync(TMP, { recursive: true, force: true });
	} catch {
		// ignore
	}
});
