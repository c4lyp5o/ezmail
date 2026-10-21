import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, test, vi } from "vitest";
import App from "./App.jsx";
import { installEventSource } from "./test/event-source.js";
import { mockApi } from "./test/fetch.js";

const ME = { mailbox: "me@x.io", llmPresent: false };
const FOLDERS = [
	{ path: "INBOX", name: "INBOX", delimiter: "/", specialUse: "\\Inbox", flags: [], hasChildren: false, unread: 3 },
	{ path: "Trash", name: "Trash", delimiter: "/", specialUse: "\\Trash", flags: [], hasChildren: false, unread: 7 },
];
const MSG = {
	uid: 42,
	subject: "Quarterly report",
	from: "boss@x.io",
	fromName: "Boss",
	date: "2026-10-20T10:00:00Z",
	flags: ["\\Seen"],
	seen: true,
	attachments: 0,
};

const renderAt = (path) =>
	render(
		<MemoryRouter initialEntries={[path]}>
			<App />
		</MemoryRouter>,
	);

describe("routing (react-router)", () => {
	test("no session: / and /mail land on the login page", async () => {
		mockApi({ "GET /me": { status: 401, json: { success: false, message: "Unauthorized" } } });
		renderAt("/mail");
		expect(await screen.findByText("Sign in to your mailbox")).toBeTruthy();
	});

	test("unknown routes redirect home", async () => {
		mockApi({ "GET /me": { status: 401, json: { success: false } } });
		renderAt("/nope/nothing");
		expect(await screen.findByText("Sign in to your mailbox")).toBeTruthy();
	});
});

describe("mail page", () => {
	function signedIn(extra = {}) {
		return mockApi({
			"GET /me": ME,
			"GET /mail/folders": FOLDERS,
			"GET /mail/messages/INBOX": { messages: [MSG], total: 1, page: 1, pageSize: 50 },
			"GET /mail/message/INBOX/42": { ...MSG, folder: "INBOX", to: ME.mailbox, html: "", text: "numbers", attachments: [] },
			...extra,
		});
	}

	test("unread badges show for normal folders but not Trash", async () => {
		signedIn();
		renderAt("/mail");
		expect(await screen.findByTitle("3 unread")).toBeTruthy();
		expect(screen.queryByTitle("7 unread")).toBeNull();
	});

	test("# deletes the open message, Undo moves it back with the new UID", async () => {
		const calls = signedIn({
			"POST /mail/move": (body) =>
				body.to === "Trash"
					? { uids: body.uids, from: "INBOX", to: "Trash", inboxUnseen: 3, movedUids: [900] }
					: { uids: body.uids, from: "Trash", to: "INBOX", inboxUnseen: 3 },
		});
		renderAt("/mail");
		await screen.findByText("Quarterly report");

		act(() => {
			fireEvent.keyDown(window, { key: "ArrowDown" });
		});
		await screen.findByText("numbers");
		act(() => {
			fireEvent.keyDown(window, { key: "#" });
		});

		expect(await screen.findByText("1 message moved to Trash")).toBeTruthy();
		expect(calls.find((c) => c.path === "/mail/move").body).toEqual({
			uids: [42],
			from: "INBOX",
			to: "Trash",
		});

		fireEvent.click(screen.getByText("Undo"));
		await waitFor(() =>
			expect(calls.filter((c) => c.path === "/mail/move")[1]?.body).toEqual({
				uids: [900],
				from: "Trash",
				to: "INBOX",
			}),
		);
	});

	test("r on an open message opens a prefilled reply", async () => {
		signedIn({
			"GET /mail/message/INBOX/42": {
				...MSG,
				folder: "INBOX",
				from: "Boss <boss@x.io>",
				to: ME.mailbox,
				html: "",
				text: "numbers",
				attachments: [],
				messageId: "<q@x.io>",
				addresses: { from: ["boss@x.io"], replyTo: [], to: [ME.mailbox], cc: [] },
			},
		});
		renderAt("/mail");
		await screen.findByText("Quarterly report");
		act(() => {
			fireEvent.keyDown(window, { key: "ArrowDown" });
		});
		await screen.findByText("numbers");
		act(() => {
			fireEvent.keyDown(window, { key: "r" });
		});
		expect(screen.getByPlaceholderText("recipient@example.com").value).toBe("boss@x.io");
		expect(screen.getByPlaceholderText("Subject").value).toBe("Re: Quarterly report");
	});

	test("Trash is recognised by role: 'Bin' gets Delete all and permanent delete", async () => {
		const bin = { ...FOLDERS[1], path: "Bin", name: "Bin" };
		const calls = signedIn({
			"GET /mail/folders": [FOLDERS[0], bin],
			"GET /mail/messages/Bin": { messages: [MSG], total: 1, page: 1, pageSize: 50 },
			"POST /mail/delete": { uids: [42], folder: "Bin" },
		});
		renderAt("/mail");
		fireEvent.click(await screen.findByText("Bin"));
		expect(await screen.findByText("Delete all")).toBeTruthy();
		await screen.findByText("Quarterly report");
		fireEvent.click(screen.getByRole("checkbox", { name: "" }));
		fireEvent.click(screen.getByTitle("Delete"));
		await waitFor(() =>
			expect(calls.find((c) => c.path === "/mail/delete")?.body).toEqual({
				folder: "Bin",
				uids: [42],
			}),
		);
	});

	test("? opens the shortcut help, Esc closes it", async () => {
		signedIn();
		renderAt("/mail");
		await screen.findByText("Quarterly report");
		act(() => {
			fireEvent.keyDown(window, { key: "?" });
		});
		expect(screen.getByText("Keyboard shortcuts")).toBeTruthy();
		act(() => {
			fireEvent.keyDown(window, { key: "Escape" });
		});
		expect(screen.queryByText("Keyboard shortcuts")).toBeNull();
	});
});

describe("live updates", () => {
	function signedIn() {
		return mockApi({
			"GET /me": ME,
			"GET /mail/folders": FOLDERS,
			"GET /mail/messages/INBOX": { messages: [MSG], total: 1, page: 1, pageSize: 50 },
		});
	}
	const count = (calls, path) => calls.filter((c) => c.path === path).length;

	test("a 'new' event refetches the list and folder counts", async () => {
		const ES = installEventSource();
		const calls = signedIn();
		renderAt("/mail");
		await screen.findByText("Quarterly report");
		expect(ES.last.url).toBe("/api/v1/mail/events");

		const before = [count(calls, "/mail/messages/INBOX"), count(calls, "/mail/folders")];
		act(() => ES.last.emit({ type: "ready" }));
		act(() => ES.last.emit({ type: "new", path: "INBOX", count: 1 }));
		await waitFor(() => {
			expect(count(calls, "/mail/messages/INBOX")).toBeGreaterThan(before[0]);
			expect(count(calls, "/mail/folders")).toBeGreaterThan(before[1]);
		});
		expect(screen.getByTitle("Refresh mail list (live updates on)")).toBeTruthy();
	});

	test("notifies when the tab is hidden and notifications are on", async () => {
		const ES = installEventSource();
		const shown = [];
		class FakeNotification {
			static permission = "granted";
			static requestPermission = async () => "granted";
			constructor(title, opts) {
				shown.push({ title, ...opts });
			}
		}
		vi.stubGlobal("Notification", FakeNotification);
		signedIn();
		renderAt("/mail");
		await screen.findByText("Quarterly report");

		fireEvent.click(screen.getByLabelText("Desktop notifications"));
		await waitFor(() =>
			expect(screen.getByTitle("New-mail notifications on")).toBeTruthy(),
		);

		const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
		act(() => ES.last.emit({ type: "new", path: "INBOX", count: 3 }));
		expect(shown).toEqual([
			{ title: "ezmail", body: "3 new messages", tag: "ezmail-new", icon: "/favicon.ico" },
		]);

		hidden.mockReturnValue(false); // visible tab: no popup
		act(() => ES.last.emit({ type: "new", path: "INBOX", count: 1 }));
		expect(shown).toHaveLength(1);
	});

	test("unread INBOX count shows in the tab title", async () => {
		installEventSource();
		signedIn();
		renderAt("/mail");
		await waitFor(() => expect(document.title).toBe("(3) ezmail"));
	});
});

