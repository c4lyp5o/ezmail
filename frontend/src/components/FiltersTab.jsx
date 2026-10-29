import { ArrowDown, ArrowUp, Loader2, Plus, Trash2 } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { apiCall } from "../utils/apiCall.js";
import { describeRule, FIELDS, MATCHES, ruleMatches, validFolderName } from "../utils/filterRules.js";
import ConfirmPanel from "./ConfirmPanel.jsx";

const EMPTY_RULE = { field: "from", match: "contains", value: "", folder: "" };
const NEW_FOLDER = "\0new";

// Client-only keys (id, custom) never go to the API, which expects exactly {field, match, value, folder}.
const plain = ({ id, custom, ...rule }) => rule;
const snapshot = (rules, enabled, mode) => JSON.stringify({ rules: rules.map(plain), enabled, mode });

const inputCls =
	"min-h-10 w-full rounded-lg border border-hair bg-canvas px-2.5 py-1.5 text-sm text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none sm:min-h-0 sm:w-auto";
const iconBtn =
	"flex h-10 w-10 items-center justify-center rounded-lg text-ink-muted transition hover:bg-hover hover:text-ink-2 focus-visible:outline-2 focus-visible:outline-accent aria-disabled:opacity-30 aria-disabled:hover:bg-transparent sm:h-8 sm:w-8";

function TestRule({ rules, enabled }) {
	const [sample, setSample] = useState({ from: "", to: "", subject: "" });
	const entered = Object.values(sample).some((v) => v.trim());
	const hits = entered ? rules.map((rule, i) => (ruleMatches(rule, sample) ? i : -1)).filter((i) => i >= 0) : [];
	const winner = rules[hits[0]];
	const fieldCls = `${inputCls} sm:w-full`;

	let result = "Enter a sample sender, recipient or subject to see which rule applies.";
	if (entered && !winner) result = "No rule matches. The message would stay in Inbox.";
	if (winner) {
		const stays = winner.folder.toUpperCase() === "INBOX";
		result = `Rule ${hits[0] + 1} matches. ${describeRule(winner)}${stays ? " The message would stay in Inbox." : ""}`;
		if (hits.length > 1) result += ` Also matches rule ${hits.slice(1).map((i) => i + 1).join(", ")}, but the first match wins.`;
	}
	if (entered && !enabled) result += " Filtering is turned off, so no rule would run.";

	return (
		<fieldset className="mt-6 rounded-xl border border-hair p-3">
			<legend className="px-1 text-sm font-medium text-ink-2">Test your rules</legend>
			<p className="text-xs text-ink-muted">Uses the rules as currently edited. Nothing is moved.</p>
			<div className="mt-2 grid gap-2 sm:grid-cols-3">
				{FIELDS.map((f) => (
					<label key={f.value} className="block text-xs text-ink-muted">
						Sample {f.label.toLowerCase()}
						<input value={sample[f.value]} onChange={(e) => setSample((s) => ({ ...s, [f.value]: e.target.value }))} placeholder={f.value === "subject" ? "Invoice #1042" : "name@example.com"} className={`mt-1 ${fieldCls}`} />
					</label>
				))}
			</div>
			<p role="status" className="mt-3 text-sm text-ink-2">{result}</p>
		</fieldset>
	);
}

// Filters tab: mail filters (Gmail-style), run by Dovecot Sieve on the mail
// server or by ezmail's IMAP fallback. First match wins.
// Rendered inside SettingsModal's tabbed shell — no own overlay chrome.
export default function FiltersTab({ mailbox, folders = [], onDirtyChange }) {
	const [rules, setRules] = useState([]);
	const [enabled, setEnabled] = useState(true);
	const idRef = useRef(0);
	const [loaded, setLoaded] = useState(false);
	const [loadFailed, setLoadFailed] = useState(false);
	const [conflict, setConflict] = useState(false);
	const [source, setSource] = useState("");
	const [busy, setBusy] = useState(false);
	const [removing, setRemoving] = useState(false);
	const [confirmDelete, setConfirmDelete] = useState(false);
	const [error, setError] = useState("");
	const [saved, setSaved] = useState(false);
	const [mode, setMode] = useState("sieve");
	const [workerError, setWorkerError] = useState("");
	const [lastCheck, setLastCheck] = useState(null);
	const [baseline, setBaseline] = useState(null);
	const [announce, setAnnounce] = useState("");
	const listRef = useRef(null);
	const moveFocus = useRef(null);
	const addRef = useRef(null);
	const refocusAdd = useRef(false);

	const dirty = loaded && !loadFailed && baseline !== null && snapshot(rules, enabled, mode) !== baseline;
	const dirtyRef = useRef(onDirtyChange);
	dirtyRef.current = onDirtyChange;
	useEffect(() => { dirtyRef.current?.(dirty); }, [dirty]);
	useEffect(() => () => dirtyRef.current?.(false), []);

	// A moved row is re-inserted by React, which drops focus; put it back on the same button.
	useLayoutEffect(() => {
		const target = moveFocus.current;
		if (!target) return;
		moveFocus.current = null;
		listRef.current?.querySelector(`[data-rule-id="${target.id}"] [data-move="${target.dir}"]`)?.focus();
	});

	// The fieldset is disabled while deleting, which drops focus; settle it on a stable control.
	useEffect(() => {
		if (removing || !refocusAdd.current) return;
		refocusAdd.current = false;
		addRef.current?.focus();
	}, [removing]);

	const load = async () => {
		setLoadFailed(false);
		setError("");
		try {
			const res = await apiCall.get("/filters");
			const next = (res.data?.rules || []).map((r) => ({ ...r, id: ++idRef.current }));
			const nextEnabled = res.data?.enabled ?? true;
			const nextMode = res.data?.mode || "sieve";
			setRules(next);
			setEnabled(nextEnabled);
			setConflict(!!res.data?.conflict);
			setSource(res.data?.sieveSource || "");
			setMode(nextMode);
			setWorkerError(res.data?.lastError || "");
			setLastCheck(res.data?.lastCheck ?? null);
			setBaseline(snapshot(next, nextEnabled, nextMode));
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
			setLastCheck(null);
			setBaseline(null);
			load();
		}
	}, [mailbox]);

	useEffect(() => {
		if (mode !== "imap") return;
		let active = true;
		const timer = setInterval(async () => {
			try {
				const response = await apiCall.get("/filters");
				if (active && response.data?.mode === "imap") {
					setWorkerError(response.data.lastError || "");
					setLastCheck(response.data.lastCheck ?? null);
				}
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
		setAnnounce(`Rule ${i + 1} removed`);
		setSaved(false);
	};

	const moveRule = (i, delta, dir) => {
		const j = i + delta;
		if (j < 0 || j >= rules.length) return;
		moveFocus.current = { id: rules[i].id, dir };
		setRules((rs) => {
			const next = [...rs];
			[next[i], next[j]] = [next[j], next[i]];
			return next;
		});
		setAnnounce(`Rule moved to position ${j + 1} of ${rules.length}`);
		setSaved(false);
	};

	const save = async () => {
		setError("");
		const clean = rules.map(plain).filter((r) => r.value.trim() && r.folder.trim());
		if (clean.length !== rules.length) {
			setError("Every rule needs a value and a folder.");
			return;
		}
		if (clean.some((r) => !validFolderName(r.folder))) {
			setError("Folder names may only use letters, numbers, spaces, dots, dashes and underscores.");
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
			setBaseline(snapshot(rules, enabled, mode));
			setSaved(true);
		} catch (err) {
			setError(err.message);
		} finally {
			setBusy(false);
		}
	};

	const removeAll = async () => {
		setConfirmDelete(false);
		refocusAdd.current = true;
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

	const folderOptions = folders.map((f) => f.path).filter(validFolderName);
	const method = {
		sieve: ["Mail server (Sieve)", "Rules run on the mail server as mail arrives, even when ezmail is closed."],
		imap: ["ezmail fallback", "ezmail checks for new inbox messages about once a minute while the ezmail server is running, including after you sign out. Rules do not move existing mail."],
		unavailable: ["Not available", "Server-side filtering is unavailable. You can use ezmail to check the inbox and move matching new messages instead."],
	}[mode];

	return (
		<div>
			<p className="text-sm text-ink-muted">Rules apply to new mail, from top to bottom. The first matching rule wins.</p>
			{loaded && !loadFailed && (
				<div className="mt-3 rounded-lg border border-hair-strong bg-canvas p-3 text-sm text-ink-2">
					<p><span className="text-ink-muted">Filtering method:</span> <strong className="font-medium">{method[0]}</strong></p>
					<p className="mt-1 text-xs text-ink-muted">{method[1]}</p>
					{mode === "unavailable" && <>
						<div role="alert" className="mt-2 rounded-lg border border-warn/20 bg-warn/10 p-2 text-xs text-ink-2">Existing server rules may still run. Switching does not import or change them.</div>
						<button type="button" onClick={() => { setMode("imap"); setEnabled(true); }} className="mt-3 min-h-10 rounded-lg bg-accent px-3 py-2 text-sm font-medium text-white">Use ezmail filtering</button>
					</>}
					{mode === "imap" && <>
						<p className="mt-2 text-xs text-ink-muted">Your mailbox password is stored encrypted for this feature. Disabling or deleting these rules removes the stored password.</p>
						<p className="mt-2 text-xs text-ink-muted">Last successful check: {lastCheck ? new Date(lastCheck).toLocaleString() : "none yet"}</p>
						{workerError
							? <p role="alert" className="mt-2 text-danger">Problem: {workerError}</p>
							: <p role="status" className="mt-2 text-xs text-ink-muted">No problems reported.</p>}
					</>}
				</div>
			)}

			{conflict && <div role="alert" className="mt-3 text-sm text-danger">The active script is not an ezmail-generated script. It is read-only here; manage it externally.<pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap">{source}</pre></div>}
			{loadFailed && <div role="alert" className="mt-3 text-sm text-danger">{error} <button type="button" onClick={load} className="underline">Retry</button></div>}
			<fieldset disabled={mode === "unavailable" || conflict || loadFailed || busy || removing}>
			<label className="mt-3 flex min-h-10 cursor-pointer items-center gap-2 text-sm text-ink-2">
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

			<div className="mt-4 min-h-0 flex-1">
				{loaded && rules.length === 0 && (
					<div className="rounded-lg border border-dashed border-hair px-4 py-6 text-center text-sm text-ink-faint">
						No filters yet. Add one below — e.g. If Subject contains
						&quot;invoice&quot;, move to Finance.
					</div>
				)}
				<ol ref={listRef} aria-label="Filter rules, in priority order" className="space-y-2">
					{rules.map((rule, i) => {
						const n = i + 1;
						const known = folderOptions.includes(rule.folder);
						const picking = rule.custom || (rule.folder && !known && !folders.length);
						return (
							<li key={rule.id} data-rule-id={rule.id} className="rounded-xl border border-hair bg-panel p-2.5">
								<div className="flex items-center gap-1">
									<span className="flex-1 text-xs font-medium text-ink-muted">Rule {n}{n === 1 && rules.length > 1 ? " · checked first" : ""}</span>
									<button type="button" data-move="up" aria-disabled={i === 0} onClick={() => moveRule(i, -1, "up")} aria-label={`Move rule ${n} up`} title="Move up" className={iconBtn}><ArrowUp className="h-4 w-4" /></button>
									<button type="button" data-move="down" aria-disabled={i === rules.length - 1} onClick={() => moveRule(i, 1, "down")} aria-label={`Move rule ${n} down`} title="Move down" className={iconBtn}><ArrowDown className="h-4 w-4" /></button>
									<button type="button" onClick={() => removeRule(i)} aria-label={`Remove rule ${n}`} title="Remove this filter" className={`${iconBtn} hover:bg-danger/10 hover:text-danger`}><Trash2 className="h-4 w-4" /></button>
								</div>
								<div className="mt-2 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
									<div className="flex items-center gap-2">
										<span className="text-sm text-ink-muted">If</span>
										<select value={rule.field} onChange={(e) => updateRule(i, { field: e.target.value })} aria-label={`Rule ${n}: message field`} className={inputCls}>
											{FIELDS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
										</select>
										<select value={rule.match} onChange={(e) => updateRule(i, { match: e.target.value })} aria-label={`Rule ${n}: comparison`} className={inputCls}>
											{MATCHES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
										</select>
									</div>
									<input value={rule.value} onChange={(e) => updateRule(i, { value: e.target.value })} aria-label={`Rule ${n}: text to match`} placeholder="e.g. invoice" maxLength={256} className={`${inputCls} min-w-32 sm:flex-1`} />
									<div className="flex flex-wrap items-center gap-2">
										<span className="whitespace-nowrap text-sm text-ink-muted">move to</span>
										{picking ? (<>
											<input value={rule.folder} onChange={(e) => updateRule(i, { folder: e.target.value })} aria-label={`Rule ${n}: new folder name`} placeholder="New folder name" maxLength={64} className={`${inputCls} sm:w-40`} />
											{folderOptions.length > 0 && <button type="button" onClick={() => updateRule(i, { folder: "", custom: false })} className="min-h-10 px-1 text-xs text-accent underline sm:min-h-0">Pick existing folder</button>}
										</>) : (
											<select
												value={rule.folder}
												onChange={(e) => e.target.value === NEW_FOLDER ? updateRule(i, { folder: "", custom: true }) : updateRule(i, { folder: e.target.value })}
												aria-label={`Rule ${n}: destination folder`}
												className={`${inputCls} sm:w-40`}
											>
												<option value="" disabled>Choose folder…</option>
												{rule.folder && !known && <option value={rule.folder}>{rule.folder} (will be created)</option>}
												{folderOptions.map((p) => <option key={p} value={p}>{p}</option>)}
												<option value={NEW_FOLDER}>New folder…</option>
											</select>
										)}
									</div>
								</div>
							</li>
						);
					})}
				</ol>
				<p role="status" className="sr-only">{announce}</p>
			</div>

			{rules.length > 0 && <TestRule rules={rules} enabled={enabled} />}

			{error && !loadFailed && <p role="alert" className="mt-2 text-sm text-danger">{error}</p>}
			{saved && !error && (
				<p role="status" className="mt-2 text-sm text-accent">
					{enabled ? mode === "imap" ? "Saved — ezmail will check for new mail." : "Saved — filters are live for new mail." : "Saved — filtering is disabled."}
				</p>
			)}
			{dirty && !saved && <p className="mt-2 text-xs text-ink-muted">You have unsaved changes.</p>}

			<div className="mt-4 flex flex-wrap items-center gap-2">
				<button
					ref={addRef}
					type="button"
					onClick={addRule}
					className="flex min-h-10 items-center gap-1.5 rounded-lg border border-hair px-3 py-1.5 text-sm text-ink-2 transition hover:bg-hover"
				>
					<Plus className="h-4 w-4" />
					Add filter
				</button>
				<div className="flex-1" />
				<button
					type="button"
					onClick={() => setConfirmDelete(true)}
					disabled={removing || loadFailed || !loaded}
					title="Delete all filters"
					className="flex min-h-10 items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm text-danger transition hover:bg-danger/10 disabled:opacity-40"
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
					className="flex min-h-10 items-center gap-1.5 rounded-lg bg-accent px-4 py-1.5 text-sm font-medium text-white transition hover:bg-accent disabled:opacity-50"
				>
					{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Save"}
				</button>
			</div>
			</fieldset>
			{confirmDelete && (
				<ConfirmPanel title="Delete all filters?" confirmLabel="Delete all filters" onConfirm={removeAll} onCancel={() => setConfirmDelete(false)}>
					This removes every saved rule{mode === "imap" ? " and the stored mailbox password" : ""}, and discards any unsaved edits. Mail already filed stays where it is.
				</ConfirmPanel>
			)}
		</div>
	);
}
