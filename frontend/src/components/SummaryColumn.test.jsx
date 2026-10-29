import { fireEvent, render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { mockApi } from "../test/fetch.js";
import SummaryColumn from "./SummaryColumn.jsx";

test("summarizes the message and has a working close button", async () => {
	const calls = mockApi({ "POST /mail/summarize": { summary: "- pay the invoice" } });
	const onClose = vi.fn();
	render(
		<SummaryColumn
			message={{ uid: 1, folder: "INBOX", text: "Please pay the attached invoice by Friday." }}
			onClose={onClose}
		/>,
	);
	expect(await screen.findByText(/pay the invoice/)).toBeTruthy();
	expect(calls[0].body.text).toContain("invoice");
	fireEvent.click(screen.getByLabelText("Close summary"));
	expect(onClose).toHaveBeenCalled();
});
