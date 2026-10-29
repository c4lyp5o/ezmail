import { generalLogger as logger } from "../logger.js";
import { getUser } from "../plugins/auth.plugin.js";
import { buildImapClient } from "./mail.service.js";

// Live INBOX updates over Server-Sent Events, fed by IMAP IDLE.
//
// One long-lived IMAP connection per mailbox is shared by all of that
// mailbox's open tabs (imapflow IDLEs automatically while a mailbox is
// selected and nothing else runs) and closed when the last tab goes away.
// Events are hints — the client refetches; nothing mail-related is sent.

const HEARTBEAT_MS = 20000; // < Bun's idleTimeout (index.js)
const watchers = new Map(); // mailbox -> { listeners: Set, client, ready }

export const activeWatchers = () => watchers.size;

function emit(w, event) {
	for (const fn of w.listeners) fn(event);
}

function startWatcher(user) {
	const w = { listeners: new Set(), client: buildImapClient(user) };
	const { client } = w;
	client.on("exists", (d) => {
		if (d.count > d.prevCount)
			emit(w, { type: "new", path: d.path, count: d.count - d.prevCount });
		else emit(w, { type: "changed", path: d.path });
	});
	client.on("expunge", (d) => emit(w, { type: "changed", path: d.path }));
	client.on("flags", (d) => emit(w, { type: "changed", path: d.path }));
	client.on("close", () => {
		if (watchers.get(user.mailbox) === w) watchers.delete(user.mailbox);
		emit(w, { type: "closed" });
	});
	client.on("error", (err) => logger.warn(`[PUSH] ${user.mailbox}: ${err.message}`));
	w.ready = client.connect().then(() => client.mailboxOpen("INBOX"));
	return w;
}

// Registers a listener; resolves to an unsubscribe fn once IDLE is running.
export async function subscribe(user, listener) {
	let w = watchers.get(user.mailbox);
	if (!w) {
		w = startWatcher(user);
		watchers.set(user.mailbox, w);
	}
	w.listeners.add(listener);
	const unsubscribe = () => {
		w.listeners.delete(listener);
		if (w.listeners.size === 0) {
			if (watchers.get(user.mailbox) === w) watchers.delete(user.mailbox);
			w.client.logout().catch(() => {});
		}
	};
	try {
		await w.ready;
	} catch (err) {
		unsubscribe();
		throw err;
	}
	return unsubscribe;
}

export const PushService = {
	events: async ({ cookie, status, request }) => {
		const user = getUser(cookie);
		if (!user) return status(401, { success: false, message: "Unauthorized" });

		const enc = new TextEncoder();
		let closed = false;
		let cleanup = () => {};
		const stream = new ReadableStream({
			async start(controller) {
				const write = (chunk) => {
					if (!closed) controller.enqueue(enc.encode(chunk));
				};
				const send = (event) => {
					write(`data: ${JSON.stringify(event)}\n\n`);
					if (event.type === "closed") cleanup();
				};
				let unsubscribe = () => {};
				const heartbeat = setInterval(() => write(": ping\n\n"), HEARTBEAT_MS);
				cleanup = () => {
					if (closed) return;
					closed = true;
					clearInterval(heartbeat);
					unsubscribe();
					try {
						controller.close();
					} catch {
						// already closed by the client
					}
				};
				request.signal?.addEventListener("abort", () => cleanup());
				try {
					unsubscribe = await subscribe(user, send);
					if (closed) unsubscribe();
					else send({ type: "ready" });
				} catch (err) {
					logger.warn(`[PUSH] watch failed for ${user.mailbox}: ${err.message}`);
					send({ type: "error" });
					cleanup();
				}
			},
			cancel() {
				cleanup();
			},
		});
		return new Response(stream, {
			headers: {
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-cache, no-transform",
				Connection: "keep-alive",
				"X-Accel-Buffering": "no", // don't let nginx buffer the stream
			},
		});
	},
};
