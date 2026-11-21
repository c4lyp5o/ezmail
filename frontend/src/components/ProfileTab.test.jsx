import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { mockApi } from "../test/fetch.js";
import ProfileTab from "./ProfileTab.jsx";

test("loads, edits and saves the display name", async () => {
	const calls = mockApi({
		"GET /profile": { displayName: "Ada" },
		"PUT /profile": (body) => ({ displayName: body.displayName.trim() }),
	});
	render(<ProfileTab mailbox="ada@x.io" />);
	const input = await screen.findByLabelText("Display name");
	await waitFor(() => expect(input.value).toBe("Ada"));

	fireEvent.change(input, { target: { value: "Ada Lovelace " } });
	expect(screen.getByText(/“Ada Lovelace” <ada@x\.io>/)).toBeTruthy();
	fireEvent.click(screen.getByText("Save"));

	await screen.findByText("Saved");
	expect(calls.at(-1)).toMatchObject({
		method: "PUT",
		path: "/profile",
		body: { displayName: "Ada Lovelace " },
	});
	expect(input.value).toBe("Ada Lovelace");
});

test("loads, edits and saves the signature with the display name", async () => {
	const calls = mockApi({
		"GET /profile": { displayName: "Ada", signature: "Ada\nAnalyst" },
		"PUT /profile": (body) => ({ displayName: body.displayName, signature: body.signature.trim() }),
	});
	render(<ProfileTab mailbox="ada@x.io" />);
	const sig = await screen.findByLabelText("Signature");
	await waitFor(() => expect(sig.value).toBe("Ada\nAnalyst"));
	await waitFor(() => expect(sig.disabled).toBe(false));
	expect(sig.maxLength).toBe(2000);
	expect(screen.getByText("11/2000")).toBeTruthy();
	expect(screen.getByText(/new messages, replies and forwards/)).toBeTruthy();

	fireEvent.change(sig, { target: { value: "Ada L\nAnalyst\n" } });
	expect(screen.getByText("14/2000")).toBeTruthy();
	fireEvent.click(screen.getByText("Save"));
	await screen.findByText("Saved");
	expect(calls.at(-1)).toMatchObject({
		method: "PUT",
		path: "/profile",
		body: { displayName: "Ada", signature: "Ada L\nAnalyst\n" },
	});
	expect(sig.value).toBe("Ada L\nAnalyst");
});

test("a rejected signature shows the server's message and keeps the text", async () => {
	mockApi({
		"GET /profile": { displayName: "", signature: "" },
		"PUT /profile": { status: 400, json: { success: false, message: "Signature is too long" } },
	});
	render(<ProfileTab mailbox="ada@x.io" />);
	const sig = await screen.findByLabelText("Signature");
	await waitFor(() => expect(sig.disabled).toBe(false));
	fireEvent.change(sig, { target: { value: "x".repeat(50) } });
	fireEvent.click(screen.getByText("Save"));
	await screen.findByText("Signature is too long");
	expect(sig.value).toBe("x".repeat(50));
});
