import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { SWRConfig } from "swr";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { mockApi } from "../test/fetch.js";
import MessageList from "./MessageList.jsx";

const MESSAGES = Array.from({ length: 30 }, (_, i) => ({
	uid: 100 - i,
	subject: `Subject ${i + 1}`,
	from: `sender${i}@x.io`,
	fromName: "",
	date: "2026-10-20T10:00:00Z",
	flags: ["\\Seen"],
	seen: true,
	attachments: 0,
}));

let calls;
beforeEach(() => {
	calls = mockApi({
		"GET /mail/messages/INBOX": { messages: MESSAGES, total: 30, page: 1, pageSize: 50 },
		"POST /mail/flags": { uids: [], flags: [], inboxUnseen: 0 },
	});
});

// Owns the selection like MailPage does.
function Harness({ onOpen, keyboardEnabled = true, initialSelected = [] }) {
	const [selected, setSelected] = useState(() => new Set(initialSelected));
	return (
		<SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
			<output data-testid="selected">{[...selected].join(",")}</output>
			<MessageList
				activeFolder="INBOX"
				selected={selected}
				onToggleSelect={(uid) =>
					setSelected((prev) => {
						const next = new Set(prev);
						next.has(uid) ? next.delete(uid) : next.add(uid);
						return next;
					})
				}
				onToggleAll={() => {}}
				onOpenMessage={onOpen}
				onReady={() => {}}
				onSelectionChange={setSelected}
				keyboardEnabled={keyboardEnabled}
			/>
		</SWRConfig>
	);
}

const press = (key, opts = {}) =>
	act(() => {
		fireEvent.keyDown(window, { key, ...opts });
	});
const selected = () =>
	screen.getByTestId("selected").textContent.split(",").filter(Boolean).map(Number);

async function setup(props) {
	const onOpen = vi.fn();
	render(<Harness onOpen={onOpen} {...props} />);
	await screen.findByText("Subject 1");
	return onOpen;
}

describe("plain navigation", () => {
	test("↓ / j / k open the next and previous message", async () => {
		const onOpen = await setup();
		press("ArrowDown");
		expect(onOpen).toHaveBeenLastCalledWith(MESSAGES[0]);
		press("j");
		expect(onOpen).toHaveBeenLastCalledWith(MESSAGES[1]);
		press("k");
		expect(onOpen).toHaveBeenLastCalledWith(MESSAGES[0]);
		press("ArrowUp"); // clamps at the top
		expect(onOpen).toHaveBeenLastCalledWith(MESSAGES[0]);
	});

	test("End / Home jump to the ends", async () => {
		const onOpen = await setup();
		press("End");
		expect(onOpen).toHaveBeenLastCalledWith(MESSAGES[29]);
		press("Home");
		expect(onOpen).toHaveBeenLastCalledWith(MESSAGES[0]);
	});

	test("x toggles the cursor row's checkbox", async () => {
		await setup();
		press("ArrowDown");
		press("x");
		expect(selected()).toEqual([100]);
		press("x");
		expect(selected()).toEqual([]);
	});

	test("ignored while typing in search", async () => {
		const onOpen = await setup();
		fireEvent.keyDown(screen.getByPlaceholderText("Search mail…"), { key: "j" });
		expect(onOpen).not.toHaveBeenCalled();
	});

	test("disabled (e.g. modal open) ignores keys", async () => {
		const onOpen = await setup({ keyboardEnabled: false });
		press("ArrowDown");
		expect(onOpen).not.toHaveBeenCalled();
	});

	test("opening via keyboard marks unread mail as read", async () => {
		MESSAGES[0].seen = false;
		try {
			await setup();
			press("ArrowDown");
			await waitFor(() =>
				expect(calls.find((c) => c.path === "/mail/flags")?.body).toMatchObject({
					folder: "INBOX",
					uids: [100],
					flags: ["\\Seen"],
				}),
			);
		} finally {
			MESSAGES[0].seen = true;
		}
	});
});

describe("Shift selection", () => {
	test("Shift+↓ extends a range from the cursor without opening", async () => {
		const onOpen = await setup();
		press("ArrowDown"); // cursor on row 0 (opens it)
		onOpen.mockClear();
		press("ArrowDown", { shiftKey: true });
		press("ArrowDown", { shiftKey: true });
		expect(selected()).toEqual([100, 99, 98]);
		expect(onOpen).not.toHaveBeenCalled();
	});

	test("reversing direction shrinks the range back to the anchor", async () => {
		await setup();
		press("ArrowDown");
		press("ArrowDown", { shiftKey: true });
		press("ArrowDown", { shiftKey: true });
		press("ArrowUp", { shiftKey: true });
		expect(selected()).toEqual([100, 99]);
	});

	test("Shift+PageDown selects a page at a time", async () => {
		await setup();
		press("ArrowDown");
		// no layout in happy-dom → page step falls back to 10 rows
		press("PageDown", { shiftKey: true });
		expect(selected()).toHaveLength(11);
		press("PageDown", { shiftKey: true });
		expect(selected()).toHaveLength(21);
		press("End", { shiftKey: true });
		expect(selected()).toHaveLength(30);
	});

	test("Shift+J works like Shift+↓", async () => {
		await setup();
		press("ArrowDown");
		press("J", { shiftKey: true });
		expect(selected()).toEqual([100, 99]);
	});

	test("keeps what was selected before the range started", async () => {
		await setup({ initialSelected: [80] });
		press("ArrowDown");
		press("ArrowDown", { shiftKey: true });
		expect(selected().sort()).toEqual([100, 80, 99].sort());
	});

	test("a plain move ends the range; the next Shift starts a new one", async () => {
		await setup();
		press("ArrowDown");
		press("ArrowDown", { shiftKey: true }); // 100, 99
		press("ArrowDown"); // cursor → 98, opens it
		press("ArrowDown", { shiftKey: true }); // new anchor at 98 → adds 97
		expect(selected().sort()).toEqual([100, 99, 98, 97].sort());
	});
});
