import { Filter, Loader2, Plus, Trash2 } from "lucide-react";
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
	const [busy, setBusy] = useState(false);
	const [removing, setRemoving] = useState(false);
	const [error, setError] = useState("");
	const [saved, setSaved] = useState(false);

	const load = async () => {
		try {
			const res = await apiCall.get("/filters");
			setRules(
				(res.data?.rules || []).map((r) => ({ ...r, id: ++idRef.current })),
			);
			setEnabled(res.data?.enabled ?? true);
		} catch {
			setRules([]);
			setEnabled(true);
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
			load();
		}
	}, [mailbox]);

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
			});
			if (!res.success) throw new Error(res.message || "Save failed");
			setRules(clean);
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
			setRules([]);
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
			<div className="mb-1 flex items-center gap-2.5">
				<div className="flex h-9 w-9 items-center justify-center rounded-lg bg-accent/15 text-accent">
					<Filter className="h-4.5 w-4.5" />
				</div>
				<div>
					<h3 className="text-lg font-semibold text-ink-2">Mail filters</h3>
					<p className="text-xs text-ink-faint">
						Server-side sorting for {mailbox} — applies the moment mail arrives.
					</p>
				</div>
			</div>

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

			{error && <p className="mt-2 text-sm text-danger">{error}</p>}
			{saved && !error && (
				<p className="mt-2 text-sm text-accent">
					Saved — filters are live for new mail.
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
					disabled={removing || (!rules.length && !loaded)}
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
					disabled={busy}
					className="flex items-center gap-1.5 rounded-lg bg-accent px-4 py-1.5 text-sm font-medium text-white transition hover:bg-accent disabled:opacity-50"
				>
					{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Save"}
				</button>
			</div>
		</div>
	);
}
