import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { mockApi } from "../test/fetch.js";
import ComposeView from "./ComposeView.jsx";

vi.mock("../context/auth.jsx", () => ({
	useAuth: () => ({ user: { mailbox: "me@x.io" } }),
}));

const KEY = "ezmail_draft:me@x.io";

let calls;
beforeEach(() => {
	calls = mockApi({ "POST /mail/send": { savedToSent: true } });
});

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
});

describe("sending", () => {
	test("reply prefill + Ctrl+Enter sends with threading headers, clears draft", async () => {
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
		await screen.findByText(/Message sent/);
		expect(calls[0]).toMatchObject({
			path: "/mail/send",
			body: { to: "bob@x.io", subject: "Re: hi", inReplyTo: "<m@x>", references: "<m@x>" },
		});
		expect(localStorage.getItem(KEY)).toBeNull();
		expect(onSent).toHaveBeenCalled();
	});

	test("no recipient: error, no request", () => {
		render(<ComposeView onBack={() => {}} />);
		fireEvent.click(screen.getByText("Send"));
		expect(screen.getByText("Add at least one recipient.")).toBeTruthy();
		expect(calls).toHaveLength(0);
	});

	test("server failure is shown, not 'Message sent'", async () => {
		mockApi({
			"POST /mail/send": { status: 502, json: { success: false, message: "relay denied" } },
		});
		render(<ComposeView onBack={() => {}} initial={{ form: { to: "bob@x.io" } }} />);
		fireEvent.click(screen.getByText("Send"));
		await screen.findByText("relay denied");
		expect(screen.queryByText(/Message sent/)).toBeNull();
	});
});
