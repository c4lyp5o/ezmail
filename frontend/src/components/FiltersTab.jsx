import { Loader2, Plus, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { apiCall } from "../utils/apiCall.js";

const FIELDS = [
	{ value: "from", label: "From" },
	{ value: "subject", label: "Subject" },
	{ value: "to", label: "To" },
];

const MATCHES = [
	{ value: "contains", label: "contains" },
	{ value: "is", label: "is exactly" },
];

const EMPTY_RULE = { field: "from", match: "contains", value: "", folder: "" };

// Filters tab: server-side mail filters (Gmail-style) backed by Dovecot
// Sieve on the mail server. Rules apply at delivery — first match wins.
// Rendered inside SettingsModal's tabbed shell — no own overlay chrome.
export default function FiltersTab({ mailbox, folders = [] }) {
	const [rules, setRules] = useState([]);
	const [enabled, setEnabled] = useState(true);
	const idRef = useRef(0);
	const [loaded, setLoaded] = useState(false);
	const [loadFailed, setLoadFailed] = useState(false);
	const [conflict, setConflict] = useState(false);
	const [source, setSource] = useState("");
	const [busy, setBusy] = useState(false);
	const [removing, setRemoving] = useState(false);
	const [error, setError] = useState("");
	const [saved, setSaved] = useState(false);
	const [mode, setMode] = useState("sieve");
	const [workerError, setWorkerError] = useState("");

	const load = async () => {
		setLoadFailed(false);
		setError("");
		try {
			const res = await apiCall.get("/filters");
			setRules(
				(res.data?.rules || []).map((r) => ({ ...r, id: ++idRef.current })),
			);
			setEnabled(res.data?.enabled ?? true);
			setConflict(!!res.data?.conflict);
			setSource(res.data?.sieveSource || "");
			setMode(res.data?.mode || "sieve");
			setWorkerError(res.data?.lastError || "");
		} catch (err) {
			setLoadFailed(true);
			setError(err.message || "Could not load filters. Check the mail server connection.");
		} finally {
			setLoaded(true);
		}
	};

	// biome-ignore lint/correctness/useExhaustiveDependencies: later
	useEffect(() => {
		if (mailbox) {
			setError("");
			setSaved(false);
			setLoaded(false);
			setLoadFailed(false);
			setConflict(false);
			setSource("");
			setWorkerError("");
			load();
		}
	}, [mailbox]);

	useEffect(() => {
		if (mode !== "imap") return;
		let active = true;
		const timer = setInterval(async () => {
			try {
				const response = await apiCall.get("/filters");
				if (active && response.data?.mode === "imap") setWorkerError(response.data.lastError || "");
			} catch {
				if (active) setWorkerError("Could not check filtering status. Try again later.");
			}
		}, 30_000);
		return () => { active = false; clearInterval(timer); };
	}, [mode]);

	const updateRule = (i, patch) => {
		setRules((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
		setSaved(false);
	};

	const addRule = () => {
		setRules((rs) => [...rs, { ...EMPTY_RULE, id: ++idRef.current }]);
		setSaved(false);
	};

	const removeRule = (i) => {
		setRules((rs) => rs.filter((_, j) => j !== i));
		setSaved(false);
	};

	const save = async () => {
		setError("");
		// Strip client-only ids — the API expects exactly {field, match, value, folder}
		const clean = rules
			.filter((r) => r.value.trim() && r.folder.trim())
			.map(({ id, ...r }) => r);
		if (clean.length !== rules.length) {
			setError("Every rule needs a value and a folder.");
			return;
		}
		if (clean.length > 50) {
			setError("Maximum 50 rules.");
			return;
		}
		setBusy(true);
		try {
			const res = await apiCall.put("/filters", {
				rules: clean,
				enabled,
				mode,
			});
			if (!res.success) throw new Error(res.message || "Save failed");
			// Keep the stable client IDs used as React keys.
			setSaved(true);
		} catch (err) {
			setError(err.message);
		} finally {
			setBusy(false);
		}
	};

	const removeAll = async () => {
		setRemoving(true);
		setError("");
		try {
			await apiCall.del("/filters");
			await load();
			setSaved(false);
		} catch (err) {
			setError(err.message);
		} finally {
			setRemoving(false);
		}
	};

	const inputCls =
		"rounded-lg border border-hair bg-canvas px-2.5 py-1.5 text-sm text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none";

	return (
		<div>
			<p className="text-sm text-ink-muted">Rules apply to new mail. The first matching rule wins.</p>
			{mode === "unavailable" && <div role="alert" className="mt-3 rounded-lg border border-warn/20 bg-warn/10 p-3 text-sm text-ink-2">
				<p>Server-side filtering is unavailable. You can use ezmail to check the inbox and move matching new messages instead.</p>
				<p className="mt-2 text-xs text-ink-muted">Existing server rules may still run. This does not import or change them.</p>
				<button type="button" onClick={() => { setMode("imap"); setEnabled(true); }} className="mt-3 rounded-lg bg-accent px-3 py-2 text-sm font-medium text-white">Use ezmail filtering</button>
			</div>}
			{mode === "imap" && <div className="mt-3 rounded-lg border border-hair-strong bg-canvas p-3 text-sm text-ink-2">
				<p>ezmail checks for new inbox messages about once a minute while the ezmail server is running, including after you sign out. Rules do not move existing mail.</p>
				<p className="mt-2 text-xs text-ink-muted">Your mailbox password is stored encrypted for this feature. Disabling or deleting these rules removes the stored password.</p>
				{workerError && <p role="alert" className="mt-2 text-danger">{workerError}</p>}
			</div>}

			{conflict && <div role="alert" className="mt-3 text-sm text-danger">The active script is not an ezmail-generated script. It is read-only here; manage it externally.<pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap">{source}</pre></div>}
			{loadFailed && <div role="alert" className="mt-3 text-sm text-danger">{error} <button type="button" onClick={load} className="underline">Retry</button></div>}
			<fieldset disabled={mode === "unavailable" || conflict || loadFailed || busy || removing}>
			<label className="mt-3 flex cursor-pointer items-center gap-2 text-sm text-ink-2">
				<input
					type="checkbox"
					checked={enabled}
					onChange={(e) => {
						setEnabled(e.target.checked);
						setSaved(false);
					}}
					className="h-4 w-4 rounded border-hair-strong accent-accent"
				/>
				Filtering enabled
			</label>

			<div className="mt-4 min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
				{loaded && rules.length === 0 && (
					<div className="rounded-lg border border-dashed border-hair px-4 py-6 text-center text-sm text-ink-faint">
						No filters yet. Add one below — e.g. Subject contains
						&quot;invoice&quot; → folder &quot;Finance&quot;.
					</div>
				)}
				{rules.map((rule, i) => (
					<div
						key={rule.id}
						className="flex flex-wrap items-center gap-2 rounded-xl border border-hair bg-panel p-2.5"
					>
						<select
							value={rule.field}
							onChange={(e) => updateRule(i, { field: e.target.value })}
							className={inputCls}
						>
							{FIELDS.map((f) => (
								<option key={f.value} value={f.value}>
									{f.label}
								</option>
							))}
						</select>
						<select
							value={rule.match}
							onChange={(e) => updateRule(i, { match: e.target.value })}
							className={inputCls}
						>
							{MATCHES.map((m) => (
								<option key={m.value} value={m.value}>
									{m.label}
								</option>
							))}
						</select>
						<input
							value={rule.value}
							onChange={(e) => updateRule(i, { value: e.target.value })}
							placeholder="value…"
							maxLength={256}
							className={`${inputCls} min-w-32 flex-1`}
						/>
						<span className="text-ink-faint">→</span>
						<input
							value={rule.folder}
							onChange={(e) => updateRule(i, { folder: e.target.value })}
							placeholder="Folder"
							list="ezmail-folder-names"
							maxLength={64}
							className={`${inputCls} w-36`}
						/>
						<button
							type="button"
							onClick={() => removeRule(i)}
							title="Remove this filter"
							className="rounded-lg p-1.5 text-ink-muted transition hover:bg-danger/10 hover:text-danger"
						>
							<Trash2 className="h-4 w-4" />
						</button>
					</div>
				))}
				<datalist id="ezmail-folder-names">
					{folders.map((f) => (
						<option key={f.path} value={f.path} />
					))}
				</datalist>
			</div>

			{error && !loadFailed && <p className="mt-2 text-sm text-danger">{error}</p>}
			{saved && !error && (
				<p className="mt-2 text-sm text-accent">
					{enabled ? mode === "imap" ? "Saved — ezmail will check for new mail." : "Saved — filters are live for new mail." : "Saved — filtering is disabled."}
				</p>
			)}

			<div className="mt-4 flex items-center gap-2">
				<button
					type="button"
					onClick={addRule}
					className="flex items-center gap-1.5 rounded-lg border border-hair px-3 py-1.5 text-sm text-ink-2 transition hover:bg-hover"
				>
					<Plus className="h-4 w-4" />
					Add filter
				</button>
				<div className="flex-1" />
				<button
					type="button"
					onClick={removeAll}
					disabled={removing || loadFailed || !loaded}
					title="Delete all filters"
					className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm text-danger transition hover:bg-danger/10 disabled:opacity-40"
				>
					{removing ? (
						<Loader2 className="h-4 w-4 animate-spin" />
					) : (
						<Trash2 className="h-4 w-4" />
					)}
					Delete all
				</button>
				<button
					type="button"
					onClick={save}
					disabled={busy || loadFailed || !loaded}
					className="flex items-center gap-1.5 rounded-lg bg-accent px-4 py-1.5 text-sm font-medium text-white transition hover:bg-accent disabled:opacity-50"
				>
					{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Save"}
				</button>
			</div>
			</fieldset>
		</div>
	);
}
