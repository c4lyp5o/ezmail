import { Bell, Filter, Settings2, ShieldCheck, UserRound, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useTheme } from "../context/theme.jsx";
import { useDialogFocus } from "../utils/useDialogFocus.js";
import FiltersTab from "./FiltersTab.jsx";
import ProfileTab from "./ProfileTab.jsx";
import SecurityTab from "./SecurityTab.jsx";

const SECTIONS = [
	{ id: "general", label: "General", icon: Settings2, description: "Appearance and notifications" },
	{ id: "profile", label: "Profile", icon: UserRound, description: "Your sender details" },
	{ id: "security", label: "Security", icon: ShieldCheck, description: "Authenticator sign-in" },
	{ id: "filters", label: "Filters", icon: Filter, description: "Organize incoming mail" },
];
const pickSection = (id) => SECTIONS.some((section) => section.id === id) ? id : "general";

export default function SettingsModal({ open, onClose, mailbox, folders = [], initialTab, notifyOn = false, onToggleNotify }) {
	const [section, setSection] = useState(() => pickSection(initialTab));
	const [notificationError, setNotificationError] = useState("");
	const dialogRef = useDialogFocus(open, onClose);
	const { theme, toggle } = useTheme();

	useEffect(() => {
		if (open) { setSection(pickSection(initialTab)); setNotificationError(""); }
	}, [open, initialTab]);

	if (!open) return null;
	const active = SECTIONS.find((item) => item.id === section);

	return (
		// biome-ignore lint/a11y/useKeyWithClickEvents: backdrop closes the dialog
		// biome-ignore lint/a11y/noStaticElementInteractions: backdrop closes the dialog
		<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-3 backdrop-blur-sm sm:p-6" onClick={onClose}>
			{/* biome-ignore lint/a11y/useKeyWithClickEvents: the dialog handles Escape and focus */}
			<div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="settings-title" tabIndex={-1} onClick={(e) => e.stopPropagation()} className="flex h-[min(680px,90dvh)] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-hair-strong bg-panel shadow-2xl">
				<header className="flex shrink-0 items-center gap-3 border-b border-hair px-5 py-4 sm:px-6">
					<div className="min-w-0 flex-1">
						<h2 id="settings-title" className="text-lg font-semibold text-ink-2">Settings</h2>
						{mailbox && <p className="truncate text-xs text-ink-muted">{mailbox}</p>}
					</div>
					<button type="button" onClick={onClose} aria-label="Close settings" className="flex h-10 w-10 items-center justify-center rounded-lg text-ink-muted transition hover:bg-hover hover:text-ink-2 focus-visible:outline-2 focus-visible:outline-accent"><X className="h-4 w-4" /></button>
				</header>
				<div className="flex min-h-0 flex-1 flex-col sm:flex-row">
					<nav aria-label="Settings sections" className="grid shrink-0 grid-cols-4 gap-1 border-b border-hair px-2 py-2 sm:flex sm:w-52 sm:flex-col sm:overflow-y-auto sm:border-b-0 sm:border-r sm:px-3 sm:py-4">
						{SECTIONS.map((item) => {
							const Icon = item.icon;
							return <button key={item.id} type="button" onClick={() => setSection(item.id)} aria-current={section === item.id ? "page" : undefined} className={`flex min-h-10 min-w-0 items-center justify-center gap-1 rounded-lg px-1 py-2 text-xs font-medium transition focus-visible:outline-2 focus-visible:outline-accent sm:justify-start sm:gap-3 sm:px-3 sm:text-left sm:text-sm ${section === item.id ? "bg-accent/15 text-accent" : "text-ink-muted hover:bg-hover hover:text-ink-2"}`}><Icon className="h-4 w-4 shrink-0" /><span>{item.label}</span></button>;
						})}
					</nav>
					<section aria-labelledby="settings-section-title" className="min-h-0 min-w-0 flex-1 overflow-y-auto px-5 py-6 sm:px-8 sm:py-7">
						<div className="mb-6 border-b border-hair pb-4">
							<h3 id="settings-section-title" className="text-lg font-semibold text-ink-2">{active.label}</h3>
							<p className="mt-1 text-sm text-ink-muted">{active.description}</p>
						</div>
						{section === "general" && <div className="divide-y divide-hair">
							<div className="flex items-center justify-between gap-4 py-4 first:pt-0">
								<div><p className="text-sm font-medium text-ink-2">Appearance</p><p className="mt-1 text-xs text-ink-muted">Choose a light or dark theme.</p></div>
								<button type="button" onClick={toggle} aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"} className="shrink-0 rounded-lg border border-hair-strong px-3 py-2 text-sm text-ink-2 hover:bg-hover">{theme === "dark" ? "Dark" : "Light"}</button>
							</div>
							<div className="flex items-center justify-between gap-4 py-4">
								<div><p className="flex items-center gap-2 text-sm font-medium text-ink-2"><Bell className="h-4 w-4" /> Desktop notifications</p><p className="mt-1 text-xs text-ink-muted">Get notified about new mail when this tab is in the background.</p></div>
								<button type="button" onClick={async () => setNotificationError((await onToggleNotify?.()) || "")} aria-label="Desktop notifications" aria-pressed={notifyOn} disabled={!onToggleNotify} className="shrink-0 rounded-lg border border-hair-strong px-3 py-2 text-sm text-ink-2 hover:bg-hover disabled:opacity-50">{notifyOn ? "On" : "Off"}</button>
							</div>
							{notificationError && <p role="alert" className="py-3 text-sm text-danger">{notificationError}</p>}
						</div>}
						{section === "profile" && <ProfileTab mailbox={mailbox} />}
						{section === "security" && <SecurityTab mailbox={mailbox} />}
						{section === "filters" && <FiltersTab mailbox={mailbox} folders={folders} />}
					</section>
				</div>
			</div>
		</div>
	);
}
