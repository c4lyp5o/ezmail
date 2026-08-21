import { useState } from "react";
import { Trash2, X } from "lucide-react";

// Modal to confirm emptying the trash folder.
// Parent (MailPage) controls open/close via `open` + `onClose`.
export default function EmptyTrashModal({ open, onClose, emptyTrash, busy }) {
	const handleConfirm = async () => {
		try {
			await emptyTrash?.();
		} catch (err) {
			console.error("Failed to empty trash:", err);
		} finally {
			onClose();
		}
	};

	if (!open) return null;

	return (
		// biome-ignore lint/a11y/useKeyWithClickEvents: later
		// biome-ignore lint/a11y/noStaticElementInteractions: later
		<div
			className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
			onClick={onClose}
		>
			{/** biome-ignore lint/a11y/useKeyWithClickEvents: later */}
			{/** biome-ignore lint/a11y/noStaticElementInteractions: later */}
			<div
				className="relative w-full max-w-md rounded-2xl border border-hair-strong bg-panel p-6 shadow-2xl transition-all"
				onClick={(e) => e.stopPropagation()}
			>
				{/* Close X button */}
				<button
					type="button"
					onClick={onClose}
					className="absolute right-4 top-4 rounded-lg p-1.5 text-ink-muted transition hover:bg-hover hover:text-ink-2"
				>
					<X className="h-4 w-4" />
				</button>

				{/* Warning Content */}
				<div className="flex flex-col items-center text-center">
					<div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-danger/10 text-danger">
						<Trash2 className="h-6 w-6" />
					</div>

					<h3 className="text-lg font-semibold text-ink-2">Empty Trash?</h3>

					<p className="mt-2 text-sm text-ink-muted">
						Are you sure you want to permanently delete all messages in Trash?
						This action{" "}
						<span className="font-medium text-danger">cannot be undone</span>.
					</p>
				</div>

				{/* Footer Action Buttons */}
				<div className="mt-6 flex items-center justify-end gap-3">
					<button
						type="button"
						onClick={onClose}
						disabled={busy}
						className="rounded-lg border border-hair-strong px-4 py-2 text-sm font-medium text-ink-2 transition hover:bg-hover"
					>
						Cancel
					</button>
					<button
						type="button"
						onClick={handleConfirm}
						disabled={busy}
						className={`flex items-center gap-2 rounded-lg bg-danger px-4 py-2 text-sm font-medium text-white transition hover:bg-danger/90 disabled:opacity-50 ${busy ? "cursor-not-allowed" : ""}`}
					>
						<Trash2 className="h-4 w-4" />
						{busy ? "Emptying Trash..." : "Empty Trash"}
					</button>
				</div>
			</div>
		</div>
	);
}
