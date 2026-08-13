import { useEffect, useRef, useState } from "react";
import { apiCall } from "../utils/apiCall.js";
import { Sparkles, X } from "lucide-react";

export default function SummaryColumn({ message, onClose }) {
	const [summary, setSummary] = useState("");
	const [summarizing, setSummarizing] = useState(false);
	const [error, setError] = useState("");
	const abortRef = useRef(null);

	useEffect(() => {
		// cancel any in-flight summary from a previous message
		if (abortRef.current) abortRef.current.abort();

		if (!message) return;

		// Prefer the plain-text body; fall back to text scraped from HTML.
		let text = (message.text || "").trim();
		const hasHtml = !!(message.html || "");

		if (!text && hasHtml) {
			// Scrape visible text out of the HTML (strip tags/scripts/styles) so
			// HTML emails still get summarized even when mailparser left .text empty.
			const stripped = (message.html || "")
				.replace(/<script[\s\S]*?<\/script>/gi, " ")
				.replace(/<style[\s\S]*?<\/style>/gi, " ")
				.replace(/<[^>]+>/g, " ")
				.replace(/&nbsp;/g, " ")
				.replace(/&amp;/g, "&")
				.replace(/&lt;/g, "<")
				.replace(/&gt;/g, ">")
				.replace(/\s+/g, " ")
				.trim();
			// Only call it "picture-only" if the HTML yielded no real words.
			text = stripped.length > 40 ? stripped : "";
		}

		if (!text) {
			// Body still loading or confirmed picture-only (no extractable text).
			setSummary("");
			setError(
				hasHtml
					? "This email contains no text to summarize (images only)."
					: "",
			);
			setSummarizing(true);
			return;
		}

		const controller = new AbortController();
		abortRef.current = controller;
		setSummarizing(true);
		setSummary("");
		setError("");

		apiCall
			.post("/mail/summarize", { text }, { signal: controller.signal })
			.then((res) => {
				if (res.success) setSummary(res?.data?.summary || "");
				else setError(res?.message || "Summarization failed");
			})
			.catch((err) => {
				if (err?.name !== "AbortError") {
					setError(err?.message || "Summarization failed");
				}
			})
			.finally(() => setSummarizing(false));

		return () => controller.abort();
	}, [message]);

	return (
		<aside className="flex w-80 shrink-0 flex-col border-l border-hair bg-panel/40">
			<div className="flex items-center gap-2 border-b border-hair px-4 py-3">
				<Sparkles className="h-4 w-4 text-accent" />
				<span className="text-sm font-semibold">Summary</span>
				<div className="flex-1" />
				<button
					onClick={onClose}
					className="rounded-lg p-1 text-ink-muted transition hover:bg-hover hover:text-ink-2"
				>
					<X className="h-4 w-4" />
				</button>
			</div>

			<div className="flex-1 overflow-y-auto p-4">
				{summarizing && (
					<div className="flex items-center gap-3 text-sm text-ink-muted">
						<div className="h-4 w-4 animate-spin rounded-full border-2 border-hair-strong border-t-indigo-500" />
						Summarizing…
					</div>
				)}
				{!summarizing && error && (
					<div className="rounded-lg border border-danger/20 bg-danger/10 p-3 text-sm text-danger">
						{error}
					</div>
				)}
				{!summarizing && !error && summary && (
					<div className="whitespace-pre-wrap text-sm leading-relaxed text-ink-2">
						{summary}
					</div>
				)}
				{!summarizing && !error && !summary && (
					<div className="text-sm text-ink-muted">No summary</div>
				)}
			</div>
		</aside>
	);
}