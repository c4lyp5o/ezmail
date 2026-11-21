import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createPool } from "../services/imap-pool.service.js";
import { closeImapPool } from "../services/mail.service.js";
import { imap } from "./helpers/fake-imap.js";
import { call, login } from "./helpers/http.js";

let cookie;
beforeEach(async () => {
	imap.reset();
	imap.addBox("INBOX", "\\Inbox");
	imap.addBox("Trash", "\\Trash");
	cookie = await login("pool@x.io");
	process.env.IMAP_POOL_IDLE_MS = "60000";
});
afterEach(async () => {
	await closeImapPool();
	process.env.IMAP_POOL_IDLE_MS = "0";
});

const folders = () => call("GET", "/api/v1/mail/folders", { cookie });

describe("IMAP connection pool", () => {
	test("sequential requests reuse one connection", async () => {
		const before = imap.clients.length;
		expect((await folders()).status).toBe(200);
		expect((await folders()).status).toBe(200);
		expect((await folders()).status).toBe(200);
		expect(imap.clients.length - before).toBe(1);
		expect(imap.clients.at(-1).loggedOut).toBe(false);
	});

	test("parallel requests never open more than three connections", async () => {
		const before = imap.clients.length;
		const results = await Promise.all(Array.from({ length: 8 }, folders));
		expect(results.every((r) => r.status === 200)).toBe(true);
		expect(imap.clients.length - before).toBeLessThanOrEqual(3);
	});

	test("a failed command discards its connection", async () => {
		const uid = imap.addMessage("INBOX");
		imap.failMove = true;
		const failed = await call("POST", "/api/v1/mail/move", { body: { uids: [uid], from: "INBOX", to: "Trash" }, cookie });
		expect(failed.status).toBe(502);
		const broken = imap.clients.at(-1);
		expect(broken.loggedOut).toBe(true);
		imap.failMove = false;
		expect((await folders()).status).toBe(200);
		expect(imap.clients.at(-1)).not.toBe(broken);
	});

	test("a waiter woken while the pool empties does not push it past three", async () => {
		process.env.IMAP_POOL_IDLE_MS = "0"; // every release drops its connection
		let open = 0;
		let maxOpen = 0;
		const pool = createPool(() => ({
			on() {},
			async connect() { maxOpen = Math.max(maxOpen, ++open); },
			async logout() { open--; },
		}));
		const user = { mailbox: "race@x.io", password: "p" };
		const held = [];
		let draining = false;
		const hold = () => pool.use(user, () => new Promise((resolve) => (draining ? resolve() : held.push(resolve))));
		const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
		const first = [hold(), hold(), hold()];
		await tick();
		const waiter = hold(); // queued behind the three
		await tick();
		// Release all three at once: A wakes the waiter, then B and C empty the entry
		// before the waiter resumes.
		for (const resolve of held.splice(0, 3)) resolve();
		await Promise.all(first);
		await tick();
		const more = [hold(), hold(), hold()];
		await tick();
		draining = true;
		for (const resolve of held.splice(0)) resolve();
		await Promise.all([waiter, ...more]);
		expect(maxOpen).toBeLessThanOrEqual(3);
	});

	test("closeIdle logs pooled connections out", async () => {
		await folders();
		const pooled = imap.clients.at(-1);
		await closeImapPool();
		expect(pooled.loggedOut).toBe(true);
	});
});
