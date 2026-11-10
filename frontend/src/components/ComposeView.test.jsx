import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { mockApi } from "../test/fetch.js";
import { rememberContacts } from "../utils/contacts.js";
import ComposeView, { UNDO_SEND_MS } from "./ComposeView.jsx";

vi.mock("../context/auth.jsx", () => ({
	useAuth: () => ({ user: { mailbox: "me@x.io" } }),
}));

const KEY = "ezmail_draft:me@x.io";

let calls;
beforeEach(() => {
	calls = mockApi({ "POST /mail/send": { savedToSent: true } });
});

const sends = () => calls.filter((c) => c.path === "/mail/send");

// Lets the undo countdown run out (fake timers must be on before Send), then
// goes back to real timers for the request and the findBy* that follow.
async function passCountdown() {
	await act(async () => { vi.advanceTimersByTime(UNDO_SEND_MS); });
	vi.useRealTimers();
}

const type = (placeholder, value) =>
	fireEvent.change(screen.getByPlaceholderText(placeholder), { target: { value } });

describe("drafts", () => {
	test("auto-saves after a pause and restores on next open", () => {
		vi.useFakeTimers();
		const { unmount } = render(<ComposeView onBack={() => {}} />);
		type("recipient@example.com", "bob@x.io");
		type("Subject", "Plans");
		expect(localStorage.getItem(KEY)).toBeNull();
		act(() => vi.advanceTimersByTime(900));
		expect(JSON.parse(localStorage.getItem(KEY)).form).toMatchObject({
			to: "bob@x.io",
			subject: "Plans",
		});
		expect(screen.getByText("Draft saved")).toBeTruthy();
		unmount();

		render(<ComposeView onBack={() => {}} />);
		expect(screen.getByPlaceholderText("Subject").value).toBe("Plans");
	});

	test("an empty form saves nothing", () => {
		vi.useFakeTimers();
		render(<ComposeView onBack={() => {}} />);
		act(() => vi.advanceTimersByTime(900));
		expect(localStorage.getItem(KEY)).toBeNull();
	});

	test("discard clears the draft and goes back", () => {
		localStorage.setItem(KEY, JSON.stringify({ form: { to: "x@y.z" } }));
		const onBack = vi.fn();
		render(<ComposeView onBack={onBack} />);
		fireEvent.click(screen.getByTitle("Discard draft"));
		expect(localStorage.getItem(KEY)).toBeNull();
		expect(onBack).toHaveBeenCalled();
	});

	test("leaving immediately flushes the latest draft", () => {
		vi.useFakeTimers();
		const onBack = vi.fn();
		render(<ComposeView onBack={onBack} />);
		type("Subject", "Latest change");
		fireEvent.click(screen.getByText("Back"));
		expect(JSON.parse(localStorage.getItem(KEY)).form.subject).toBe("Latest change");
		expect(onBack).toHaveBeenCalled();
	});

	test("unmounting immediately flushes the latest draft", () => {
		vi.useFakeTimers();
		const { unmount } = render(<ComposeView onBack={() => {}} />);
		type("Subject", "Not yet debounced");
		unmount();
		expect(JSON.parse(localStorage.getItem(KEY)).form.subject).toBe("Not yet debounced");
	});

	test("clearing the last content removes a saved draft", () => {
		localStorage.setItem(KEY, JSON.stringify({ form: { subject: "Old" } }));
		render(<ComposeView onBack={() => {}} />);
		type("Subject", "");
		expect(localStorage.getItem(KEY)).toBeNull();
	});

	test("older forwarding drafts do not silently reuse changed attachment indexes", () => {
		localStorage.setItem(KEY, JSON.stringify({ form: { to: "x@y.z" }, attachments: [
			{ filename: "old.pdf", forward: { folder: "INBOX", uid: 1, index: 0 } },
		] }));
		render(<ComposeView onBack={() => {}} />);
		expect(screen.getByText(/older draft were removed/)).toBeTruthy();
		expect(screen.queryByText("old.pdf")).toBeNull();
	});

	test("version-2 forwarding drafts are dropped after the index renumbering", () => {
		localStorage.setItem(KEY, JSON.stringify({ attachmentIndexVersion: 2, form: { to: "x@y.z" }, attachments: [
			{ filename: "v2.pdf", forward: { folder: "INBOX", uid: 1, index: 2 } },
		] }));
		render(<ComposeView onBack={() => {}} />);
		expect(screen.getByText(/older draft were removed/)).toBeTruthy();
		expect(screen.queryByText("v2.pdf")).toBeNull();
	});

	test("current-version forwarding drafts keep their attachment refs", () => {
		localStorage.setItem(KEY, JSON.stringify({ attachmentIndexVersion: 3, form: { to: "x@y.z" }, attachments: [
			{ filename: "v3.pdf", forward: { folder: "INBOX", uid: 1, index: 2 } },
		] }));
		render(<ComposeView onBack={() => {}} />);
		expect(screen.queryByText(/older draft were removed/)).toBeNull();
		expect(screen.getByText("v3.pdf")).toBeTruthy();
	});
});

describe("sending", () => {
	test("reply prefill + Ctrl+Enter sends with threading headers, clears draft", async () => {
		vi.useFakeTimers();
		const onSent = vi.fn();
		render(
			<ComposeView
				onBack={() => {}}
				onSent={onSent}
				initial={{
					title: "Reply",
					form: { to: "bob@x.io", subject: "Re: hi", text: "\n\n> hi" },
					meta: { inReplyTo: "<m@x>", references: "<m@x>" },
				}}
			/>,
		);
		expect(screen.getByText("Reply")).toBeTruthy();
		localStorage.setItem(KEY, "{}");
		fireEvent.keyDown(screen.getByPlaceholderText("Write your message…"), {
			key: "Enter",
			ctrlKey: true,
		});
		expect(screen.getByText("Undo")).toBeTruthy(); // same undo path as the button
		expect(sends()).toHaveLength(0);
		await passCountdown();
		await screen.findByText(/Message sent/);
		expect(sends()[0]).toMatchObject({
			path: "/mail/send",
			body: { to: "bob@x.io", subject: "Re: hi", inReplyTo: "<m@x>", references: "<m@x>" },
		});
		expect(localStorage.getItem(KEY)).toBeNull();
		expect(onSent).toHaveBeenCalled();
	});

	test("forwarded attachments go as references; uploads as bytes", async () => {
		render(
			<ComposeView
				onBack={() => {}}
				initial={{
					title: "Forward",
					form: { to: "carol@x.io", subject: "Fwd: x" },
					attachments: [
						{ filename: "a.pdf", contentType: "application/pdf", size: 1, forward: { folder: "INBOX", uid: 42, index: 1 } },
						{ filename: "b.pdf", contentType: "application/pdf", size: 1, forward: { folder: "INBOX", uid: 42, index: 3 } },
					],
				}}
			/>,
		);
		const file = new File(["hello"], "note.txt", { type: "text/plain" });
		const input = document.querySelector('input[type="file"]');
		fireEvent.change(input, { target: { files: [file] } });
		await screen.findByText("note.txt");
		vi.useFakeTimers();
		fireEvent.click(screen.getByText("Send"));
		await passCountdown();
		await screen.findByText(/Message sent/);
		expect(sends()[0].body.forwardAttachments).toEqual({
			folder: "INBOX",
			uid: 42,
			indexes: [1, 3],
		});
		expect(sends()[0].body.attachments).toEqual([
			{ filename: "note.txt", contentType: "text/plain", content: btoa("hello") },
		]);
	});

	test("forwarded attachment refs survive in the draft", () => {
		vi.useFakeTimers();
		render(
			<ComposeView
				onBack={() => {}}
				initial={{
					form: { subject: "Fwd: x" },
					attachments: [
						{ filename: "a.pdf", forward: { folder: "INBOX", uid: 42, index: 1 } },
					],
				}}
			/>,
		);
		act(() => vi.advanceTimersByTime(900));
		expect(JSON.parse(localStorage.getItem(KEY)).attachments).toEqual([
			{ filename: "a.pdf", forward: { folder: "INBOX", uid: 42, index: 1 } },
		]);
		expect(JSON.parse(localStorage.getItem(KEY)).attachmentIndexVersion).toBe(3);
	});

	test("sends Bcc recipients and keeps them in the saved draft", async () => {
		vi.useFakeTimers();
		render(<ComposeView onBack={() => {}} initial={{ form: { to: "bob@x.io", bcc: "quiet@x.io" } }} />);
		expect(screen.getByLabelText("Bcc").value).toBe("quiet@x.io");
		fireEvent.click(screen.getByText("Send"));
		await passCountdown();
		await screen.findByText(/Message sent/);
		expect(sends()[0].body).toMatchObject({ to: "bob@x.io", bcc: "quiet@x.io" });
	});

	test("no recipient: error, no request", () => {
		render(<ComposeView onBack={() => {}} />);
		fireEvent.click(screen.getByText("Send"));
		expect(screen.getByText("Add at least one recipient.")).toBeTruthy();
		expect(screen.queryByText("Undo")).toBeNull();
		expect(calls.filter((c) => c.method !== "GET")).toHaveLength(0);
	});

	test("server failure is shown, not 'Message sent', and editing is back", async () => {
		vi.useFakeTimers();
		calls = mockApi({
			"POST /mail/send": { status: 502, json: { success: false, message: "relay denied" } },
		});
		render(<ComposeView onBack={() => {}} initial={{ form: { to: "bob@x.io" } }} />);
		fireEvent.click(screen.getByText("Send"));
		await passCountdown();
		await screen.findByText("relay denied");
		expect(screen.queryByText(/Message sent/)).toBeNull();
		await waitFor(() => expect(screen.getByLabelText("To").closest("fieldset").disabled).toBe(false));
		expect(screen.getByLabelText("To").value).toBe("bob@x.io");
		expect(screen.getByText("Send").closest("button").disabled).toBe(false);
		expect(localStorage.getItem("ezmail_contacts:me@x.io")).toBeNull(); // only after a successful send
	});
});

describe("undo send", () => {
	const forwardInitial = {
		title: "Forward",
		form: { to: "bob@x.io", cc: "cc@x.io", subject: "Fwd: x", text: "see below" },
		attachments: [{ filename: "a.pdf", contentType: "application/pdf", size: 1, forward: { folder: "INBOX", uid: 4, index: 1 } }],
	};

	test("nothing is sent before the delay; Undo restores editing with everything intact", async () => {
		vi.useFakeTimers();
		render(<ComposeView onBack={() => {}} initial={forwardInitial} />);
		fireEvent.click(screen.getByText("Send"));
		expect(screen.getByText("Sending in 5…")).toBeTruthy();
		expect(screen.getByRole("status").textContent).toMatch(/Sending in 5 seconds/);
		expect(document.activeElement).toBe(screen.getByText("Undo").closest("button"));
		expect(screen.getByLabelText("To").closest("fieldset").disabled).toBe(true);
		expect(screen.getByPlaceholderText("Write your message…").closest("fieldset").disabled).toBe(true);
		act(() => vi.advanceTimersByTime(1000));
		expect(screen.getByText("Sending in 4…")).toBeTruthy();
		act(() => vi.advanceTimersByTime(UNDO_SEND_MS - 1001));
		expect(sends()).toHaveLength(0);

		fireEvent.click(screen.getByText("Undo"));
		act(() => vi.advanceTimersByTime(UNDO_SEND_MS));
		expect(sends()).toHaveLength(0);
		expect(screen.queryByText("Undo")).toBeNull();
		expect(screen.getByLabelText("To").closest("fieldset").disabled).toBe(false);
		expect(screen.getByLabelText("To").value).toBe("bob@x.io");
		expect(screen.getByLabelText("Cc").value).toBe("cc@x.io");
		expect(screen.getByPlaceholderText("Subject").value).toBe("Fwd: x");
		expect(screen.getByPlaceholderText("Write your message…").value).toBe("see below");
		expect(screen.getByText("a.pdf")).toBeTruthy();

		fireEvent.click(screen.getByText("Send"));
		act(() => vi.advanceTimersByTime(UNDO_SEND_MS - 1));
		expect(sends()).toHaveLength(0);
		await act(async () => { vi.advanceTimersByTime(1); });
		expect(sends()).toHaveLength(1);
		vi.useRealTimers();
		await screen.findByText(/Message sent/);
		expect(sends()[0].body.forwardAttachments).toEqual({ folder: "INBOX", uid: 4, indexes: [1] });
	});

	test("the draft is saved when the countdown starts; unmounting cancels the send", async () => {
		vi.useFakeTimers();
		const { unmount } = render(<ComposeView onBack={() => {}} />);
		type("recipient@example.com", "bob@x.io");
		type("Subject", "Typed just now");
		fireEvent.click(screen.getByText("Send")); // before the 800 ms auto-save
		expect(JSON.parse(localStorage.getItem(KEY)).form.subject).toBe("Typed just now");
		unmount();
		await act(async () => { vi.advanceTimersByTime(UNDO_SEND_MS * 2); });
		expect(sends()).toHaveLength(0);
		expect(JSON.parse(localStorage.getItem(KEY)).form).toMatchObject({ to: "bob@x.io", subject: "Typed just now" });
	});

	test("Back during the countdown cancels the send and keeps the draft", async () => {
		vi.useFakeTimers();
		const onBack = vi.fn();
		render(<ComposeView onBack={onBack} initial={{ form: { to: "bob@x.io", subject: "Hi" } }} />);
		fireEvent.click(screen.getByText("Send"));
		fireEvent.click(screen.getByText("Back"));
		await act(async () => { vi.advanceTimersByTime(UNDO_SEND_MS * 2); });
		expect(onBack).toHaveBeenCalled();
		expect(sends()).toHaveLength(0);
		expect(JSON.parse(localStorage.getItem(KEY)).form.subject).toBe("Hi");
	});
});

describe("countdown guards", () => {
	const initial = { form: { to: "bob@x.io", subject: "Hi" } };

	test("reports busy during the countdown and the send, and false after Undo, failure or unmount", async () => {
		vi.useFakeTimers();
		const onBusyChange = vi.fn();
		const last = () => onBusyChange.mock.calls.at(-1)[0];
		const { unmount } = render(<ComposeView onBack={() => {}} initial={initial} onBusyChange={onBusyChange} />);
		expect(last()).toBe(false);
		fireEvent.click(screen.getByText("Send"));
		expect(last()).toBe(true);
		act(() => vi.advanceTimersByTime(500));
		fireEvent.click(screen.getByText("Undo"));
		expect(last()).toBe(false);

		fireEvent.click(screen.getByText("Send"));
		expect(last()).toBe(true);
		await passCountdown();
		await screen.findByText(/Message sent/);
		expect(last()).toBe(false);

		unmount();
		onBusyChange.mockClear();
		vi.useFakeTimers();
		const second = render(<ComposeView onBack={() => {}} initial={initial} onBusyChange={onBusyChange} />);
		fireEvent.click(screen.getByText("Send"));
		expect(last()).toBe(true);
		second.unmount(); // an unmounted composer never leaves the parent blocked
		expect(last()).toBe(false);
	});

	test("a failed send reports not busy again", async () => {
		vi.useFakeTimers();
		calls = mockApi({ "POST /mail/send": { status: 500, json: { success: false, message: "boom" } } });
		const onBusyChange = vi.fn();
		render(<ComposeView onBack={() => {}} initial={initial} onBusyChange={onBusyChange} />);
		fireEvent.click(screen.getByText("Send"));
		await passCountdown();
		await screen.findByText("boom");
		expect(onBusyChange.mock.calls.at(-1)[0]).toBe(false);
	});

	test("Undo ignores the second click of a double-click, then works", () => {
		vi.useFakeTimers();
		render(<ComposeView onBack={() => {}} initial={initial} />);
		fireEvent.click(screen.getByText("Send"));
		fireEvent.click(screen.getByText("Undo"));
		expect(screen.getByText("Undo")).toBeTruthy(); // still counting
		act(() => vi.advanceTimersByTime(399));
		fireEvent.click(screen.getByText("Undo"));
		expect(screen.getByText("Undo")).toBeTruthy();
		act(() => vi.advanceTimersByTime(1));
		fireEvent.click(screen.getByText("Undo"));
		expect(screen.queryByText("Undo")).toBeNull();
		expect(sends()).toHaveLength(0);
	});

	test("Send is refused while attachments are still being read", async () => {
		const { container } = render(<ComposeView onBack={() => {}} initial={initial} />);
		const file = new File(["hello"], "a.txt", { type: "text/plain" });
		fireEvent.change(container.querySelector('input[type="file"]'), { target: { files: [file] } });
		fireEvent.click(screen.getByText("Send"));
		expect(screen.getByText(/Attachments are still loading/)).toBeTruthy();
		expect(screen.queryByText("Undo")).toBeNull();
		await screen.findByText("a.txt");
		fireEvent.click(screen.getByText("Send"));
		expect(screen.getByText("Undo")).toBeTruthy();
	});

	test("recipient suggestions close when the form is disabled by the countdown", () => {
		vi.useFakeTimers();
		rememberContacts("me@x.io", ["dana@x.io"]);
		render(<ComposeView onBack={() => {}} initial={{ form: { to: "bob@x.io" } }} />);
		const cc = screen.getByLabelText("Cc");
		fireEvent.change(cc, { target: { value: "da" } });
		expect(screen.getByRole("listbox")).toBeTruthy();
		fireEvent.click(screen.getByText("Send"));
		expect(screen.queryByRole("listbox")).toBeNull();
	});
});

describe("signature", () => {
	const SIG = "Ada Lovelace\nAnalyst";
	const withProfile = (signature, more = {}) => {
		calls = mockApi({ "GET /profile": { displayName: "", signature }, "POST /mail/send": { savedToSent: true }, ...more });
	};
	const body = () => screen.getByPlaceholderText(/Write your message/);

	test("a new message starts with the signature block, which alone is not a draft", async () => {
		withProfile(SIG);
		vi.useFakeTimers(); // before render, so the autosave debounce really runs
		render(<ComposeView onBack={() => {}} />);
		await vi.waitFor(() => expect(body().value).toBe("\n\n-- \nAda Lovelace\nAnalyst"));
		act(() => vi.advanceTimersByTime(2000));
		expect(localStorage.getItem(KEY)).toBeNull();
		fireEvent.change(body(), { target: { value: `${body().value}hello` } });
		act(() => vi.advanceTimersByTime(900)); // control: real text does get saved
		expect(JSON.parse(localStorage.getItem(KEY)).form.text).toContain("hello");
	});

	test("a reply gets the signature above the quoted text", async () => {
		withProfile(SIG);
		render(<ComposeView onBack={() => {}} initial={{ form: { to: "bob@x.io", text: "\n\nOn x, Bob wrote:\n> hi" } }} />);
		await waitFor(() => expect(body().value).toBe("\n\n-- \nAda Lovelace\nAnalyst\n\nOn x, Bob wrote:\n> hi"));
	});

	test("a restored draft does not get a second signature", async () => {
		withProfile(SIG);
		localStorage.setItem(KEY, JSON.stringify({ signature: SIG, form: { to: "x@y.z", text: "Hello\n\n-- \nAda Lovelace\nAnalyst" } }));
		render(<ComposeView onBack={() => {}} />);
		await act(async () => {});
		expect(body().value).toBe("Hello\n\n-- \nAda Lovelace\nAnalyst");
		expect(calls.some((c) => c.path === "/profile")).toBe(false);
	});

	test("a draft built with the signature is not signed again", async () => {
		withProfile(SIG);
		render(<ComposeView onBack={() => {}} initial={{ signature: SIG, form: { to: "b@x.io", text: "\n\n-- \nAda Lovelace\nAnalyst\n\n> q" } }} />);
		await act(async () => {});
		expect(body().value).toBe("\n\n-- \nAda Lovelace\nAnalyst\n\n> q");
	});

	test("an empty signature inserts nothing", async () => {
		withProfile("");
		render(<ComposeView onBack={() => {}} />);
		await waitFor(() => expect(calls.some((c) => c.path === "/profile")).toBe(true));
		await act(async () => {});
		expect(body().value).toBe("");
	});

	test("typing before the profile arrives keeps the signature out", async () => {
		withProfile(SIG);
		const real = globalThis.fetch;
		let release;
		const gate = new Promise((r) => { release = r; });
		vi.stubGlobal("fetch", async (url, init) => {
			if (String(url).endsWith("/profile")) await gate;
			return real(url, init);
		});
		render(<ComposeView onBack={() => {}} />);
		fireEvent.change(body(), { target: { value: "Quick note" } });
		expect(calls.some((c) => c.path === "/profile")).toBe(false); // still pending
		release();
		await waitFor(() => expect(calls.some((c) => c.path === "/profile")).toBe(true));
		await act(async () => {});
		await act(async () => {});
		expect(body().value).toBe("Quick note");
	});

	test("plain text is sent as typed; markdown keeps the signature literal", async () => {
		withProfile("*Ada* <b>x</b>\n# 1. not a heading");
		render(<ComposeView onBack={() => {}} initial={{ form: { to: "bob@x.io", text: "" } }} />);
		await waitFor(() => expect(body().value).toContain("-- \n*Ada*"));
		fireEvent.click(screen.getByLabelText("Markdown"));
		vi.useFakeTimers();
		fireEvent.click(screen.getByText("Send"));
		await passCountdown();
		await screen.findByText(/Message sent/);
		expect(sends()[0].body).toMatchObject({
			markdown: true,
			text: "\n\n-- \n\n\\*Ada\\* \\<b\\>x\\</b\\>  \n\\# 1. not a heading",
		});
	});
});

describe("recipient autocomplete", () => {
	beforeEach(() => {
		rememberContacts("me@x.io", ["Dan Brown <dan@x.io>", "dana@x.io", "carol@x.io"]);
	});
	const to = () => screen.getByLabelText("To");

	test("suggests for the token after the last comma; keyboard accept replaces only it", () => {
		render(<ComposeView onBack={() => {}} initial={{ form: {} }} />);
		fireEvent.change(to(), { target: { value: "carol@x.io, da" } });
		const options = screen.getAllByRole("option");
		expect(options.map((o) => o.textContent)).toEqual(["Dan Brown <dan@x.io>", "dana@x.io"]);
		expect(to().getAttribute("aria-expanded")).toBe("true");
		fireEvent.keyDown(to(), { key: "ArrowDown" });
		fireEvent.keyDown(to(), { key: "ArrowDown" });
		expect(to().getAttribute("aria-activedescendant")).toBe(options[1].id);
		expect(options[1].getAttribute("aria-selected")).toBe("true");
		fireEvent.keyDown(to(), { key: "ArrowUp" });
		const enter = fireEvent.keyDown(to(), { key: "Enter" });
		expect(enter).toBe(false); // handled, so the form isn't submitted
		expect(to().value).toMatch(/^carol@x\.io, ?dan@x\.io$/); // email inputs may drop the space
		expect(screen.queryByRole("listbox")).toBeNull();
	});

	test("Tab and click accept; Escape dismisses without closing the composer", () => {
		const onKey = vi.fn((e) => e.key === "Escape");
		window.addEventListener("keydown", onKey);
		render(<ComposeView onBack={() => {}} initial={{ form: {} }} />);
		const cc = screen.getByLabelText("Cc");
		fireEvent.change(cc, { target: { value: "brown" } });
		fireEvent.keyDown(cc, { key: "ArrowDown" });
		fireEvent.keyDown(cc, { key: "Tab" });
		expect(cc.value).toBe("dan@x.io");

		fireEvent.change(to(), { target: { value: "x@y.z; car" } });
		fireEvent.click(screen.getByRole("option", { name: "carol@x.io" }));
		expect(to().value).toBe("x@y.z; carol@x.io");

		fireEvent.change(to(), { target: { value: "x@y.z; d" } });
		expect(screen.getByRole("listbox")).toBeTruthy();
		fireEvent.keyDown(to(), { key: "Escape" });
		expect(screen.queryByRole("listbox")).toBeNull();
		expect(onKey.mock.results.some((r) => r.value)).toBe(false); // Escape stayed inside the field
		window.removeEventListener("keydown", onKey);
	});

	test("Enter without a highlighted suggestion is left alone and Ctrl+Enter still sends", () => {
		vi.useFakeTimers();
		render(<ComposeView onBack={() => {}} initial={{ form: {} }} />);
		fireEvent.change(to(), { target: { value: "da" } });
		expect(screen.getByRole("listbox")).toBeTruthy();
		expect(fireEvent.keyDown(to(), { key: "Enter" })).toBe(true);
		expect(to().value).toBe("da");
		fireEvent.keyDown(to(), { key: "ArrowDown" });
		fireEvent.keyDown(to(), { key: "Enter", ctrlKey: true });
		expect(to().value).toBe("da");
		expect(screen.getByText("Undo")).toBeTruthy();
	});

	test("recipients are remembered after a successful send, most recent first", async () => {
		vi.useFakeTimers();
		render(<ComposeView onBack={() => {}} initial={{ form: { to: "New Person <new@x.io>", cc: "carol@x.io", bcc: "hid@x.io" } }} />);
		fireEvent.click(screen.getByText("Send"));
		await passCountdown();
		await screen.findByText(/Message sent/);
		const saved = JSON.parse(localStorage.getItem("ezmail_contacts:me@x.io"));
		expect(saved.map((c) => c.address)).toEqual(["new@x.io", "carol@x.io", "hid@x.io", "dan@x.io", "dana@x.io"]);
		expect(saved[0].name).toBe("New Person");
	});
});
