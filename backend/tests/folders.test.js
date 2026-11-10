import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { removeFallback, saveFallback } from "../services/filter-fallback.service.js";
import { imap, PASSWORD } from "./helpers/fake-imap.js";
import { call, login } from "./helpers/http.js";

// No ManageSieve in tests: an unreachable server, so the Sieve path reports
// "unavailable" without touching the network.
mock.module("sievelib-ts", () => ({
	Client: class {
		async connect() { return false; }
		async logout() {}
	},
}));

const ME = "folders@x.io";
const user = { mailbox: ME, password: PASSWORD };
let cookie;

beforeAll(async () => {
	imap.reset();
	imap.addBox("INBOX", "\\Inbox");
	cookie = await login(ME);
});

beforeEach(async () => {
	imap.reset();
	imap.addBox("INBOX", "\\Inbox");
	imap.addBox("Sent", "\\Sent");
	imap.addBox("Drafts", "\\Drafts");
	imap.addBox("Junk", "\\Junk");
	imap.addBox("Bin"); // Trash found by name (no special-use flag)
	imap.addBox("Projects");
	imap.addBox("Receipts");
	// IMAP-fallback filters, so filtersAffected is answered locally.
	await saveFallback(user, [{ field: "from", match: "contains", value: "shop", folder: "Receipts" }], false);
});

const rename = (body) => call("POST", "/api/v1/mail/folders/rename", { cookie, body });
const remove = (body) => call("POST", "/api/v1/mail/folders/delete", { cookie, body });

describe("rename folder", () => {
	test("renames in place; filtersAffected false when no rule targets it", async () => {
		const res = await rename({ path: "Projects", newName: "  Work 2026 " });
		expect(res.status).toBe(200);
		expect(res.json).toEqual({ success: true, data: { path: "Projects", newPath: "Work 2026", filtersAffected: false } });
		expect(imap.boxes.has("Work 2026")).toBe(true);
		expect(imap.boxes.has("Projects")).toBe(false);
	});

	test("filtersAffected true when a rule files into it (or a child)", async () => {
		expect((await rename({ path: "Receipts", newName: "Bills" })).json.data.filtersAffected).toBe(true);
		imap.addBox("Shop");
		imap.addBox("Shop/Orders");
		await saveFallback(user, [{ field: "from", match: "contains", value: "x", folder: "Shop/Orders" }], false);
		expect((await rename({ path: "Shop", newName: "Store" })).json.data).toEqual({
			path: "Shop", newPath: "Store", filtersAffected: true,
		});
		expect(imap.boxes.has("Store/Orders")).toBe(true);
	});

	test("a child keeps its parent; the new path is built server-side", async () => {
		imap.addBox("Projects/Old");
		const res = await rename({ path: "Projects/Old", newName: "New" });
		expect(res.json.data.newPath).toBe("Projects/New");
		expect(imap.calls).toContainEqual({ cmd: "rename", path: "Projects/Old", newPath: "Projects/New" });
	});

	test("a parent of a system folder is refused", async () => {
		imap.addBox("Mail");
		imap.addBox("Mail/Archive", "\\Archive");
		const res = await rename({ path: "Mail", newName: "Mail2" });
		expect(res.status).toBe(400);
		expect(res.json.message).toBe("This folder contains a system folder and can't be renamed.");
		expect(imap.calls.some((c) => c.cmd === "rename")).toBe(false);
	});

	test("INBOX and special-use folders are refused", async () => {
		for (const path of ["INBOX", "Sent", "Drafts", "Junk", "Bin"]) {
			const res = await rename({ path, newName: "Other" });
			expect(res.status).toBe(400);
			expect(res.json.success).toBe(false);
		}
		expect(imap.calls.some((c) => c.cmd === "rename")).toBe(false);
	});

	test("unknown folder → 404, existing target → 409", async () => {
		expect((await rename({ path: "Nope", newName: "X" })).status).toBe(404);
		expect((await rename({ path: "Projects", newName: "receipts" })).status).toBe(409);
		expect((await rename({ path: "Projects", newName: "inbox" })).status).toBe(400);
		expect((await rename({ path: "Projects", newName: "Projects" })).status).toBe(400);
	});

	test("bad names (delimiter, dots, empty) → 400", async () => {
		for (const newName of ["a/b", "../x", ".hidden", "", "x".repeat(65)]) {
			expect((await rename({ path: "Projects", newName })).status).toBe(400);
		}
		expect(imap.boxes.has("Projects")).toBe(true);
	});

	test("upstream failure → 502", async () => {
		imap.failMailbox = true;
		const res = await rename({ path: "Projects", newName: "Work" });
		expect(res.status).toBe(502);
		expect(res.json.success).toBe(false);
	});

	test("filter state unavailable → filtersAffected omitted, rename still succeeds", async () => {
		removeFallback(ME);
		const res = await rename({ path: "Projects", newName: "Work" });
		expect(res.status).toBe(200);
		expect(res.json.data).toEqual({ path: "Projects", newPath: "Work" });
	});

	test("requires a session", async () => {
		const res = await call("POST", "/api/v1/mail/folders/rename", { body: { path: "Projects", newName: "X" } });
		expect(res.status).toBe(401);
	});
});

describe("delete folder", () => {
	test("deletes an empty folder", async () => {
		const res = await remove({ path: "Projects" });
		expect(res.status).toBe(200);
		expect(res.json).toEqual({ success: true, data: { path: "Projects", filtersAffected: false } });
		expect(imap.boxes.has("Projects")).toBe(false);
	});

	test("filtersAffected true when a rule targets it", async () => {
		expect((await remove({ path: "Receipts" })).json.data.filtersAffected).toBe(true);
	});

	test("INBOX and special-use folders are refused", async () => {
		for (const path of ["INBOX", "Sent", "Drafts", "Junk", "Bin"]) {
			expect((await remove({ path })).status).toBe(400);
		}
		expect(imap.calls.some((c) => c.cmd === "delete")).toBe(false);
	});

	test("a folder with messages → 409", async () => {
		imap.addMessage("Projects");
		const res = await remove({ path: "Projects" });
		expect(res.status).toBe(409);
		expect(res.json.message).toMatch(/empty/i);
		expect(imap.boxes.has("Projects")).toBe(true);
	});

	test("a folder with child folders → 409", async () => {
		imap.addBox("Projects/Sub");
		const res = await remove({ path: "Projects" });
		expect(res.status).toBe(409);
		expect(res.json.message).toMatch(/subfolders/i);
	});

	test("unknown folder → 404", async () => {
		expect((await remove({ path: "Nope" })).status).toBe(404);
	});

	test("upstream failures → 502 (STATUS false, DELETE NO)", async () => {
		imap.failStatus = true;
		expect((await remove({ path: "Projects" })).status).toBe(502);
		expect(imap.boxes.has("Projects")).toBe(true);
		imap.failStatus = false;
		imap.failMailbox = true;
		expect((await remove({ path: "Projects" })).status).toBe(502);
	});
});
