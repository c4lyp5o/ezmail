import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";

// navigator.clipboard only exists in secure contexts (HTTPS or localhost),
// so a plain-HTTP LAN origin falls back to a hidden textarea + execCommand.
export async function copyText(text) {
	if (navigator.clipboard?.writeText && window.isSecureContext) {
		await navigator.clipboard.writeText(text);
		return;
	}
	const area = document.createElement("textarea");
	area.value = text;
	area.setAttribute("readonly", "");
	area.style.position = "fixed";
	area.style.opacity = "0";
	document.body.appendChild(area);
	area.select();
	try {
		if (!document.execCommand("copy")) throw new Error("Copy failed");
	} finally {
		area.remove();
	}
}

// Small icon button that copies `value` and briefly shows a check mark.
export default function CopyButton({ value, label = "Copy email address", className = "" }) {
	const [state, setState] = useState("idle");
	const timer = useRef(null);
	useEffect(() => () => clearTimeout(timer.current), []);

	if (!value) return null;

	const copy = async (e) => {
		e.stopPropagation();
		try {
			await copyText(value);
			setState("copied");
		} catch {
			setState("failed");
		}
		clearTimeout(timer.current);
		timer.current = setTimeout(() => setState("idle"), 1500);
	};

	const title = state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : label;
	return (
		<button
			type="button"
			onClick={copy}
			title={title}
			aria-label={title}
			className={`inline-flex shrink-0 items-center justify-center rounded p-0.5 align-middle text-ink-muted transition hover:bg-hover hover:text-ink-2 ${className}`}
		>
			{state === "copied" ? (
				<Check className="h-3.5 w-3.5 text-accent" />
			) : (
				<Copy className="h-3.5 w-3.5" />
			)}
		</button>
	);
}
