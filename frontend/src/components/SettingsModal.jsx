import { Filter, Settings, ShieldCheck, X } from "lucide-react";
import { useEffect, useState } from "react";
import FiltersTab from "./FiltersTab.jsx";
import SecurityTab from "./SecurityTab.jsx";

// Tabbed settings modal: Security (TOTP) and Filters (server-side sorting).
// Parent (MailPage) controls open/close via `open` + `onClose` and may open
// a specific tab via `initialTab` ("security" | "filters").
export default function SettingsModal({
	open,
	onClose,
	mailbox,
	folders = [],
	initialTab,
}) {
	const [tab, setTab] = useState(
		initialTab === "filters" ? "filters" : "security",
	);

	// Re-sync when reopened so MailPage can target a tab.
	useEffect(() => {
		if (open) setTab(initialTab === "filters" ? "filters" : "security");
	}, [open, initialTab]);

	if (!open) return null;

	const TABS = [
		{ id: "security", label: "Security", icon: ShieldCheck },
		{ id: "filters", label: "Filters", icon: Filter },
	];

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
				className="relative flex max-h-[85vh] w-full max-w-2xl flex-col rounded-2xl border border-hair-strong bg-panel p-6 shadow-2xl"
				onClick={(e) => e.stopPropagation()}
			>
				<button
					type="button"
					onClick={onClose}
					className="absolute right-4 top-4 rounded-lg p-1.5 text-ink-muted transition hover:bg-hover hover:text-ink-2"
					aria-label="Close settings"
				>
					<X className="h-4 w-4" />
				</button>

				<div className="mb-1 flex items-center gap-2.5">
					<div className="flex h-9 w-9 items-center justify-center rounded-lg bg-accent/15 text-accent">
						<Settings className="h-4.5 w-4.5" />
					</div>
					<h3 className="text-lg font-semibold text-ink-2">Settings</h3>
					{mailbox && (
						<p className="ml-2 truncate text-xs text-ink-faint">{mailbox}</p>
					)}
				</div>

				{/* Tabs */}
				<div className="mt-4 flex gap-1 rounded-xl border border-hair bg-canvas p-1">
					{TABS.map((tb) => {
						const Icon = tb.icon;
						const isActive = tab === tb.id;
						return (
							<button
								type="button"
								key={tb.id}
								onClick={() => setTab(tb.id)}
								aria-selected={isActive}
								role="tab"
								className={`flex flex-1 items-center justify-center gap-2 rounded-lg px-3 py-1.5 text-sm font-medium transition ${
									isActive
										? "bg-accent/15 text-accent"
										: "text-ink-muted transition hover:bg-hover hover:text-ink-2"
								}`}
							>
								<Icon className="h-4 w-4" />
								{tb.label}
							</button>
						);
					})}
				</div>

				{/* Tab panels */}
				<div className="mt-4 min-h-0 flex-1 overflow-y-auto pr-1">
					{tab === "security" ? (
						<SecurityTab mailbox={mailbox} />
					) : (
						<FiltersTab mailbox={mailbox} folders={folders} />
					)}
				</div>
			</div>
		</div>
	);
}
