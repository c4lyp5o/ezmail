import { useEffect, useId, useRef } from "react";

// Confirmation overlay for use inside a dialog. It handles Escape and Tab
// itself (stopping them before the host dialog sees them), focuses Cancel,
// and returns focus to the previously focused control on close.
export default function ConfirmPanel({ title, children, confirmLabel, cancelLabel = "Cancel", onConfirm, onCancel }) {
	const ref = useRef(null);
	const id = useId();
	const cancelRef = useRef(null);
	const cancelFn = useRef(onCancel);
	cancelFn.current = onCancel;

	useEffect(() => {
		const previous = document.activeElement;
		const panel = ref.current;
		cancelRef.current?.focus();
		const onKey = (event) => {
			if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); cancelFn.current(); return; }
			if (event.key !== "Tab") return;
			event.stopPropagation();
			const buttons = [...panel.querySelectorAll("button")];
			const first = buttons[0];
			const last = buttons.at(-1);
			if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
			else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
		};
		panel.addEventListener("keydown", onKey);
		return () => { panel.removeEventListener("keydown", onKey); previous?.focus?.(); };
	}, []);

	return (
		<div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4">
			<div ref={ref} role="alertdialog" aria-modal="true" aria-labelledby={`${id}-title`} aria-describedby={`${id}-body`} className="w-full max-w-sm rounded-xl border border-hair-strong bg-panel p-5 shadow-2xl">
				<h4 id={`${id}-title`} className="text-base font-semibold text-ink-2">{title}</h4>
				<div id={`${id}-body`} className="mt-2 text-sm text-ink-muted">{children}</div>
				<div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
					<button ref={cancelRef} type="button" onClick={onCancel} className="min-h-10 rounded-lg border border-hair px-4 py-2 text-sm text-ink-2 transition hover:bg-hover focus-visible:outline-2 focus-visible:outline-accent">{cancelLabel}</button>
					<button type="button" onClick={onConfirm} className="min-h-10 rounded-lg bg-danger px-4 py-2 text-sm font-medium text-white transition hover:opacity-90 focus-visible:outline-2 focus-visible:outline-accent">{confirmLabel}</button>
				</div>
			</div>
		</div>
	);
}
