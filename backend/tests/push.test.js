import { beforeEach, describe, expect, test } from "bun:test";
import { app } from "../index.js";
import { activeWatchers } from "../services/push.service.js";
import { imap } from "./helpers/fake-imap.js";
import { login } from "./helpers/http.js";

beforeEach(() => {
	imap.reset();
	imap.addBox("INBOX", "\\Inbox");
});

// Opens the SSE stream and returns a reader yielding parsed events.
async function open(cookie) {
	const abort = new AbortController();
	const res = await app.handle(
		new Request("http://localhost/api/v1/mail/events", {
			headers: { cookie },
			signal: abort.signal,
		}),
	);
	const reader = res.body.getReader();
	const dec = new TextDecoder();
	let buf = "";
	const next = async () => {
		for (;;) {
			const i = buf.indexOf("\n\n");
			if (i >= 0) {
				const frame = buf.slice(0, i);
				buf = buf.slice(i + 2);
				if (frame.startsWith("data: ")) return JSON.parse(frame.slice(6));
				continue; // heartbeat comment
			}
			const { value, done } = await reader.read();
			if (done) return null;
			buf += dec.decode(value);
		}
	};
	return { res, next, close: () => reader.cancel() };
}

const watcherClient = () => imap.clients.find((c) => c.mailbox?.path === "INBOX");

describe("mail events (SSE over IMAP IDLE)", () => {
	test("needs a session", async () => {
		const res = await app.handle(new Request("http://localhost/api/v1/mail/events"));
		expect(res.status).toBe(401);
	});

	test("streams ready, then new/changed hints from the IDLE connection", async () => {
		const cookie = await login("push1@x.io");
		const s = await open(cookie);
		expect(s.res.headers.get("content-type")).toBe("text/event-stream");
		expect(await s.next()).toEqual({ type: "ready" });

		watcherClient().emit("exists", { path: "INBOX", count: 5, prevCount: 3 });
		expect(await s.next()).toEqual({ type: "new", path: "INBOX", count: 2 });

		watcherClient().emit("flags", { path: "INBOX", uid: 1 });
		expect(await s.next()).toEqual({ type: "changed", path: "INBOX" });
		await s.close();
	});

	test("tabs share one IDLE connection, closed after the last leaves", async () => {
		const cookie = await login("push2@x.io");
		const a = await open(cookie);
		const b = await open(cookie);
		await a.next();
		await b.next();
		const idlers = imap.clients.filter((c) => c.mailbox?.path === "INBOX");
		expect(idlers).toHaveLength(1);
		expect(activeWatchers()).toBe(1);

		watcherClient().emit("exists", { path: "INBOX", count: 2, prevCount: 1 });
		expect((await a.next()).type).toBe("new");
		expect((await b.next()).type).toBe("new");

		await a.close();
		expect(idlers[0].loggedOut).toBe(false);
		await b.close();
		expect(idlers[0].loggedOut).toBe(true);
		expect(activeWatchers()).toBe(0);
	});

	test("a dropped IMAP connection ends the stream so the client falls back", async () => {
		const cookie = await login("push3@x.io");
		const s = await open(cookie);
		await s.next();
		watcherClient().emit("close");
		expect(await s.next()).toEqual({ type: "closed" });
		expect(await s.next()).toBeNull();
	});
});
