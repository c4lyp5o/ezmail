import { useEffect, useRef } from "react";

// Reconnect delays after a failed stream: doubles per failure, capped, and
// resets only once the stream has proven healthy: it stayed up for
// STABLE_STREAM_MS after `ready`, or delivered a mail event (`new`/`changed`).
// `ready` alone isn't enough (IMAP can authenticate and then drop), and
// `closed` means the server's IMAP connection went away.
export const RECONNECT_BASE_MS = 3000;
export const RECONNECT_MAX_MS = 60000;
export const STABLE_STREAM_MS = 30000;

// Keep one connection while letting handlers observe the latest render.
// On an error (server `{type:"error"}` or a transport drop) we close the
// source ourselves and reopen with backoff, instead of letting EventSource
// retry every ~3 s forever (each retry opens an IMAP connection server-side).
export function useMailEvents(onEvent, onDisconnect) {
	const handlers = useRef({ onEvent, onDisconnect });
	handlers.current = { onEvent, onDisconnect };
	useEffect(() => {
		if (typeof EventSource === "undefined") return;
		let source = null;
		let timer = null;
		let stableTimer = null;
		let delay = RECONNECT_BASE_MS;
		const clearStable = () => {
			clearTimeout(stableTimer);
			stableTimer = null;
		};
		const reconnectLater = () => {
			clearStable();
			source?.close();
			source = null;
			if (timer) return;
			timer = setTimeout(() => {
				timer = null;
				connect();
			}, delay);
			delay = Math.min(delay * 2, RECONNECT_MAX_MS);
		};
		const connect = () => {
			const es = new EventSource("/api/v1/mail/events");
			source = es;
			es.onmessage = (event) => {
				if (source !== es) return;
				let data;
				try { data = JSON.parse(event.data); } catch { return; /* ignore invalid event */ }
				try { handlers.current.onEvent(data); } catch { /* ignore handler errors */ }
				const type = data?.type;
				if (type === "error") reconnectLater();
				else if (type === "closed") clearStable();
				else if (type === "new" || type === "changed") delay = RECONNECT_BASE_MS;
				else if (type === "ready" && !stableTimer) {
					stableTimer = setTimeout(() => {
						stableTimer = null;
						if (source === es) delay = RECONNECT_BASE_MS;
					}, STABLE_STREAM_MS);
				}
			};
			es.onerror = () => {
				if (source !== es) return;
				handlers.current.onDisconnect();
				reconnectLater();
			};
		};
		connect();
		return () => {
			clearTimeout(timer);
			timer = null;
			clearStable();
			source?.close();
			source = null;
		};
	}, []);
}
