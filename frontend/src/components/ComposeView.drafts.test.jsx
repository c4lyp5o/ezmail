import { act, fireEvent, render, screen } from "@testing-library/react";
import { StrictMode } from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { mockApi } from "../test/fetch.js";
import { resumeDraft } from "../utils/reply.js";
import ComposeView, { ATTACHMENT_BUDGET, DRAFT_SAVE_MS, UNDO_SEND_MS, UPLOADS_AT_RISK_PROMPT } from "./ComposeView.jsx";

vi.mock("../context/auth.jsx", () => ({
	useAuth: () => ({ user: { mailbox: "me@x.io" } }),
}));

const KEY = "ezmail_draft:me@x.io";
const SIG = "Ada Lovelace";

let calls;
let nextUid;
// A small Drafts store like the server's: each draft keeps its attachment
// names in composed order (uploads, then forwarded ones in `indexes` order),
// and a forwarded ref to a replaced draft or a missing index is a 400.
// Forwarded attachments over 25 MiB (sizes from `sizes`, by name) are a 502.
let store;
let sizes;
let lastSent;
const MiB = 1024 * 1024;
const notFound = { status: 400, json: { success: false, message: "Forwarded attachment not found" } };
const tooBig = { status: 502, json: { success: false, message: "Forwarded attachments exceed 25 MiB limit" } };
function compose(b) {
	const fwd = b.forwardAttachments;
	const src = fwd ? store.get(`${fwd.folder}/${fwd.uid}`) : [];
	if (!src || fwd?.indexes.some((i) => src[i] === undefined)) return notFound;
	const forwarded = fwd ? fwd.indexes.map((i) => src[i]) : [];
	if (forwarded.reduce((n, name) => n + (sizes.get(name) || 0), 0) > 25 * MiB) return tooBig;
	return [...(b.attachments || []).map((a) => a.filename), ...forwarded];
}
// `uid: false` answers like a server that can't report the new UID, keeping
// the old copy when the save forwarded its attachments (backend safety net).
const saveDraft = ({ uid: withUid = true } = {}) => (b) => {
	const files = compose(b);
	if (!Array.isArray(files)) return files;
	const uid = nextUid++;
	store.set(`Drafts/${uid}`, files);
	if (!b.replaces) return withUid ? { uid, folder: "Drafts" } : { folder: "Drafts" };
	const strands = !withUid && b.forwardAttachments?.folder === "Drafts" && b.forwardAttachments.uid === b.replaces;
	const replaced = !strands && store.delete(`Drafts/${b.replaces}`);
	return withUid ? { uid, folder: "Drafts", replaced } : { folder: "Drafts", replaced };
};
const routes = (more = {}) => {
	calls = mockApi({
		"GET /profile": { displayName: "", signature: "" },
		"POST /mail/send": (b) => {
			const files = compose(b);
			if (!Array.isArray(files)) return files;
			lastSent = files;
			return { savedToSent: true };
		},
		"POST /mail/drafts": saveDraft(),
		"POST /mail/drafts/discard": (b) => ({ uid: b.uid, removed: store.delete(`Drafts/${b.uid}`), folder: "Drafts" }),
		...more,
	});
};
beforeEach(() => {
	nextUid = 7;
	store = new Map();
	sizes = new Map();
	lastSent = null;
	routes();
});

const drafts = () => calls.filter((c) => c.method === "POST" && c.path === "/mail/drafts");
const discards = () => calls.filter((c) => c.path === "/mail/drafts/discard");
const sends = () => calls.filter((c) => c.path === "/mail/send");
const type = (placeholder, value) =>
	fireEvent.change(screen.getByPlaceholderText(placeholder), { target: { value } });
const body = () => screen.getByPlaceholderText(/Write your message/);

// Only timers and the clock are faked: fetch/Response settle on real microtasks
// and immediates. vi.waitFor nudges the fake clock while it polls, so every
// wait below is for a processed response (UI or storage), not a recorded call.
const fakeTimers = () => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
const advance = (ms) => act(async () => { vi.advanceTimersByTime(ms); });
// Polls outside act (as Testing Library's waitFor does), so React applies
// updates from responses as they arrive instead of queueing them until the end.
// Then flushes effects still pending for that render (e.g. the one that
// starts the save timer), so a following advance() can't overtake them.
async function settle(fn) {
	const prev = globalThis.IS_REACT_ACT_ENVIRONMENT;
	globalThis.IS_REACT_ACT_ENVIRONMENT = false;
	try {
		await vi.waitFor(fn, { timeout: 5000 });
	} finally {
		globalThis.IS_REACT_ACT_ENVIRONMENT = prev;
	}
	await act(async () => {});
}
const savedStatus = () => expect(screen.getByText("Draft saved to Drafts")).toBeTruthy();
const upload = (container, ...files) =>
	fireEvent.change(container.querySelector('input[type="file"]'), { target: { files } });
// Holds the response of the next POST /mail/drafts until released.
function holdNextSave() {
	const real = globalThis.fetch;
	let release;
	const gate = new Promise((r) => { release = r; });
	let held = false;
	vi.stubGlobal("fetch", async (url, init) => {
		const res = await real(url, init);
		if (String(url).endsWith("/mail/drafts") && !held) {
			held = true;
			await gate;
		}
		return res;
	});
	return release;
}

describe("saving to the server", () => {
	test("closing with content saves once, and the request outlives the composer", async () => {
		fakeTimers();
		const onBack = vi.fn();
		const { unmount } = render(<ComposeView onBack={onBack} />);
		type("recipient@example.com", "bob@x.io");
		type("Subject", "Plans");
		fireEvent.change(body(), { target: { value: "See you" } });
		fireEvent.click(screen.getByText("Back"));
		unmount(); // the parent unmounts right away
		expect(onBack).toHaveBeenCalled();
		// The response still lands: the local draft learns the server UID.
		await settle(() => expect(JSON.parse(localStorage.getItem(KEY)).draftUid).toBe(7));
		expect(drafts()).toHaveLength(1);
		expect(drafts()[0].body).toMatchObject({ to: "bob@x.io", subject: "Plans", text: "See you", markdown: false, attachments: [] });
		expect(drafts()[0].body.replaces).toBeUndefined();

		// Reopening restores that draft and the next save replaces the same copy.
		render(<ComposeView onBack={() => {}} />);
		expect(screen.getByPlaceholderText("Subject").value).toBe("Plans");
		type("Subject", "Plans v2");
		fireEvent.click(screen.getByText("Back"));
		await settle(() => expect(JSON.parse(localStorage.getItem(KEY)).draftUid).toBe(8));
		expect(drafts()).toHaveLength(2);
		expect(drafts()[1].body).toMatchObject({ subject: "Plans v2", replaces: 7 });
	});

	test("saves every 30 s only when changed, replacing the previous copy", async () => {
		fakeTimers();
		render(<ComposeView onBack={() => {}} />);
		type("Subject", "One");
		await advance(DRAFT_SAVE_MS - 1);
		expect(drafts()).toHaveLength(0);
		await advance(1);
		await settle(savedStatus);
		expect(drafts()).toHaveLength(1);
		expect(drafts()[0].body.replaces).toBeUndefined();
		expect(screen.getByText("Draft saved to Drafts").getAttribute("aria-live")).toBe("polite");

		await advance(DRAFT_SAVE_MS * 3); // nothing changed
		expect(drafts()).toHaveLength(1);

		type("Subject", "Two");
		await advance(DRAFT_SAVE_MS);
		await settle(savedStatus);
		expect(drafts()).toHaveLength(2);
		expect(drafts()[1].body).toMatchObject({ subject: "Two", replaces: 7 });
	});

	test("without a uid in the reply, periodic saves stop and close saves once more", async () => {
		routes({ "POST /mail/drafts": { folder: "Drafts" } });
		fakeTimers();
		const { unmount } = render(<ComposeView onBack={() => {}} />);
		type("Subject", "One");
		await advance(DRAFT_SAVE_MS);
		await settle(savedStatus);
		type("Subject", "Two");
		await advance(DRAFT_SAVE_MS * 3);
		expect(drafts()).toHaveLength(1);
		fireEvent.click(screen.getByText("Back"));
		unmount();
		await settle(() => expect(drafts()).toHaveLength(2));
		expect(drafts()[1].body).toMatchObject({ subject: "Two" });
		expect(drafts()[1].body.replaces).toBeUndefined();
		await advance(DRAFT_SAVE_MS * 2);
		expect(drafts()).toHaveLength(2);
	});

	test("no save during the send countdown; Send cancels the pending periodic save", async () => {
		fakeTimers();
		render(<ComposeView onBack={() => {}} initial={{ form: { to: "bob@x.io" } }} />);
		type("Subject", "Hi");
		await advance(DRAFT_SAVE_MS - 1000);
		fireEvent.click(screen.getByText("Send"));
		await advance(UNDO_SEND_MS);
		await settle(() => expect(screen.getByText(/Message sent/)).toBeTruthy());
		await advance(DRAFT_SAVE_MS * 2);
		expect(sends()).toHaveLength(1);
		expect(drafts()).toHaveLength(0);
		expect(discards()).toHaveLength(0); // nothing was ever stored
	});

	test("a successful send discards the server draft, then tells the parent", async () => {
		fakeTimers();
		const onSent = vi.fn();
		render(<ComposeView onBack={() => {}} onSent={onSent} initial={{ form: { to: "bob@x.io" } }} />);
		type("Subject", "Hi");
		await advance(DRAFT_SAVE_MS);
		await settle(savedStatus);
		fireEvent.click(screen.getByText("Send"));
		await advance(UNDO_SEND_MS);
		await settle(() => expect(onSent).toHaveBeenCalled());
		expect(discards().map((c) => c.body)).toEqual([{ uid: 7 }]);
		expect(drafts()).toHaveLength(1);
	});

	test("Discard asks first when a copy is in Drafts; Cancel keeps everything", async () => {
		localStorage.setItem(KEY, JSON.stringify({ form: { to: "x@y.z" }, draftUid: 5 }));
		const confirm = vi.fn(() => false);
		vi.stubGlobal("confirm", confirm);
		const onBack = vi.fn();
		render(<ComposeView onBack={onBack} />);
		fireEvent.click(screen.getByTitle("Discard draft"));
		expect(confirm).toHaveBeenCalledWith("Delete this draft from Drafts?");
		expect(onBack).not.toHaveBeenCalled();
		expect(screen.getByLabelText("To").value).toBe("x@y.z");
		await act(async () => {});
		expect(discards()).toHaveLength(0);
		expect(JSON.parse(localStorage.getItem(KEY)).draftUid).toBe(5);
	});

	test("Discard without a copy in Drafts doesn't ask", () => {
		localStorage.setItem(KEY, JSON.stringify({ form: { to: "x@y.z" } }));
		const confirm = vi.fn(() => true);
		vi.stubGlobal("confirm", confirm);
		const onBack = vi.fn();
		render(<ComposeView onBack={onBack} />);
		fireEvent.click(screen.getByTitle("Discard draft"));
		expect(confirm).not.toHaveBeenCalled();
		expect(onBack).toHaveBeenCalled();
		expect(localStorage.getItem(KEY)).toBeNull();
	});

	test("Discard removes the server draft and saves nothing", async () => {
		localStorage.setItem(KEY, JSON.stringify({ form: { to: "x@y.z" }, draftUid: 5 }));
		vi.stubGlobal("confirm", vi.fn(() => true));
		const onBack = vi.fn();
		const onDraftsChange = vi.fn();
		const { unmount } = render(<ComposeView onBack={onBack} onDraftsChange={onDraftsChange} />);
		fireEvent.click(screen.getByTitle("Discard draft"));
		unmount();
		await settle(() => expect(onDraftsChange).toHaveBeenCalled());
		expect(discards().map((c) => c.body)).toEqual([{ uid: 5 }]);
		expect(drafts()).toHaveLength(0);
		expect(localStorage.getItem(KEY)).toBeNull();
	});

	test("a save answered after Discard is removed instead of resurrected", async () => {
		const real = globalThis.fetch;
		let release;
		const gate = new Promise((r) => { release = r; });
		vi.stubGlobal("fetch", async (url, init) => {
			const res = await real(url, init);
			if (String(url).endsWith("/mail/drafts")) await gate;
			return res;
		});
		fakeTimers();
		render(<ComposeView onBack={() => {}} />);
		type("Subject", "Late");
		await advance(DRAFT_SAVE_MS);
		await settle(() => expect(screen.getByText("Saving draft…")).toBeTruthy());
		fireEvent.click(screen.getByTitle("Discard draft"));
		release();
		await settle(() => expect(discards().map((c) => c.body)).toEqual([{ uid: 7 }]));
		expect(localStorage.getItem(KEY)).toBeNull();
	});

	test("a failed save says device only and doesn't block sending", async () => {
		routes({ "POST /mail/drafts": { status: 502, json: { success: false, message: "imap down" } } });
		fakeTimers();
		render(<ComposeView onBack={() => {}} initial={{ form: { to: "bob@x.io" } }} />);
		type("Subject", "Hi");
		await advance(DRAFT_SAVE_MS);
		await settle(() => expect(screen.getByText("Draft saved on this device only")).toBeTruthy());
		expect(JSON.parse(localStorage.getItem(KEY)).form.subject).toBe("Hi"); // local copy still there
		expect(screen.getByLabelText("To").closest("fieldset").disabled).toBe(false);
		fireEvent.click(screen.getByText("Send"));
		await advance(UNDO_SEND_MS);
		await settle(() => expect(screen.getByText(/Message sent/)).toBeTruthy());
		expect(sends()).toHaveLength(1);
	});

	test("saves never overlap; one more runs afterwards with the latest content", async () => {
		const real = globalThis.fetch;
		let release;
		const gate = new Promise((r) => { release = r; });
		let held = false;
		vi.stubGlobal("fetch", async (url, init) => {
			const res = await real(url, init);
			if (String(url).endsWith("/mail/drafts") && !held) {
				held = true;
				await gate;
			}
			return res;
		});
		fakeTimers();
		render(<ComposeView onBack={() => {}} />);
		type("Subject", "First");
		await advance(DRAFT_SAVE_MS);
		await settle(() => expect(screen.getByText("Saving draft…")).toBeTruthy());
		type("Subject", "Second");
		await advance(DRAFT_SAVE_MS); // due while the first is still out
		type("Subject", "Third");
		expect(drafts()).toHaveLength(1);
		release();
		await settle(() => expect(drafts()).toHaveLength(2));
		await settle(savedStatus);
		expect(drafts()[1].body).toMatchObject({ subject: "Third", replaces: 7 });
		await advance(DRAFT_SAVE_MS * 2);
		expect(drafts()).toHaveLength(2);
	});

	test("an empty or signature-only composer creates no server draft", async () => {
		routes({ "GET /profile": { displayName: "", signature: SIG } });
		fakeTimers();
		const { unmount } = render(<ComposeView onBack={() => {}} />);
		await settle(() => expect(body().value).toBe(`\n\n-- \n${SIG}`));
		await advance(DRAFT_SAVE_MS * 2);
		fireEvent.click(screen.getByText("Back"));
		unmount();
		await act(async () => {});
		expect(drafts()).toHaveLength(0);
	});

	test("large uploads are not saved periodically, only on close", async () => {
		vi.stubGlobal("confirm", vi.fn(() => true));
		const { container, unmount } = render(<ComposeView onBack={() => {}} initial={{ form: { to: "bob@x.io" } }} />);
		const big = new File(["x".repeat(1.6 * 1024 * 1024)], "big.bin", { type: "application/octet-stream" });
		fireEvent.change(container.querySelector('input[type="file"]'), { target: { files: [big] } });
		await screen.findByText("big.bin");
		fakeTimers();
		type("Subject", "With file");
		await advance(DRAFT_SAVE_MS * 3);
		expect(drafts()).toHaveLength(0);
		fireEvent.click(screen.getByText("Back"));
		unmount();
		await settle(() => expect(drafts()).toHaveLength(1));
		expect(drafts()[0].body.attachments[0]).toMatchObject({ filename: "big.bin", contentType: "application/octet-stream" });
		expect(drafts()[0].body.attachments[0].content.length).toBeGreaterThan(2 * 1024 * 1024);
	});
});

describe("resuming a server draft", () => {
	const draftMsg = {
		uid: 42,
		subject: "Re: Plans",
		to: "bob@x.io",
		cc: "carol@x.io",
		bcc: "quiet@x.io",
		text: `Almost done\n\n-- \n${SIG}`,
		inReplyTo: "<m1@x>",
		references: "<m0@x> <m1@x>",
		flags: ["\\Seen", "\\Draft"],
		attachments: [
			{ index: 0, filename: "logo.png", contentType: "image/png", size: 9, related: true },
			{ index: 1, filename: "plan.pdf", contentType: "application/pdf", size: 1024 },
		],
	};
	beforeEach(() => {
		store.set("Drafts/42", ["logo.png", "plan.pdf"]);
	});

	test("fills the composer without signing or quoting again; the next save replaces it", async () => {
		routes({ "GET /profile": { displayName: "", signature: SIG } });
		localStorage.setItem(KEY, JSON.stringify({ form: { subject: "Local draft" } }));
		fakeTimers();
		const { unmount } = render(<ComposeView onBack={() => {}} initial={resumeDraft(draftMsg, "Drafts")} />);
		await act(async () => {});
		expect(screen.getByText("Edit draft")).toBeTruthy();
		expect(screen.getByLabelText("To").value).toBe("bob@x.io");
		expect(screen.getByLabelText("Cc").value).toBe("carol@x.io");
		expect(screen.getByLabelText("Bcc").value).toBe("quiet@x.io");
		expect(screen.getByPlaceholderText("Subject").value).toBe("Re: Plans");
		expect(body().value).toBe(`Almost done\n\n-- \n${SIG}`);
		expect(screen.getByLabelText("Markdown").checked).toBe(false);
		expect(screen.getByText("plan.pdf")).toBeTruthy();
		expect(screen.queryByText("logo.png")).toBeNull();
		expect(calls.some((c) => c.path === "/profile")).toBe(false);

		await advance(DRAFT_SAVE_MS * 2); // unchanged: the server copy is current
		expect(drafts()).toHaveLength(0);

		fireEvent.change(body(), { target: { value: `Done\n\n-- \n${SIG}` } });
		fireEvent.click(screen.getByText("Back"));
		unmount();
		await settle(() => expect(JSON.parse(localStorage.getItem(KEY)).draftUid).toBe(7));
		expect(drafts()).toHaveLength(1);
		expect(drafts()[0].body).toMatchObject({
			to: "bob@x.io",
			cc: "carol@x.io",
			bcc: "quiet@x.io",
			subject: "Re: Plans",
			text: `Done\n\n-- \n${SIG}`,
			markdown: false,
			inReplyTo: "<m1@x>",
			references: "<m0@x> <m1@x>",
			forwardAttachments: { folder: "Drafts", uid: 42, indexes: [1] },
			replaces: 42,
		});
		// The server draft replaced the older local one.
		expect(JSON.parse(localStorage.getItem(KEY)).form.subject).toBe("Re: Plans");
	});

	test("sending a resumed draft discards it", async () => {
		fakeTimers();
		const onSent = vi.fn();
		render(<ComposeView onBack={() => {}} onSent={onSent} initial={resumeDraft(draftMsg, "Drafts")} />);
		fireEvent.click(screen.getByText("Send"));
		await advance(UNDO_SEND_MS);
		await settle(() => expect(onSent).toHaveBeenCalled());
		expect(sends()[0].body).toMatchObject({ bcc: "quiet@x.io", inReplyTo: "<m1@x>", forwardAttachments: { folder: "Drafts", uid: 42, indexes: [1] } });
		expect(discards().map((c) => c.body)).toEqual([{ uid: 42 }]);
		expect(drafts()).toHaveLength(0);
	});

	// Related part at 0 is dropped on resume, so the files sit at 1 and 2.
	const twoFiles = {
		...draftMsg,
		attachments: [
			{ index: 0, filename: "logo.png", contentType: "image/png", size: 9, related: true },
			{ index: 1, filename: "a.pdf", contentType: "application/pdf", size: 10 },
			{ index: 2, filename: "b.pdf", contentType: "application/pdf", size: 20 },
		],
	};
	const fwd = (c) => c.body.forwardAttachments;

	test("attachment refs follow each new copy: save, save with an upload, send", async () => {
		store.set("Drafts/42", ["logo.png", "a.pdf", "b.pdf"]);
		const onSent = vi.fn();
		const { container } = render(<ComposeView onBack={() => {}} onSent={onSent} initial={resumeDraft(twoFiles, "Drafts")} />);
		fakeTimers();
		type("Subject", "v1");
		await advance(DRAFT_SAVE_MS);
		await settle(savedStatus);
		expect(fwd(drafts()[0])).toEqual({ folder: "Drafts", uid: 42, indexes: [1, 2] });
		expect(store.has("Drafts/42")).toBe(false);

		const file = new File(["hello"], "c.txt", { type: "text/plain" });
		fireEvent.change(container.querySelector('input[type="file"]'), { target: { files: [file] } });
		await settle(() => expect(screen.getByText("c.txt")).toBeTruthy());
		await advance(DRAFT_SAVE_MS);
		await settle(() => expect(drafts()).toHaveLength(2));
		await settle(savedStatus);
		expect(fwd(drafts()[1])).toEqual({ folder: "Drafts", uid: 7, indexes: [0, 1] });
		expect(drafts()[1].body.attachments.map((a) => a.filename)).toEqual(["c.txt"]);
		expect(store.get("Drafts/8")).toEqual(["c.txt", "a.pdf", "b.pdf"]);

		// The upload is now a ref into the stored copy: removable, never re-sent.
		fireEvent.click(screen.getByLabelText("Remove b.pdf"));
		fireEvent.click(screen.getByText("Send"));
		await advance(UNDO_SEND_MS);
		await settle(() => expect(onSent).toHaveBeenCalled());
		expect(sends()[0].body.attachments).toEqual([]);
		expect(fwd(sends()[0])).toEqual({ folder: "Drafts", uid: 8, indexes: [1, 0] });
		expect(lastSent).toEqual(["a.pdf", "c.txt"]);
		expect(discards().map((c) => c.body)).toEqual([{ uid: 8 }]);
	});

	test("the moved refs survive close and restore from the local draft", async () => {
		store.set("Drafts/42", ["logo.png", "a.pdf", "b.pdf"]);
		fakeTimers();
		const first = render(<ComposeView onBack={() => {}} initial={resumeDraft(twoFiles, "Drafts")} />);
		type("Subject", "edited");
		fireEvent.click(screen.getByText("Back"));
		first.unmount();
		await settle(() => expect(JSON.parse(localStorage.getItem(KEY)).draftUid).toBe(7));
		expect(JSON.parse(localStorage.getItem(KEY)).attachments.map((a) => a.forward)).toEqual([
			{ folder: "Drafts", uid: 7, index: 0 },
			{ folder: "Drafts", uid: 7, index: 1 },
		]);

		const onSent = vi.fn();
		render(<ComposeView onBack={() => {}} onSent={onSent} />);
		expect(screen.getByText("a.pdf")).toBeTruthy();
		expect(screen.getByText("b.pdf")).toBeTruthy();
		fireEvent.click(screen.getByText("Send"));
		await advance(UNDO_SEND_MS);
		await settle(() => expect(onSent).toHaveBeenCalled());
		expect(fwd(sends()[0])).toEqual({ folder: "Drafts", uid: 7, indexes: [0, 1] });
		expect(lastSent).toEqual(["a.pdf", "b.pdf"]);
		expect(discards().map((c) => c.body)).toEqual([{ uid: 7 }]);
	});

	test("without a uid in the reply the refs stay on the kept copy and still send", async () => {
		store.set("Drafts/42", ["logo.png", "a.pdf", "b.pdf"]);
		routes({ "POST /mail/drafts": saveDraft({ uid: false }) });
		fakeTimers();
		const onSent = vi.fn();
		render(<ComposeView onBack={() => {}} onSent={onSent} initial={resumeDraft(twoFiles, "Drafts")} />);
		type("Subject", "edited");
		await advance(DRAFT_SAVE_MS);
		await settle(savedStatus);
		expect(store.has("Drafts/42")).toBe(true);
		fireEvent.click(screen.getByText("Send"));
		await advance(UNDO_SEND_MS);
		await settle(() => expect(onSent).toHaveBeenCalled());
		expect(fwd(sends()[0])).toEqual({ folder: "Drafts", uid: 42, indexes: [1, 2] });
		expect(lastSent).toEqual(["a.pdf", "b.pdf"]);
		expect(discards().map((c) => c.body)).toEqual([{ uid: 42 }]);
	});

	test("a resumed markdown draft's escaped signature is not escaped again", async () => {
		const escaped = "Hi\n\n-- \n\n\\*Ada\\*";
		store.set("Drafts/42", []);
		fakeTimers();
		render(<ComposeView onBack={() => {}} initial={resumeDraft({ ...draftMsg, text: escaped, attachments: [] }, "Drafts")} />);
		expect(body().value).toBe(escaped);
		fireEvent.click(screen.getByLabelText("Markdown"));
		fireEvent.click(screen.getByText("Send"));
		await advance(UNDO_SEND_MS);
		await settle(() => expect(sends()).toHaveLength(1));
		expect(sends()[0].body).toMatchObject({ markdown: true, text: escaped });
	});
});

describe("StrictMode and leaving", () => {
	test("the dev double mount saves nothing; closing saves once", async () => {
		routes({ "GET /profile": { displayName: "", signature: SIG } });
		const { unmount } = render(
			<StrictMode>
				<ComposeView onBack={() => {}} initial={{ form: { to: "bob@x.io", subject: "Re: x", text: "\n\n> quoted" } }} />
			</StrictMode>,
		);
		await settle(() => expect(body().value).toBe(`\n\n-- \n${SIG}\n\n> quoted`)); // signed once
		await act(async () => {});
		expect(drafts()).toHaveLength(0);
		expect(discards()).toHaveLength(0);
		unmount();
		await settle(() => expect(drafts()).toHaveLength(1));
		expect(drafts()[0].body).toMatchObject({ to: "bob@x.io", subject: "Re: x" });
	});

	test("Back with an unsaved upload waits for the save, then closes", async () => {
		const confirm = vi.fn(() => true);
		vi.stubGlobal("confirm", confirm);
		const release = holdNextSave();
		const onBack = vi.fn();
		const onBusyChange = vi.fn();
		const { container } = render(<ComposeView onBack={onBack} onBusyChange={onBusyChange} initial={{ form: { to: "bob@x.io" } }} />);
		upload(container, new File(["hi"], "a.txt", { type: "text/plain" }));
		await screen.findByText("a.txt");
		fireEvent.click(screen.getByText("Back"));
		await settle(() => expect(screen.getByText("Saving draft…")).toBeTruthy());
		expect(onBack).not.toHaveBeenCalled();
		expect(onBusyChange.mock.calls.every(([busy]) => !busy)).toBe(true); // the parent is never held
		release();
		await settle(() => expect(onBack).toHaveBeenCalledTimes(1));
		expect(confirm).not.toHaveBeenCalled();
		expect(drafts()).toHaveLength(1);
		expect(drafts()[0].body.attachments.map((a) => a.filename)).toEqual(["a.txt"]);
	});

	test("a failed save keeps the composer open and asks; confirming leaves", async () => {
		routes({ "POST /mail/drafts": { status: 502, json: { success: false, message: "down" } } });
		const confirm = vi.fn(() => false);
		vi.stubGlobal("confirm", confirm);
		const onBack = vi.fn();
		const onUploadsChange = vi.fn();
		const { container } = render(<ComposeView onBack={onBack} onUploadsChange={onUploadsChange} initial={{ form: { to: "bob@x.io" } }} />);
		upload(container, new File(["hi"], "a.txt", { type: "text/plain" }));
		await screen.findByText("a.txt");
		fireEvent.click(screen.getByText("Back"));
		await settle(() => expect(confirm).toHaveBeenCalledWith(UPLOADS_AT_RISK_PROMPT));
		expect(onBack).not.toHaveBeenCalled();
		expect(screen.getByText("a.txt")).toBeTruthy();
		expect(screen.getByText("Draft saved on this device only")).toBeTruthy();
		expect(onUploadsChange.mock.calls.at(-1)[0]).toBe(true); // MailPage's guard asks too

		confirm.mockReturnValue(true);
		fireEvent.click(screen.getByText("Back")); // tries once more, then asks again
		await settle(() => expect(onBack).toHaveBeenCalledTimes(1));
		expect(drafts()).toHaveLength(2);
	});

	test("a second Back while the save hangs lets the user leave", async () => {
		const confirm = vi.fn(() => true);
		vi.stubGlobal("confirm", confirm);
		const release = holdNextSave();
		const onBack = vi.fn();
		const { container } = render(<ComposeView onBack={onBack} initial={{ form: { to: "bob@x.io" } }} />);
		upload(container, new File(["hi"], "a.txt", { type: "text/plain" }));
		await screen.findByText("a.txt");
		fireEvent.click(screen.getByText("Back"));
		await settle(() => expect(screen.getByText("Saving draft…")).toBeTruthy());
		fireEvent.click(screen.getByText("Back"));
		expect(confirm).toHaveBeenCalledWith(UPLOADS_AT_RISK_PROMPT);
		expect(onBack).toHaveBeenCalledTimes(1);
		release();
		await settle(() => expect(screen.getByText("Draft saved to Drafts")).toBeTruthy());
		expect(onBack).toHaveBeenCalledTimes(1); // the late answer doesn't close twice
	});

	test("a failed close-time save after a parent-driven unmount is reported", async () => {
		routes({ "POST /mail/drafts": { status: 502, json: { success: false, message: "down" } } });
		const onDraftSaveFailed = vi.fn();
		const { container, unmount } = render(<ComposeView onBack={() => {}} onDraftSaveFailed={onDraftSaveFailed} initial={{ form: { to: "bob@x.io" } }} />);
		upload(container, new File(["hi"], "a.txt", { type: "text/plain" }));
		await screen.findByText("a.txt");
		unmount(); // e.g. MailPage switched folders
		await settle(() => expect(onDraftSaveFailed).toHaveBeenCalledWith({ hadUploads: true }));
		expect(onDraftSaveFailed).toHaveBeenCalledTimes(1);
	});

	test("a failed save while the composer is open is only shown inline", async () => {
		routes({ "POST /mail/drafts": { status: 502, json: { success: false, message: "down" } } });
		const onDraftSaveFailed = vi.fn();
		fakeTimers();
		render(<ComposeView onBack={() => {}} onDraftSaveFailed={onDraftSaveFailed} />);
		type("Subject", "Hi");
		await advance(DRAFT_SAVE_MS);
		await settle(() => expect(screen.getByText("Draft saved on this device only")).toBeTruthy());
		expect(onDraftSaveFailed).not.toHaveBeenCalled();
	});
});

describe("attachment budget", () => {
	test("files that would take attachments past the budget are refused", async () => {
		const { container } = render(
			<ComposeView
				onBack={() => {}}
				initial={{ form: { to: "bob@x.io" }, attachments: [{ filename: "big.pdf", size: 24.5 * MiB, forward: { folder: "INBOX", uid: 5, index: 0 } }] }}
			/>,
		);
		upload(container, new File(["x".repeat(MiB)], "more.bin"));
		expect(await screen.findByText(/exceed 24 MiB in total/)).toBeTruthy();
		expect(screen.queryByText("more.bin")).toBeNull();
		expect(ATTACHMENT_BUDGET).toBe(24 * MiB);
	});

	test("uploads that would push refs over the forwarding limit stay uploads; it still sends", async () => {
		store.set("INBOX/5", ["big.pdf"]);
		sizes.set("big.pdf", 24.5 * MiB).set("up.bin", MiB);
		fakeTimers();
		const onSent = vi.fn();
		render(
			<ComposeView
				onBack={() => {}}
				onSent={onSent}
				initial={{
					form: { to: "bob@x.io" },
					attachments: [
						{ filename: "big.pdf", contentType: "application/pdf", size: 24.5 * MiB, forward: { folder: "INBOX", uid: 5, index: 0 } },
						{ filename: "up.bin", contentType: "application/octet-stream", size: MiB, content: btoa("bytes") },
					],
				}}
			/>,
		);
		type("Subject", "Big");
		await advance(DRAFT_SAVE_MS);
		await settle(savedStatus);
		expect(store.get("Drafts/7")).toEqual(["up.bin", "big.pdf"]);

		// The big ref now points into this draft: periodic saves stop (close only).
		type("Subject", "Big v2");
		await advance(DRAFT_SAVE_MS * 2);
		expect(drafts()).toHaveLength(1);

		fireEvent.click(screen.getByText("Send"));
		await advance(UNDO_SEND_MS);
		await settle(() => expect(onSent).toHaveBeenCalled());
		expect(sends()[0].body.attachments).toEqual([{ filename: "up.bin", contentType: "application/octet-stream", content: btoa("bytes") }]);
		expect(sends()[0].body.forwardAttachments).toEqual({ folder: "Drafts", uid: 7, indexes: [1] });
		expect(lastSent).toEqual(["up.bin", "big.pdf"]);
	});

	test("refs over 2 MiB in the current draft are saved on close only", async () => {
		store.set("Drafts/42", ["scan.pdf"]);
		fakeTimers();
		const { unmount } = render(
			<ComposeView
				onBack={() => {}}
				initial={resumeDraft({ uid: 42, subject: "Scan", text: "x", attachments: [{ index: 0, filename: "scan.pdf", contentType: "application/pdf", size: 3 * MiB }] }, "Drafts")}
			/>,
		);
		type("Subject", "Scan v2");
		await advance(DRAFT_SAVE_MS * 2);
		expect(drafts()).toHaveLength(0);
		unmount();
		await settle(() => expect(drafts()).toHaveLength(1));
		expect(drafts()[0].body).toMatchObject({ subject: "Scan v2", replaces: 42, forwardAttachments: { folder: "Drafts", uid: 42, indexes: [0] } });
	});
});

describe("saves racing other actions", () => {
	const twoFiles = {
		uid: 42,
		subject: "Plans",
		to: "bob@x.io",
		text: "draft",
		flags: ["\\Seen", "\\Draft"],
		attachments: [
			{ index: 0, filename: "logo.png", contentType: "image/png", size: 9, related: true },
			{ index: 1, filename: "a.pdf", contentType: "application/pdf", size: 10 },
			{ index: 2, filename: "b.pdf", contentType: "application/pdf", size: 20 },
		],
	};
	beforeEach(() => {
		store.set("Drafts/42", ["logo.png", "a.pdf", "b.pdf"]);
	});

	test("reopening while the close-time save is out waits, then restores the new copy", async () => {
		const release = holdNextSave();
		const first = render(<ComposeView onBack={() => {}} initial={resumeDraft(twoFiles, "Drafts")} />);
		type("Subject", "edited");
		fireEvent.click(screen.getByText("Back"));
		first.unmount();
		await settle(() => expect(drafts()).toHaveLength(1));

		const onSent = vi.fn();
		render(<ComposeView onBack={() => {}} onSent={onSent} />);
		expect(screen.getByRole("status").textContent).toBe("Saving your previous draft…");
		expect(screen.queryByPlaceholderText("Subject")).toBeNull();
		release();
		await settle(() => expect(screen.getByPlaceholderText("Subject").value).toBe("edited"));
		expect(store.has("Drafts/42")).toBe(false);

		fakeTimers();
		fireEvent.click(screen.getByText("Send"));
		await advance(UNDO_SEND_MS);
		await settle(() => expect(onSent).toHaveBeenCalled());
		expect(sends()[0].body.forwardAttachments).toEqual({ folder: "Drafts", uid: 7, indexes: [0, 1] });
		expect(lastSent).toEqual(["a.pdf", "b.pdf"]);
		expect(discards().map((c) => c.body)).toEqual([{ uid: 7 }]);
		expect([...store.keys()].filter((k) => k.startsWith("Drafts/"))).toEqual([]); // no duplicate left
	});

	test("Send waits for a save already out and uses the copy it made", async () => {
		const release = holdNextSave();
		fakeTimers();
		const onSent = vi.fn();
		render(<ComposeView onBack={() => {}} onSent={onSent} initial={resumeDraft(twoFiles, "Drafts")} />);
		type("Subject", "edited");
		await advance(DRAFT_SAVE_MS);
		await settle(() => expect(screen.getByText("Saving draft…")).toBeTruthy());
		fireEvent.click(screen.getByText("Send"));
		await advance(UNDO_SEND_MS);
		await act(async () => {});
		expect(sends()).toHaveLength(0); // still waiting for the save
		release();
		await settle(() => expect(onSent).toHaveBeenCalled());
		expect(sends()[0].body.forwardAttachments).toEqual({ folder: "Drafts", uid: 7, indexes: [0, 1] });
		expect(lastSent).toEqual(["a.pdf", "b.pdf"]);
	});

	test("chips added or removed while a save is out stay that way", async () => {
		const release = holdNextSave();
		fakeTimers();
		const onSent = vi.fn();
		const { container } = render(<ComposeView onBack={() => {}} onSent={onSent} initial={resumeDraft(twoFiles, "Drafts")} />);
		type("Subject", "edited");
		await advance(DRAFT_SAVE_MS);
		await settle(() => expect(screen.getByText("Saving draft…")).toBeTruthy());
		fireEvent.click(screen.getByLabelText("Remove b.pdf"));
		upload(container, new File(["hello"], "c.txt", { type: "text/plain" }));
		await settle(() => expect(screen.getByText("c.txt")).toBeTruthy());
		release();
		// Not "Draft saved to Drafts": c.txt is a change since that save.
		await settle(() => expect(screen.queryByText("Saving draft…")).toBeNull());
		expect(store.get("Drafts/7")).toEqual(["a.pdf", "b.pdf"]); // what was on screen when it left
		expect(screen.queryByText("b.pdf")).toBeNull();
		expect(screen.getByText("a.pdf")).toBeTruthy();

		fireEvent.click(screen.getByText("Send"));
		await advance(UNDO_SEND_MS);
		await settle(() => expect(onSent).toHaveBeenCalled());
		expect(sends()[0].body.attachments.map((a) => a.filename)).toEqual(["c.txt"]); // still an upload
		expect(sends()[0].body.forwardAttachments).toEqual({ folder: "Drafts", uid: 7, indexes: [0] });
		expect(lastSent).toEqual(["c.txt", "a.pdf"]);
	});
});
