import { act, createEvent, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, test, vi } from "vitest";
import App from "../App.jsx";
import { DRAG_MIME } from "../components/MessageList.jsx";
import { mockApi } from "../test/fetch.js";

const ME = { mailbox: "me@x.io", llmPresent: false };
const folder = (path, specialUse) => ({ path, name: path, delimiter: "/", specialUse, flags: [], hasChildren: false, unread: 0 });
const FOLDERS = [folder("INBOX", "\\Inbox"), folder("Archive", "\\Archive"), folder("Trash", "\\Trash")];
const mk = (uid, subject, seen = true) => ({
	uid,
	subject,
	from: `${subject.toLowerCase()}@x.io`,
	fromName: "",
	date: "2026-10-20T10:00:00Z",
	flags: seen ? ["\\Seen"] : [],
	seen,
	attachments: 0,
});

// A small stateful INBOX: moves/deletes remove messages, flag calls update them.
function mailbox({ count = 3, unseen = [], starred = [] } = {}) {
	const all = [mk(30, "Alpha"), mk(20, "Bravo"), mk(10, "Charlie")].slice(0, count);
	let msgs = all.map((m) => {
		const base = unseen.includes(m.uid) ? mk(m.uid, m.subject, false) : m;
		return starred.includes(m.uid) ? { ...base, flags: [...base.flags, "\\Flagged"] } : base;
	});
	const setFlags = (b, add) => {
		msgs = msgs.map((m) => {
			if (!b.uids.includes(m.uid)) return m;
			const flags = add ? [...new Set([...m.flags, ...b.flags])] : m.flags.filter((f) => !b.flags.includes(f));
			return { ...m, flags, seen: flags.includes("\\Seen") };
		});
		return { uids: b.uids, flags: b.flags, inboxUnseen: 0 };
	};
	const routes = {
		"GET /me": ME,
		"GET /mail/folders": FOLDERS,
		"GET /mail/messages/INBOX": () => ({ messages: msgs, total: msgs.length, page: 1, pageSize: 50 }),
		"GET /mail/messages/Archive": { messages: [], total: 0, page: 1, pageSize: 50 },
		"POST /mail/move": (b) => {
			if (b.from === "INBOX") msgs = msgs.filter((m) => !b.uids.includes(m.uid));
			else msgs = [...msgs, mk(900, "Bravo")];
			return { ...b, inboxUnseen: 0, movedUids: [900] };
		},
		"POST /mail/delete": (b) => {
			msgs = msgs.filter((m) => !b.uids.includes(m.uid));
			return { uids: b.uids, folder: b.folder, trash: "Trash", inboxUnseen: 0, movedUids: [901] };
		},
		"POST /mail/flags": (b) => setFlags(b, true),
		"POST /mail/unflag": (b) => setFlags(b, false),
	};
	for (const m of all) {
		routes[`GET /mail/message/INBOX/${m.uid}`] = () => ({
			...(msgs.find((x) => x.uid === m.uid) || m),
			folder: "INBOX",
			to: ME.mailbox,
			html: "",
			text: `body of ${m.subject}`,
			attachments: [],
		});
	}
	return mockApi(routes);
}

const renderMail = async () => {
	render(
		<MemoryRouter initialEntries={["/mail"]}>
			<App />
		</MemoryRouter>,
	);
	await screen.findByText("Alpha");
	const nav = within(screen.getByRole("navigation"));
	await nav.findByRole("button", { name: "Trash" });
	await nav.findByRole("button", { name: "Archive" });
};
// Hold back the response of the next request matching `match` until released.
const hold = (match) => {
	const real = globalThis.fetch;
	let release;
	const gate = new Promise((r) => {
		release = r;
	});
	let held = false;
	vi.stubGlobal("fetch", async (url, init = {}) => {
		const key = `${init.method || "GET"} ${String(url).replace(/^\/api\/v1/, "").split("?")[0]}`;
		const res = await real(url, init);
		if (key === match && !held) {
			held = true;
			await gate;
		}
		return res;
	});
	return release;
};
const open = async (subject) => {
	fireEvent.click(screen.getByText(subject));
	await screen.findByText(`body of ${subject}`);
};
const press = (key) =>
	act(() => {
		fireEvent.keyDown(window, { key });
	});
const posted = (calls, path) => calls.filter((c) => c.method === "POST" && c.path === path);
const LIST_PLACEHOLDER = "Select a message to read it";

describe("reader actions", () => {
	test("Archive moves the open message and opens the next one", async () => {
		const calls = mailbox();
		await renderMail();
		await open("Bravo");
		fireEvent.click(screen.getByTitle("Archive (e)"));
		await screen.findByText("body of Charlie");
		expect(posted(calls, "/mail/move")[0].body).toEqual({ uids: [20], from: "INBOX", to: "Archive" });
	});

	test("archiving the last message opens the previous one", async () => {
		mailbox();
		await renderMail();
		await open("Charlie");
		fireEvent.click(screen.getByTitle("Archive (e)"));
		await screen.findByText("body of Bravo");
	});

	test("archiving the only message goes back to the list", async () => {
		mailbox({ count: 1 });
		await renderMail();
		await open("Alpha");
		fireEvent.click(screen.getByTitle("Archive (e)"));
		expect(await screen.findByText(LIST_PLACEHOLDER)).toBeTruthy();
	});

	test("e and # on the open message auto-advance too", async () => {
		const calls = mailbox();
		await renderMail();
		await open("Alpha");
		press("e");
		await screen.findByText("body of Bravo");
		press("#");
		await screen.findByText("body of Charlie");
		expect(posted(calls, "/mail/delete")[0].body).toEqual({ folder: "INBOX", uids: [20] });
	});

	test("Delete button deletes and opens the next message", async () => {
		const calls = mailbox();
		await renderMail();
		await open("Alpha");
		fireEvent.click(screen.getByTitle("Delete (#)"));
		await screen.findByText("body of Bravo");
		expect(posted(calls, "/mail/delete")[0].body).toEqual({ folder: "INBOX", uids: [30] });
	});

	test("Undo after auto-advance moves the message back", async () => {
		const calls = mailbox();
		await renderMail();
		await open("Bravo");
		fireEvent.click(screen.getByTitle("Archive (e)"));
		await screen.findByText("body of Charlie");
		fireEvent.click(await screen.findByText("Undo"));
		await waitFor(() =>
			expect(posted(calls, "/mail/move")[1]?.body).toEqual({ uids: [900], from: "Archive", to: "INBOX" }),
		);
		expect(await screen.findByText("Bravo")).toBeTruthy();
	});

	test("Archive is hidden while reading in the Archive folder", async () => {
		mailbox();
		await renderMail();
		await open("Bravo");
		expect(screen.getByTitle("Archive (e)")).toBeTruthy();
		fireEvent.click(within(screen.getByRole("navigation")).getByRole("button", { name: "Archive" }));
		await screen.findByText("No messages");
		expect(screen.queryByTitle("Archive (e)")).toBeNull();
	});

	test("Move to… reuses the folder picker and advances", async () => {
		const calls = mailbox();
		await renderMail();
		await open("Bravo");
		fireEvent.click(screen.getByRole("button", { name: "Move to…" }));
		const dialog = screen.getByRole("dialog", { name: "Move to folder" });
		expect(within(dialog).queryByText("INBOX")).toBeNull();
		fireEvent.click(within(dialog).getByText("Trash"));
		await screen.findByText("body of Charlie");
		expect(posted(calls, "/mail/move")[0].body).toEqual({ uids: [20], from: "INBOX", to: "Trash" });
	});

	test("Star button and s toggle the flag and the label", async () => {
		const calls = mailbox();
		await renderMail();
		await open("Bravo");
		fireEvent.click(screen.getByRole("button", { name: "Star" }));
		await screen.findByRole("button", { name: "Unstar" });
		expect(posted(calls, "/mail/flags").at(-1).body).toEqual({
			folder: "INBOX",
			uids: [20],
			action: "add",
			flags: ["\\Flagged"],
		});
		press("s");
		await screen.findByRole("button", { name: "Star" });
		expect(posted(calls, "/mail/unflag").at(-1).body).toEqual({
			folder: "INBOX",
			uids: [20],
			action: "remove",
			flags: ["\\Flagged"],
		});
		expect(screen.getByText("body of Bravo")).toBeTruthy(); // reader stays open
	});

	test("Mark unread returns to the list and the message stays unread", async () => {
		const calls = mailbox({ unseen: [20] });
		await renderMail();
		await open("Bravo");
		await waitFor(() => expect(posted(calls, "/mail/flags")).toHaveLength(1)); // auto mark-read
		fireEvent.click(screen.getByRole("button", { name: "Mark unread" }));
		expect(await screen.findByText(LIST_PLACEHOLDER)).toBeTruthy();
		expect(posted(calls, "/mail/unflag")[0].body).toEqual({
			folder: "INBOX",
			uids: [20],
			action: "remove",
			flags: ["\\Seen"],
		});
		const row = screen.getByText("Bravo").closest("[data-uid]");
		await waitFor(() => expect(row.querySelector(".rounded-full.bg-accent")).toBeTruthy());
		await new Promise((r) => setTimeout(r, 50));
		expect(posted(calls, "/mail/flags")).toHaveLength(1); // nothing re-marked it
	});

	test("s on an already-starred message unstars it before the body has loaded", async () => {
		const calls = mailbox({ starred: [20] });
		await renderMail();
		const release = hold("GET /mail/message/INBOX/20");
		fireEvent.click(screen.getByText("Bravo"));
		press("s"); // body still loading: the state comes from the list row
		await waitFor(() => expect(posted(calls, "/mail/unflag")).toHaveLength(1));
		expect(posted(calls, "/mail/unflag")[0].body.flags).toEqual(["\\Flagged"]);
		expect(posted(calls, "/mail/flags")).toHaveLength(0);
		release();
		await screen.findByText("body of Bravo");
	});

	test("u right after opening an unread message waits for the auto mark-read", async () => {
		const calls = mailbox({ unseen: [20] });
		await renderMail();
		const release = hold("POST /mail/flags");
		fireEvent.click(screen.getByText("Bravo"));
		await screen.findByText("body of Bravo");
		await waitFor(() => expect(posted(calls, "/mail/flags")).toHaveLength(1));
		press("u");
		await new Promise((r) => setTimeout(r, 50));
		expect(posted(calls, "/mail/unflag")).toHaveLength(0); // mark-read still in flight
		release();
		await waitFor(() => expect(posted(calls, "/mail/unflag")).toHaveLength(1));
		expect(await screen.findByText(LIST_PLACEHOLDER)).toBeTruthy();
	});

	test("u marks the open message unread", async () => {
		const calls = mailbox();
		await renderMail();
		await open("Alpha");
		press("u");
		expect(await screen.findByText(LIST_PLACEHOLDER)).toBeTruthy();
		expect(posted(calls, "/mail/unflag")[0].body.uids).toEqual([30]);
	});

	test("s and u act on the selection in the list", async () => {
		const calls = mailbox();
		await renderMail();
		fireEvent.click(screen.getByText("Alpha").closest("[data-uid]").querySelector("input"));
		press("s");
		await waitFor(() =>
			expect(posted(calls, "/mail/flags")[0]?.body).toEqual({
				folder: "INBOX",
				uids: [30],
				action: "add",
				flags: ["\\Flagged"],
			}),
		);
		await waitFor(() => expect(screen.getByText("Alpha").closest("[data-uid]").querySelector("input").checked).toBe(false));
		fireEvent.click(screen.getByText("Bravo").closest("[data-uid]").querySelector("input"));
		press("u");
		await waitFor(() =>
			expect(posted(calls, "/mail/unflag")[0]?.body).toEqual({
				folder: "INBOX",
				uids: [20],
				action: "remove",
				flags: ["\\Seen"],
			}),
		);
	});

	test("j / k move to the next / previous message while reading", async () => {
		mailbox();
		await renderMail();
		await open("Bravo");
		press("j");
		await screen.findByText("body of Charlie");
		press("k");
		await screen.findByText("body of Bravo");
		press("k");
		await screen.findByText("body of Alpha");
	});

	test("the help lists the new shortcuts", async () => {
		mailbox();
		await renderMail();
		press("?");
		expect(screen.getByText("Star / unstar")).toBeTruthy();
		expect(screen.getByText("Mark unread")).toBeTruthy();
		expect(screen.getByText("Next / previous message (also while reading)")).toBeTruthy();
	});
});

describe("drag messages onto a folder", () => {
	const finePointer = () =>
		vi.spyOn(window, "matchMedia").mockImplementation((q) => ({
			matches: q.includes("pointer: fine"),
			media: q,
			addEventListener() {},
			removeEventListener() {},
		}));
	// happy-dom's DataTransfer is partial: a minimal stand-in.
	const dataTransfer = () => {
		const data = {};
		return {
			types: [],
			effectAllowed: "",
			dropEffect: "",
			setData(type, value) {
				data[type] = value;
				if (!this.types.includes(type)) this.types.push(type);
			},
			getData: (type) => data[type] || "",
			setDragImage: vi.fn(),
		};
	};
	const fire = (type, el, dt) => {
		const ev = createEvent[type](el);
		Object.defineProperty(ev, "dataTransfer", { value: dt });
		fireEvent(el, ev);
	};
	const dragTo = (subject, target) => {
		const dt = dataTransfer();
		fire("dragStart", screen.getByText(subject).closest("[data-uid]"), dt);
		fire("dragOver", target, dt);
		fire("drop", target, dt);
		return dt;
	};
	const folderButton = (name) =>
		within(screen.getByRole("navigation")).getByRole("button", { name });

	test("dropping a row on a folder moves it", async () => {
		finePointer();
		const calls = mailbox();
		await renderMail();
		const row = screen.getByText("Bravo").closest("[data-uid]");
		expect(row.getAttribute("draggable")).toBe("true");
		const dt = dragTo("Bravo", folderButton("Archive"));
		expect(JSON.parse(dt.getData(DRAG_MIME))).toEqual({ uids: [20], folder: "INBOX" });
		expect(dt.getData("text/plain")).toBe("1 message");
		await waitFor(() =>
			expect(posted(calls, "/mail/move")[0]?.body).toEqual({ uids: [20], from: "INBOX", to: "Archive" }),
		);
		expect(await screen.findByText("1 message moved to Archive")).toBeTruthy();
	});

	test("dragging a selected row carries the whole selection", async () => {
		finePointer();
		const calls = mailbox();
		await renderMail();
		fireEvent.click(screen.getByText("Alpha").closest("[data-uid]").querySelector("input"));
		fireEvent.click(screen.getByText("Bravo").closest("[data-uid]").querySelector("input"));
		const dt = dragTo("Bravo", folderButton("Archive"));
		expect(dt.getData("text/plain")).toBe("2 messages");
		await waitFor(() =>
			expect(posted(calls, "/mail/move")[0]?.body).toEqual({ uids: [30, 20], from: "INBOX", to: "Archive" }),
		);
	});

	test("dropping on Trash deletes via the delete path", async () => {
		finePointer();
		const calls = mailbox();
		await renderMail();
		dragTo("Charlie", folderButton("Trash"));
		await waitFor(() =>
			expect(posted(calls, "/mail/delete")[0]?.body).toEqual({ folder: "INBOX", uids: [10] }),
		);
	});

	test("dropping on the current folder, or a payload from another folder, does nothing", async () => {
		finePointer();
		const calls = mailbox();
		await renderMail();
		dragTo("Bravo", folderButton("INBOX"));
		const forged = dataTransfer();
		forged.setData(DRAG_MIME, JSON.stringify({ uids: [20], folder: "Elsewhere" }));
		fire("drop", folderButton("Archive"), forged);
		await new Promise((r) => setTimeout(r, 50));
		expect(posted(calls, "/mail/move")).toHaveLength(0);
		expect(posted(calls, "/mail/delete")).toHaveLength(0);
	});

	test("rows are not draggable without a fine pointer", async () => {
		vi.spyOn(window, "matchMedia").mockImplementation((q) => ({
			matches: false,
			media: q,
			addEventListener() {},
			removeEventListener() {},
		}));
		mailbox();
		await renderMail();
		expect(screen.getByText("Bravo").closest("[data-uid]").hasAttribute("draggable")).toBe(false);
	});
});

describe("compose undo countdown", () => {
	test("folder navigation is blocked while counting down and works again after Undo", async () => {
		const calls = mailbox();
		await renderMail();
		const nav = within(screen.getByRole("navigation"));
		fireEvent.click(screen.getByRole("button", { name: /compose|new message/i }));
		fireEvent.change(await screen.findByPlaceholderText("recipient@example.com"), { target: { value: "bob@x.io" } });
		fireEvent.click(screen.getByRole("button", { name: "Send" }));
		const undo = await screen.findByRole("button", { name: "Undo" });
		fireEvent.click(nav.getByRole("button", { name: "Archive" }));
		fireEvent.click(screen.getByText("Alpha"));
		expect(screen.getByRole("button", { name: "Undo" })).toBeTruthy(); // still composing, send still pending
		expect(screen.getByPlaceholderText("Subject")).toBeTruthy();
		await new Promise((r) => setTimeout(r, 450)); // past the double-click guard
		fireEvent.click(undo);
		await waitFor(() => expect(screen.queryByRole("button", { name: "Undo" })).toBeNull());
		fireEvent.click(nav.getByRole("button", { name: "Archive" }));
		await waitFor(() => expect(screen.queryByPlaceholderText("Subject")).toBeNull());
		expect(posted(calls, "/mail/send")).toHaveLength(0);
	});
});

describe("rename and delete folders", () => {
	const list = (subject, uid = 5) => ({ messages: [mk(uid, subject)], total: 1, page: 1, pageSize: 50 });
	// INBOX + system folders + "Projects" with a child "Projects/2026".
	function folderMailbox({ rename, remove } = {}) {
		let folders = [...FOLDERS, folder("Projects"), { ...folder("Projects/2026"), name: "2026" }];
		return mockApi({
			"GET /me": ME,
			"GET /mail/folders": () => folders,
			"GET /mail/messages/INBOX": list("Alpha", 30),
			"GET /mail/messages/Projects": list("Plans"),
			"GET /mail/messages/Projects%2F2026": list("Budget"),
			"GET /mail/messages/Work%2F2026": list("Budget"),
			"GET /mail/messages/Work": list("Plans"),
			"GET /filters": { rules: [] },
			"POST /mail/folders/rename": (b) => {
				const out = rename?.(b);
				if (out) return out;
				folders = folders.map((f) =>
					f.path.startsWith("Projects") ? { ...f, path: f.path.replace("Projects", b.newName), name: f.name === "Projects" ? b.newName : f.name } : f,
				);
				return { path: b.path, newPath: b.newName };
			},
			"POST /mail/folders/delete": (b) => {
				const out = remove?.(b);
				if (out) return out;
				folders = folders.filter((f) => f.path !== b.path);
				return { path: b.path, filtersAffected: false };
			},
		});
	}
	const nav = () => within(screen.getByRole("navigation"));
	const openFolder = async (name, subject) => {
		fireEvent.click(await nav().findByRole("button", { name }));
		await screen.findByText(subject);
	};
	const menu = async (name, item) => {
		fireEvent.click(await nav().findByRole("button", { name: `Folder actions for ${name}` }));
		fireEvent.click(await screen.findByRole("menuitem", { name: item }));
	};
	const heading = () => screen.getAllByRole("heading", { level: 2 })[0].textContent;

	test("system folders get no menu; user folders do", async () => {
		folderMailbox();
		await renderMail();
		await nav().findByRole("button", { name: "Folder actions for Projects" });
		expect(nav().getAllByRole("button", { name: /^Folder actions for/ }).map((b) => b.getAttribute("aria-label"))).toEqual([
			"Folder actions for Projects",
			"Folder actions for 2026",
		]);
	});

	test("renaming the parent of the open folder follows it to the new path", async () => {
		const calls = folderMailbox();
		await renderMail();
		await openFolder("2026", "Budget");
		await menu("Projects", "Rename");
		fireEvent.change(screen.getByLabelText("New name for Projects"), { target: { value: "Work" } });
		fireEvent.click(screen.getByRole("button", { name: "Rename" }));
		await waitFor(() => expect(heading()).toBe("Work/2026"));
		expect(posted(calls, "/mail/folders/rename").map((c) => c.body)).toEqual([{ path: "Projects", newName: "Work" }]);
		expect(await nav().findByRole("button", { name: "Work" })).toBeTruthy();
		expect(await screen.findByText(/Folder renamed to “Work”/)).toBeTruthy();
		expect(screen.queryByText(/Filter rules/)).toBeNull();
	});

	test("a 409 from rename stays inline in the form", async () => {
		folderMailbox({ rename: () => ({ status: 409, json: { success: false, message: "A folder with that name already exists." } }) });
		await renderMail();
		await menu("Projects", "Rename");
		fireEvent.change(screen.getByLabelText("New name for Projects"), { target: { value: "Archive" } });
		fireEvent.click(screen.getByRole("button", { name: "Rename" }));
		expect((await screen.findByText("A folder with that name already exists.")).getAttribute("role")).toBe("alert");
		expect(screen.getByLabelText("New name for Projects").value).toBe("Archive");
		expect(heading()).toBe("INBOX");
	});

	test("deleting the open folder falls back to INBOX", async () => {
		const calls = folderMailbox();
		await renderMail();
		await openFolder("Projects", "Plans");
		await menu("Projects", "Delete");
		fireEvent.click(await screen.findByRole("button", { name: "Delete folder" }));
		await waitFor(() => expect(heading()).toBe("INBOX"));
		await screen.findByText("Alpha");
		expect(posted(calls, "/mail/folders/delete").map((c) => c.body)).toEqual([{ path: "Projects" }]);
		await waitFor(() => expect(nav().queryByRole("button", { name: "Projects" })).toBeNull());
		expect(await screen.findByText("Folder deleted.")).toBeTruthy();
	});

	test("a 409 from delete is shown and nothing changes", async () => {
		folderMailbox({ remove: () => ({ status: 409, json: { success: false, message: "Only empty folders can be deleted. Move or delete its messages first." } }) });
		await renderMail();
		await openFolder("Projects", "Plans");
		await menu("Projects", "Delete");
		fireEvent.click(await screen.findByRole("button", { name: "Delete folder" }));
		const dialog = await screen.findByRole("alertdialog");
		expect((await within(dialog).findByRole("alert")).textContent).toContain("Only empty folders can be deleted. Move");
		expect(heading()).toBe("Projects");
		fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
		await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
	});

	test("shortcuts don't fire behind the delete confirmation", async () => {
		const calls = mockApi({
			"GET /me": ME,
			"GET /mail/folders": [...FOLDERS, folder("Projects")],
			"GET /mail/messages/INBOX": list("Alpha", 30),
			"GET /mail/message/INBOX/30": { ...mk(30, "Alpha"), folder: "INBOX", to: ME.mailbox, html: "", text: "body of Alpha", attachments: [] },
			"POST /mail/delete": { uids: [30], folder: "INBOX", trash: "Trash", inboxUnseen: 0, movedUids: [1] },
			"POST /mail/move": { inboxUnseen: 0 },
		});
		await renderMail();
		await open("Alpha");
		await menu("Projects", "Delete");
		const dialog = await screen.findByRole("alertdialog");
		const target = within(dialog).getByRole("button", { name: "Delete folder" });
		for (const key of ["#", "Delete", "e", "c", "j", "k"]) fireEvent.keyDown(target, { key });
		expect(posted(calls, "/mail/delete")).toHaveLength(0);
		expect(posted(calls, "/mail/move")).toHaveLength(0);
		expect(screen.queryByPlaceholderText("Subject")).toBeNull(); // "c" didn't open compose
		expect(screen.getByText("body of Alpha")).toBeTruthy();
	});

	test("filtersAffected warns and links to Settings → Filters", async () => {
		folderMailbox({ rename: (b) => ({ path: b.path, newPath: b.newName, filtersAffected: true }) });
		await renderMail();
		await menu("Projects", "Rename");
		fireEvent.change(screen.getByLabelText("New name for Projects"), { target: { value: "Work" } });
		fireEvent.click(screen.getByRole("button", { name: "Rename" }));
		expect(await screen.findByText(/Filter rules still point at the old folder/)).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "Review filters" }));
		const settings = await screen.findByRole("dialog", { name: /settings/i });
		expect(within(settings).getByRole("button", { name: "Filters" }).getAttribute("aria-current")).toBe("page");
	});
});
