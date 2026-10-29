import { useEffect, useRef } from "react";

export function useDialogFocus(open, onClose) {
	const ref = useRef(null);
	const closeRef = useRef(onClose);
	closeRef.current = onClose;
	useEffect(() => {
		if (!open) return;
		const previous = document.activeElement;
		const dialog = ref.current;
		const focusable = () => [...dialog.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')];
		(focusable()[0] || dialog).focus();
		const onKey = (event) => {
			if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeRef.current(); return; }
			if (event.key !== "Tab") return;
			const items = focusable();
			if (!items.length) { event.preventDefault(); dialog.focus(); return; }
			if (event.shiftKey && document.activeElement === items[0]) { event.preventDefault(); items.at(-1).focus(); }
			else if (!event.shiftKey && document.activeElement === items.at(-1)) { event.preventDefault(); items[0].focus(); }
		};
		dialog.addEventListener("keydown", onKey);
		return () => { dialog.removeEventListener("keydown", onKey); previous?.focus?.(); };
	}, [open]);
	return ref;
}
