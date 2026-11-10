import { afterEach, describe, expect, test, vi } from "vitest";
import { MAX_CONTACTS, clearContacts, parseAddress, splitRecipients, rememberContacts, suggestContacts } from "./contacts.js";

const KEY = "ezmail_contacts:me@x.io";
const stored = () => JSON.parse(localStorage.getItem(KEY));

afterEach(() => vi.unstubAllGlobals());

describe("splitRecipients", () => {
	test("splits on commas and semicolons outside quotes and angle brackets", () => {
		expect(splitRecipients('"Lovelace, Ada" <ada@x.io>, bob@x.io; Cy <cy@x.io>').map((s) => s.trim())).toEqual([
			'"Lovelace, Ada" <ada@x.io>',
			"bob@x.io",
			"Cy <cy@x.io>",
		]);
		expect(splitRecipients("a@x.io,")).toEqual(["a@x.io", ""]);
		expect(splitRecipients("")).toEqual([""]);
		expect(splitRecipients('"unterminated, x')).toEqual(['"unterminated, x']);
	});

	test("a quoted name with a comma stays whole and loses its quotes", () => {
		expect(parseAddress('"Lovelace, Ada" <ada@x.io>')).toEqual({ address: "ada@x.io", name: "Lovelace, Ada" });
		rememberContacts("me@x.io", ['"Lovelace, Ada" <ada@x.io>, bob@x.io']);
		expect(stored()).toEqual([
			{ address: "ada@x.io", name: "Lovelace, Ada" },
			{ address: "bob@x.io", name: "" },
		]);
	});
});

describe("contacts", () => {
	test("parses names and bare addresses, ignores junk", () => {
		expect(parseAddress(' "Ada L" <ada@x.io> ')).toEqual({ address: "ada@x.io", name: "Ada L" });
		expect(parseAddress("bob@x.io")).toEqual({ address: "bob@x.io", name: "" });
		expect(parseAddress("not an address")).toBeNull();
		expect(parseAddress("")).toBeNull();
	});

	test("dedupes case-insensitively, most recently used first, keeps known names", () => {
		rememberContacts("me@x.io", ["Ada <ada@x.io>, bob@x.io", "carol@x.io"]);
		rememberContacts("me@x.io", ["BOB@x.io; ada@X.io, bob@x.io"]);
		expect(stored()).toEqual([
			{ address: "BOB@x.io", name: "" },
			{ address: "ada@X.io", name: "Ada" },
			{ address: "carol@x.io", name: "" },
		]);
	});

	test("caps the list", () => {
		rememberContacts("me@x.io", Array.from({ length: MAX_CONTACTS + 20 }, (_, i) => `u${i}@x.io`));
		rememberContacts("me@x.io", ["new@x.io"]);
		expect(stored()).toHaveLength(MAX_CONTACTS);
		expect(stored()[0].address).toBe("new@x.io");
		expect(stored().at(-1).address).toBe(`u${MAX_CONTACTS - 2}@x.io`);
	});

	test("suggests by address or name, prefix before substring, at most 6", () => {
		rememberContacts("me@x.io", ["Zed Dana <z@x.io>", "adam@x.io", "Dan <d1@x.io>", "dana@x.io"]);
		expect(suggestContacts("me@x.io", "dan").map((c) => c.address)).toEqual(["z@x.io", "d1@x.io", "dana@x.io"]);
		expect(suggestContacts("me@x.io", "DAM").map((c) => c.address)).toEqual(["adam@x.io"]);
		expect(suggestContacts("me@x.io", " ")).toEqual([]);
		rememberContacts("me@x.io", Array.from({ length: 10 }, (_, i) => `p${i}@x.io`));
		expect(suggestContacts("me@x.io", "p")).toHaveLength(6);
	});

	test("each mailbox has its own list; clear forgets one or all", () => {
		rememberContacts("me@x.io", ["a@x.io"]);
		rememberContacts("other@x.io", ["b@x.io"]);
		localStorage.setItem("ezmail_draft:me@x.io", "{}");
		expect(suggestContacts("other@x.io", "a")).toEqual([]);
		clearContacts("other@x.io");
		expect(suggestContacts("other@x.io", "b")).toEqual([]);
		expect(suggestContacts("me@x.io", "a")).toHaveLength(1);
		rememberContacts("other@x.io", ["b@x.io"]);
		clearContacts();
		expect(localStorage.getItem(KEY)).toBeNull();
		expect(localStorage.getItem("ezmail_contacts:other@x.io")).toBeNull();
		expect(localStorage.getItem("ezmail_draft:me@x.io")).toBe("{}");
	});

	test("unavailable or corrupt storage is tolerated", () => {
		localStorage.setItem(KEY, "{not json");
		expect(suggestContacts("me@x.io", "a")).toEqual([]);
		const fail = () => { throw new Error("storage denied"); };
		vi.stubGlobal("localStorage", { getItem: fail, setItem: fail, removeItem: fail, key: fail, get length() { return fail(); } });
		expect(() => rememberContacts("me@x.io", ["a@x.io"])).not.toThrow();
		expect(suggestContacts("me@x.io", "a")).toEqual([]);
		expect(() => clearContacts()).not.toThrow();
		expect(() => clearContacts("me@x.io")).not.toThrow();
	});
});
