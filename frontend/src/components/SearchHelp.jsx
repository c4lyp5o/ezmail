import { Info } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

// Operators the backend understands in ?search=; anything else is plain text.
export const SEARCH_OPERATORS = [
	["from:alice", "Sender contains “alice”"],
	["to:bob@example.com", "Recipient contains this address"],
	['subject:"weekly report"', "Subject contains a phrase (quote spaces)"],
	["is:unread", "Unread mail (also is:read)"],
	["is:starred", "Starred mail (also is:unstarred)"],
	["after:2026-01-31", "On or after this day"],
	["before:2026-02-01", "Before this day (not including it)"],
];

// "?" button beside the search box that lists the operators; picking an
// example hands it to onInsert. Non-modal: Esc or a click outside closes it.
export default function SearchHelp({ onInsert }) {
	const [open, setOpen] = useState(false);
	const id = useId();
	const wrapRef = useRef(null);
	const buttonRef = useRef(null);
	const panelRef = useRef(null);

	useEffect(() => {
		if (!open) return;
		panelRef.current?.querySelector("button")?.focus();
		const onDown = (e) => { if (!wrapRef.current?.contains(e.target)) setOpen(false); };
		document.addEventListener("mousedown", onDown);
		return () => document.removeEventListener("mousedown", onDown);
	}, [open]);

	const close = () => { setOpen(false); buttonRef.current?.focus(); };

	return (
		<div ref={wrapRef} className="relative">
			<button
				ref={buttonRef}
				type="button"
				onClick={() => setOpen((v) => !v)}
				aria-label="Search operators"
				aria-expanded={open}
				aria-controls={open ? id : undefined}
				title="Search operators"
				className="flex items-center rounded-md border border-hair p-1.5 text-ink-muted transition hover:bg-hover hover:text-ink-2 focus-visible:outline-2 focus-visible:outline-accent"
			>
				<Info className="h-4 w-4" />
			</button>
			{open && (
				<div
					ref={panelRef}
					id={id}
					role="dialog"
					aria-label="Search operators"
					onKeyDown={(e) => {
						e.stopPropagation(); // list shortcuts stay out of the popover
						if (e.key !== "Escape") return;
						e.preventDefault();
						close();
					}}
					className="absolute right-0 top-full z-40 mt-1 w-72 max-w-[calc(100vw-2rem)] rounded-xl border border-hair-strong bg-panel p-3 text-sm shadow-xl"
				>
					<h3 className="mb-2 text-xs font-semibold text-ink-2">Search operators</h3>
					<ul className="space-y-0.5">
						{SEARCH_OPERATORS.map(([example, what]) => (
							<li key={example}>
								<button
									type="button"
									onClick={() => { setOpen(false); onInsert(example); }}
									title="Add to search"
									className="flex w-full flex-col items-start rounded-md px-2 py-1 text-left transition hover:bg-hover focus-visible:outline-2 focus-visible:outline-accent"
								>
									<code className="font-mono text-xs text-ink-2">{example}</code>
									<span className="text-xs text-ink-muted">{what}</span>
								</button>
							</li>
						))}
					</ul>
					<p className="mt-2 text-xs text-ink-faint">Combine them with words. Dates are UTC days (YYYY-MM-DD).</p>
				</div>
			)}
		</div>
	);
}
