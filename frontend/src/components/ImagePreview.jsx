import { ChevronLeft, ChevronRight, Download, FileWarning, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useDialogFocus } from "../utils/useDialogFocus.js";

// The only types the attachment endpoint serves inline (?inline=1). Exact
// match after lowercasing and dropping parameters: never SVG, never "image/*".
const PREVIEW_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
export const isPreviewable = (contentType) =>
	PREVIEW_TYPES.has(String(contentType || "").split(";")[0].trim().toLowerCase());

// Lightbox for image attachments. `items` are { url, filename }; the bytes
// load only through a same-origin <img> in the app document (the app CSP
// allows it). The filename is rendered as text only.
export default function ImagePreview({ items, index, onIndex, onClose }) {
	const item = items[index];
	const [state, setState] = useState("loading"); // loading | ready | error
	const ref = useDialogFocus(true, onClose);
	const many = items.length > 1;
	const step = (d) => onIndex((index + d + items.length) % items.length);

	// biome-ignore lint/correctness/useExhaustiveDependencies: reset per image
	useEffect(() => setState("loading"), [item.url]);

	const downloadLink = (label) => (
		// tabIndex keeps the link inside useDialogFocus's focus trap
		<a href={item.url} download={item.filename} tabIndex={0} className="flex items-center gap-1.5 rounded-lg border border-hair-strong px-3 py-1.5 text-sm text-ink-2 transition hover:bg-hover focus-visible:outline-2 focus-visible:outline-accent">
			<Download className="h-4 w-4" /> {label}
		</a>
	);

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: backdrop click closes; Esc is handled by useDialogFocus
		// biome-ignore lint/a11y/useKeyWithClickEvents: see above
		<div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 p-4" onClick={onClose}>
			<div
				ref={ref}
				role="dialog"
				aria-modal="true"
				aria-label={`Preview of ${item.filename}`}
				tabIndex={-1}
				onClick={(e) => e.stopPropagation()}
				onKeyDown={(e) => {
					// Keep the reader's global shortcuts (#, e, j/k…) away from the lightbox.
					e.stopPropagation();
					if (!many || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
					e.preventDefault();
					step(e.key === "ArrowRight" ? 1 : -1);
				}}
				className="flex max-h-full w-full max-w-5xl flex-col gap-3 rounded-xl border border-hair-strong bg-panel p-3 shadow-2xl"
			>
				<div className="flex items-center gap-2">
					<h2 className="min-w-0 flex-1 truncate text-sm font-medium text-ink-2" title={item.filename}>{item.filename}</h2>
					{many && <span className="text-xs text-ink-muted">{index + 1} / {items.length}</span>}
					{downloadLink("Download")}
					<button type="button" onClick={onClose} aria-label="Close preview" className="flex h-8 w-8 items-center justify-center rounded-lg text-ink-muted transition hover:bg-hover hover:text-ink-2 focus-visible:outline-2 focus-visible:outline-accent">
						<X className="h-4 w-4" />
					</button>
				</div>
				<div className="relative flex min-h-48 flex-1 items-center justify-center overflow-hidden">
					{many && (
						<button type="button" onClick={() => step(-1)} aria-label="Previous image" className="absolute left-0 z-10 flex h-10 w-10 items-center justify-center rounded-full bg-panel/80 text-ink-2 shadow hover:bg-hover focus-visible:outline-2 focus-visible:outline-accent">
							<ChevronLeft className="h-5 w-5" />
						</button>
					)}
					{state === "loading" && (
						<div role="status" aria-label="Loading image" className="absolute h-8 w-8 animate-spin rounded-full border-2 border-hair-strong border-t-indigo-500" />
					)}
					{state === "error" ? (
						<div role="alert" className="flex flex-col items-center gap-3 p-6 text-sm text-ink-muted">
							<FileWarning className="h-8 w-8 text-ink-faint" />
							This image couldn't be shown.
							{downloadLink("Download instead")}
						</div>
					) : (
						<img
							key={item.url}
							src={`${item.url}?inline=1`}
							alt={item.filename}
							onLoad={() => setState("ready")}
							onError={() => setState("error")}
							className={`max-h-[calc(100dvh-8rem)] max-w-full object-contain ${state === "ready" ? "" : "invisible"}`}
						/>
					)}
					{many && (
						<button type="button" onClick={() => step(1)} aria-label="Next image" className="absolute right-0 z-10 flex h-10 w-10 items-center justify-center rounded-full bg-panel/80 text-ink-2 shadow hover:bg-hover focus-visible:outline-2 focus-visible:outline-accent">
							<ChevronRight className="h-5 w-5" />
						</button>
					)}
				</div>
			</div>
		</div>
	);
}
