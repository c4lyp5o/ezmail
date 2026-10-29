import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { db } from "../db.js";
import { decryptSecret } from "../services/crypto.service.js";
import { getFallback, refreshFallbackPassword, removeFallback, runFallbackMailbox, saveFallback } from "../services/filter-fallback.service.js";
import { imap, PASSWORD } from "./helpers/fake-imap.js";

const user = { mailbox: "Fallback@x.io", password: PASSWORD };
const rules = [
	{ field: "subject", match: "contains", value: "invoice", folder: "Bills" },
	{ field: "from", match: "contains", value: "example.com", folder: "Other" },
];

beforeEach(() => {
	imap.reset();
	imap.addBox("INBOX", "\\Inbox");
});
afterEach(() => { removeFallback(user.mailbox); removeFallback("another@x.io"); });

describe("continuous IMAP filter fallback", () => {
	test("keeps existing mail, files new mail by first rule, and stores encrypted credentials", async () => {
		imap.addMessage("INBOX", { subject: "old invoice" });
		await saveFallback(user, rules, true);
		const row = db.query("SELECT * FROM fallback_filters WHERE mailbox = ?").get("fallback@x.io");
		expect(row.pass_enc).not.toContain(PASSWORD);
		expect(row.username).toBe(user.mailbox);
		imap.addMessage("INBOX", { subject: "new invoice", from: "sender@example.com" });
		imap.addMessage("INBOX", { subject: "unmatched", from: "other@else.test" });
		await runFallbackMailbox(user.mailbox);
		expect(imap.boxes.get("INBOX").messages.map((m) => m.envelope.subject)).toEqual(["old invoice", "unmatched"]);
		expect(imap.boxes.get("Bills").messages.map((m) => m.envelope.subject)).toEqual(["new invoice"]);
		expect(imap.boxes.has("Other")).toBe(false);
		await runFallbackMailbox(user.mailbox);
		expect(imap.boxes.get("Bills").messages).toHaveLength(1);
	});

	test("records the last successful check and keeps it across a later failure", async () => {
		await saveFallback(user, rules, true);
		expect(getFallback(user.mailbox).lastCheck).toBeUndefined();
		const before = Date.now();
		await runFallbackMailbox(user.mailbox);
		const first = getFallback(user.mailbox).lastCheck;
		expect(first).toBeGreaterThanOrEqual(before);
		imap.addMessage("INBOX", { subject: "invoice" });
		imap.failMove = true;
		await runFallbackMailbox(user.mailbox);
		const failed = getFallback(user.mailbox);
		expect(failed.lastError).toContain("retry");
		expect(failed.lastCheck).toBe(first);
		imap.failMove = false;
	});

	test("retries failed moves without advancing past the message", async () => {
		await saveFallback(user, rules, true);
		imap.addMessage("INBOX", { subject: "invoice" });
		imap.failMove = true;
		await runFallbackMailbox(user.mailbox);
		expect(getFallback(user.mailbox).lastError).toContain("retry");
		expect(imap.boxes.get("INBOX").messages).toHaveLength(1);
		imap.failMove = false;
		await runFallbackMailbox(user.mailbox);
		expect(imap.boxes.get("Bills").messages).toHaveLength(1);
		expect(getFallback(user.mailbox).lastError).toBeUndefined();
	});

	test("disabling clears the password and re-enabling skips existing messages", async () => {
		await saveFallback(user, rules, true);
		await saveFallback(user, rules, false);
		expect(db.query("SELECT pass_enc FROM fallback_filters WHERE mailbox = ?").get("fallback@x.io").pass_enc).toBeNull();
		imap.addMessage("INBOX", { subject: "invoice while disabled" });
		await saveFallback(user, rules, true);
		await runFallbackMailbox(user.mailbox);
		expect(imap.boxes.get("INBOX").messages).toHaveLength(1);
		refreshFallbackPassword(user.mailbox, PASSWORD);
	});

	test("successful sign-in can refresh the encrypted worker credential", async () => {
		await saveFallback(user, rules, true);
		refreshFallbackPassword(user.mailbox, "new-password");
		const row = db.query("SELECT pass_enc FROM fallback_filters WHERE mailbox = ?").get("fallback@x.io");
		expect(row.pass_enc).not.toContain("new-password");
		expect(decryptSecret(row.pass_enc)).toBe("new-password");
	});

	test("a changed UIDVALIDITY skips existing messages rather than moving old mail", async () => {
		await saveFallback(user, rules, true);
		imap.addMessage("INBOX", { subject: "invoice" });
		imap.boxes.get("INBOX").uidValidity = 2n;
		await runFallbackMailbox(user.mailbox);
		expect(imap.boxes.get("INBOX").messages).toHaveLength(1);
		expect(getFallback(user.mailbox).lastError).toContain("identity changed");
	});

	test("a live lease prevents concurrent workers from processing the mailbox", async () => {
		await saveFallback(user, rules, true);
		imap.addMessage("INBOX", { subject: "invoice" });
		db.query("UPDATE fallback_filters SET lease_owner = ?, lease_until = ? WHERE mailbox = ?")
			.run("another-worker", Date.now() + 60_000, "fallback@x.io");
		await runFallbackMailbox(user.mailbox);
		expect(imap.boxes.get("INBOX").messages).toHaveLength(1);
		db.query("UPDATE fallback_filters SET lease_until = 0 WHERE mailbox = ?").run("fallback@x.io");
		await runFallbackMailbox(user.mailbox);
		expect(imap.boxes.get("Bills").messages).toHaveLength(1);
	});

	test("a successful empty check clears a transient worker error", async () => {
		await saveFallback(user, rules, true);
		db.query("UPDATE fallback_filters SET last_error = ? WHERE mailbox = ?").run("temporary error", "fallback@x.io");
		await runFallbackMailbox(user.mailbox);
		expect(getFallback(user.mailbox).lastError).toBeUndefined();
	});
});

test("the authenticated API saves and removes the selected fallback", async () => {
	const { call, login } = await import("./helpers/http.js");
	const cookie = await login(user.mailbox);
	const save = await call("PUT", "/api/v1/filters/", { cookie, body: { mode: "imap", enabled: true, rules } });
	expect(save.status).toBe(200);
	const get = await call("GET", "/api/v1/filters/", { cookie });
	expect(get.json.data).toMatchObject({ mode: "imap", enabled: true, rules });
	const otherCookie = await login("another@x.io");
	await saveFallback({ mailbox: "another@x.io", password: PASSWORD }, [], false);
	const other = await call("DELETE", "/api/v1/filters/", { cookie: otherCookie });
	// Another account cannot delete this mailbox's fallback.
	expect(getFallback(user.mailbox).enabled).toBe(true);
	expect(other.status).toBe(200);
	const del = await call("DELETE", "/api/v1/filters/", { cookie });
	expect(del.status).toBe(200);
	expect(getFallback(user.mailbox)).toBeNull();
});
