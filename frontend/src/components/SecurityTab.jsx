import { KeyRound, Loader2, QrCode, ShieldCheck, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { apiCall } from "../utils/apiCall.js";

// Security tab: enable/disable passwordless TOTP login for this mailbox.
// Rendered inside SettingsModal's tabbed shell — no own overlay chrome.
export default function SecurityTab({ mailbox }) {
	const [status, setStatus] = useState(null); // { enrolled, enabled }
	const [step, setStep] = useState("idle"); // idle | qr | done
	const [qrDraft, setQrDraft] = useState(null); // { qrCode, secret }
	const [password, setPassword] = useState("");
	const [code, setCode] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");

	const loadStatus = async () => {
		if (!mailbox) return;
		try {
			const res = await apiCall.post("/totp/status", { mailbox });
			setStatus(res.data);
		} catch {
			setStatus({ enrolled: false, enabled: false });
		}
	};

	// biome-ignore lint/correctness/useExhaustiveDependencies: later
	useEffect(() => {
		if (mailbox) loadStatus();
	}, [mailbox]);

	// Step 1: verify password against IMAP, get the fresh secret + QR.
	const handleStart = async (e) => {
		e.preventDefault();
		setBusy(true);
		setError("");
		try {
			const res = await apiCall.post("/totp/begin", {
				mailbox,
				password,
			});
			setQrDraft(res.data);
			setStep("qr");
			setPassword("");
		} catch (err) {
			setError(err.response?.data?.message || "Could not start enrollment");
		} finally {
			setBusy(false);
		}
	};

	// Step 2: validate the 6-digit code and activate.
	const handleComplete = async (e) => {
		e.preventDefault();
		if (!/^\d{6}$/.test(code)) {
			setError("Enter the full 6-digit code from your authenticator.");
			return;
		}
		setBusy(true);
		setError("");
		try {
			await apiCall.post("/totp/complete", { mailbox, code });
			await loadStatus();
			setStep("done");
			setCode("");
		} catch (err) {
			setError(
				err.response?.data?.message || "Verification failed. Try again.",
			);
		} finally {
			setBusy(false);
		}
	};

	// Toggle off (falls back to password login).
	const handleDisable = async () => {
		if (
			!window.confirm(
				"Disable TOTP? This mailbox will fall back to password login.",
			)
		)
			return;
		setBusy(true);
		setError("");
		try {
			await apiCall.post("/totp/disable", { mailbox });
			await loadStatus();
			setStep("idle");
			setQrDraft(null);
		} catch (err) {
			setError(err.response?.data?.message || "Could not disable TOTP");
		} finally {
			setBusy(false);
		}
	};

	return (
		<div>
			{mailbox && (
				<p className="mb-4 truncate text-xs text-ink-muted">{mailbox}</p>
			)}

			{error && (
				<div className="mb-4 rounded-lg border border-danger/20 bg-danger/10 px-3 py-2 text-sm text-danger">
					{error}
				</div>
			)}

			{/* Status summary */}
			{status?.enabled ? (
				<div className="mb-4 flex items-center justify-between rounded-lg border border-success/20/60 bg-success/10/30 p-3">
					<div className="flex items-center gap-2 text-sm text-success">
						<ShieldCheck className="h-4 w-4" />
						TOTP enabled — passwordless login active
					</div>
					<button
						type="button"
						onClick={handleDisable}
						disabled={busy}
						className="flex items-center gap-1.5 rounded-md border border-danger/20/60 px-2.5 py-1.5 text-xs font-medium text-danger transition hover:bg-danger/10"
					>
						<Trash2 className="h-3.5 w-3.5" />
						Disable
					</button>
				</div>
			) : status?.enrolled && step === "idle" ? (
				<div className="mb-4 rounded-lg border border-warn/20/60 bg-warn/10/30 p-3 text-sm text-warn">
					TOTP is partially set up. Scan a fresh QR to finish, or disable to
					discard.
					<div className="mt-3 flex gap-2">
						<button
							type="button"
							onClick={() => setStep("qr")}
							className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white transition hover:bg-accent"
						>
							Resume setup
						</button>
						<button
							type="button"
							onClick={handleDisable}
							disabled={busy}
							className="rounded-md border border-hair-strong px-3 py-1.5 text-xs font-medium text-ink-muted transition hover:bg-hover"
						>
							Discard
						</button>
					</div>
				</div>
			) : status && !status.enrolled && step === "idle" ? (
				<p className="mb-4 text-sm text-ink-muted">
					Turn on passwordless login. Sign in with just a 6-digit code from your
					authenticator app — no password prompt.
				</p>
			) : null}

			{/* Enrollment UI */}
			{step === "idle" && status && !status.enabled && (
				<form onSubmit={handleStart} className="space-y-3">
					<div>
						{/** biome-ignore lint/a11y/noLabelWithoutControl: later */}
						<label className="mb-1 block text-sm font-medium text-ink-muted">
							Mailbox password (one-time, to verify your account)
						</label>
						<input
							type="password"
							value={password}
							onChange={(e) => setPassword(e.target.value)}
							className="w-full rounded-lg border border-hair bg-canvas px-3 py-2 text-ink outline-none focus:border-accent"
							placeholder="Enter your mail password"
							required
						/>
					</div>
					<button
						type="submit"
						disabled={busy}
						className="flex w-full items-center justify-center gap-2 rounded-lg bg-accent py-2 font-medium text-white transition hover:bg-accent disabled:opacity-50"
					>
						{busy ? (
							<Loader2 className="h-4 w-4 animate-spin" />
						) : (
							<QrCode className="h-4 w-4" />
						)}
						{busy ? "Preparing…" : "Generate QR code"}
					</button>
				</form>
			)}

			{step === "qr" && qrDraft && (
				<div>
					<div className="mb-3 rounded-lg border border-hair-strong bg-white p-4">
						<img
							src={qrDraft.qrCode}
							alt="TOTP enrollment QR code"
							className="mx-auto h-44 w-44 object-contain"
						/>
					</div>
					<p className="mb-3 text-center text-xs text-ink-muted">
						Scan with your authenticator app (e.g. Google Authenticator, Aegis).
					</p>
					<form onSubmit={handleComplete} className="space-y-3">
						<div>
							{/** biome-ignore lint/a11y/noLabelWithoutControl: later */}
							<label className="mb-1 block text-sm font-medium text-ink-muted">
								Enter the 6-digit code
							</label>
							<input
								type="text"
								value={code}
								onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
								className="w-full rounded-lg border border-hair bg-canvas px-3 py-2 text-center text-lg tracking-[0.3em] text-ink outline-none focus:border-accent"
								placeholder="000000"
								maxLength={6}
								inputMode="numeric"
								autoComplete="one-time-code"
								required
							/>
						</div>
						<div className="flex gap-2">
							<button
								type="button"
								onClick={() => setStep("idle")}
								className="rounded-lg border border-hair-strong px-3 py-2 text-sm font-medium text-ink-muted transition hover:bg-hover"
							>
								Back
							</button>
							<button
								type="submit"
								disabled={busy}
								className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-success py-2 font-medium text-white transition hover:bg-success disabled:opacity-50"
							>
								{busy ? (
									<Loader2 className="h-4 w-4 animate-spin" />
								) : (
									<KeyRound className="h-4 w-4" />
								)}
								{busy ? "Verifying…" : "Activate TOTP"}
							</button>
						</div>
					</form>
				</div>
			)}

			{step === "done" && (
				<div className="rounded-lg border border-success/20/60 bg-success/10/30 p-4 text-center">
					<ShieldCheck className="mx-auto mb-2 h-8 w-8 text-success" />
					<p className="text-sm font-medium text-success">
						TOTP enabled. Sign in with your code from now on.
					</p>
					<button
						type="button"
						onClick={() => setStep("idle")}
						className="mt-3 rounded-lg bg-accent px-4 py-1.5 text-sm font-medium text-white transition hover:bg-accent"
					>
						Done
					</button>
				</div>
			)}
		</div>
	);
}
