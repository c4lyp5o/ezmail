import { useEffect, useRef } from "react";

// Keep one connection while letting handlers observe the latest render.
export function useMailEvents(onEvent, onDisconnect) {
	const handlers = useRef({ onEvent, onDisconnect });
	handlers.current = { onEvent, onDisconnect };
	useEffect(() => {
		if (typeof EventSource === "undefined") return;
		const source = new EventSource("/api/v1/mail/events");
		source.onmessage = (event) => {
			try { handlers.current.onEvent(JSON.parse(event.data)); } catch { /* ignore invalid event */ }
		};
		source.onerror = () => handlers.current.onDisconnect();
		return () => source.close();
	}, []);
}
