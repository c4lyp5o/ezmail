import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, test } from "vitest";
import App from "./App.jsx";
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
