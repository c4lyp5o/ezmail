import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { installEventSource } from "../test/event-source.js";
import { RECONNECT_BASE_MS, RECONNECT_MAX_MS, STABLE_STREAM_MS, useMailEvents } from "./useMailEvents.js";

// Fail the current source with `fail`, then return how long the reconnect took.
function measureReconnect(ES, fail) {
	const n = ES.instances.length;
	act(() => fail(ES.last));
	let waited = 0;
	while (ES.instances.length === n) {
		act(() => vi.advanceTimersByTime(1000));
		waited += 1000;
	}
	return waited;
}

function Probe({ onEvent = () => {}, onDisconnect = () => {} }) {
	useMailEvents(onEvent, onDisconnect);
	return null;
}

describe("useMailEvents reconnect backoff", () => {
	let ES;
	beforeEach(() => {
		vi.useFakeTimers();
		ES = installEventSource();
	});
	afterEach(() => vi.useRealTimers());

	test("an error event closes the source and reconnects later", () => {
		const onEvent = vi.fn();
		render(<Probe onEvent={onEvent} />);
		const first = ES.last;
		act(() => first.emit({ type: "error" }));
		expect(onEvent).toHaveBeenCalledWith({ type: "error" });
		expect(first.closed).toBe(true);
		expect(ES.instances).toHaveLength(1);
		act(() => vi.advanceTimersByTime(RECONNECT_BASE_MS - 1));
		expect(ES.instances).toHaveLength(1);
		act(() => vi.advanceTimersByTime(1));
		expect(ES.instances).toHaveLength(2);
		expect(ES.last.url).toBe("/api/v1/mail/events");
	});

	test("the delay doubles up to the cap, and a mail event resets it", () => {
		const onDisconnect = vi.fn();
		render(<Probe onDisconnect={onDisconnect} />);
		const delays = [];
		for (let i = 0; i < 7; i++) {
			const n = ES.instances.length;
			act(() => ES.last.onerror());
			let waited = 0;
			while (ES.instances.length === n) {
				act(() => vi.advanceTimersByTime(1000));
				waited += 1000;
			}
			delays.push(waited);
		}
		expect(delays).toEqual([3000, 6000, 12000, 24000, 48000, 60000, 60000].map((d) => Math.min(d, RECONNECT_MAX_MS)));
		expect(onDisconnect).toHaveBeenCalledTimes(7);

		act(() => ES.last.emit({ type: "new", path: "INBOX", count: 1 }));
		act(() => ES.last.emit({ type: "error" }));
		act(() => vi.advanceTimersByTime(RECONNECT_BASE_MS));
		expect(ES.instances).toHaveLength(9);
	});

	test("a flapping stream (ready, then closed) keeps backing off", () => {
		render(<Probe />);
		const flap = (es) => {
			es.emit({ type: "ready" });
			es.emit({ type: "closed" });
			es.onerror();
		};
		const delays = [0, 1, 2, 3].map(() => measureReconnect(ES, flap));
		expect(delays).toEqual([3000, 6000, 12000, 24000]);
	});

	test("the delay resets only after the stream stays up past the stability period", () => {
		render(<Probe />);
		measureReconnect(ES, (es) => es.onerror());
		measureReconnect(ES, (es) => es.onerror());
		// Up, but dropped just before proving itself: still backing off.
		act(() => ES.last.emit({ type: "ready" }));
		act(() => vi.advanceTimersByTime(STABLE_STREAM_MS - 1));
		expect(measureReconnect(ES, (es) => es.onerror())).toBe(12000);
		// Up long enough: back to the base delay.
		act(() => ES.last.emit({ type: "ready" }));
		act(() => vi.advanceTimersByTime(STABLE_STREAM_MS));
		expect(measureReconnect(ES, (es) => es.onerror())).toBe(RECONNECT_BASE_MS);
	});

	test("unmount clears both the stability and reconnect timers", () => {
		const a = render(<Probe />);
		act(() => ES.last.emit({ type: "ready" }));
		expect(vi.getTimerCount()).toBe(1);
		a.unmount();
		expect(vi.getTimerCount()).toBe(0);

		const b = render(<Probe />);
		act(() => ES.last.emit({ type: "error" }));
		expect(vi.getTimerCount()).toBe(1);
		b.unmount();
		expect(vi.getTimerCount()).toBe(0);
	});

	test("unmount closes the source and cancels a pending reconnect", () => {
		const { unmount } = render(<Probe />);
		act(() => ES.last.emit({ type: "error" }));
		unmount();
		act(() => vi.advanceTimersByTime(RECONNECT_MAX_MS * 2));
		expect(ES.instances).toHaveLength(1);

		const second = render(<Probe />);
		const live = ES.last;
		second.unmount();
		expect(live.closed).toBe(true);
	});
});
