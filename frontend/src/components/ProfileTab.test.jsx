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
