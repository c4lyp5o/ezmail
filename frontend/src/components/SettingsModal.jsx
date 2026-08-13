import { useState, useEffect } from "react";
import { ShieldCheck, QrCode, KeyRound, Trash2, X, Loader2 } from "lucide-react";
import { apiCall } from "../utils/apiCall.js";

// User-management / security modal: enable/disable passwordless TOTP login.
// Parent (MailPage) controls open/close via `open` + `onClose`.
export default function SettingsModal({ open, onClose, mailbox }) {
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

	useEffect(() => {
		if (open) {
			setError("");
			setCode("");
			setPassword("");
			setStep("idle");
			loadStatus();
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open, mailbox]);

	if (!open) return null;

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
			setError(err.response?.data?.message || "Verification failed. Try again.");
		} finally {
			setBusy(false);
		}
	};

	// Toggle off (falls back to password login).
	const handleDisable = async () => {
		if (!window.confirm("Disable TOTP? This mailbox will fall back to password login.")) return;
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

	const close = () => {
		onClose();
	};

	return (
		<div
			className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
			onClick={close}
		>
			<div
				className="w-full max-w-md rounded-xl border border-zinc-700 bg-zinc-900 p-6 shadow-2xl"
				onClick={(e) => e.stopPropagation()}
			>
				<div className="mb-4 flex items-center justify-between">
					<h3 className="flex items-center gap-2 text-base font-semibold text-zinc-100">
						<ShieldCheck className="h-5 w-5 text-indigo-400" />
						Account security
					</h3>
					<button
						onClick={close}
						aria-label="Close settings"
						className="rounded p-1 text-zinc-500 transition hover:bg-zinc-800 hover:text-zinc-200"
					>
						<X className="h-4 w-4" />
					</button>
				</div>

				{mailbox && (
					<p className="mb-4 truncate text-xs text-zinc-500">{mailbox}</p>
				)}

				{error && (
					<div className="mb-4 rounded-lg border border-red-800 bg-red-950/50 px-3 py-2 text-sm text-red-400">
						{error}
					</div>
				)}

				{/* Status summary */}
				{status?.enabled ? (
					<div className="mb-4 flex items-center justify-between rounded-lg border border-emerald-800/60 bg-emerald-950/30 p-3">
						<div className="flex items-center gap-2 text-sm text-emerald-300">
							<ShieldCheck className="h-4 w-4" />
							TOTP enabled — passwordless login active
						</div>
						<button
							onClick={handleDisable}
							disabled={busy}
							className="flex items-center gap-1.5 rounded-md border border-red-800/60 px-2.5 py-1.5 text-xs font-medium text-red-400 transition hover:bg-red-950/50"
						>
							<Trash2 className="h-3.5 w-3.5" />
							Disable
						</button>
					</div>
				) : status?.enrolled && step === "idle" ? (
					<div className="mb-4 rounded-lg border border-amber-800/60 bg-amber-950/30 p-3 text-sm text-amber-300">
						TOTP is partially set up. Scan a fresh QR to finish, or disable to discard.
						<div className="mt-3 flex gap-2">
							<button
								onClick={() => setStep("qr")}
								className="rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-indigo-500"
							>
								Resume setup
							</button>
							<button
								onClick={handleDisable}
								disabled={busy}
								className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-400 transition hover:bg-zinc-800"
							>
								Discard
							</button>
						</div>
					</div>
				) : status && !status.enrolled && step === "idle" ? (
					<p className="mb-4 text-sm text-zinc-400">
						Turn on passwordless login. Sign in with just a 6-digit code from your
						authenticator app — no password prompt.
					</p>
				) : null}

				{/* Enrollment UI */}
				{step === "idle" && status && !status.enabled && (
					<form onSubmit={handleStart} className="space-y-3">
						<div>
							<label className="mb-1 block text-sm font-medium text-zinc-400">
								Mailbox password (one-time, to verify your account)
							</label>
							<input
								type="password"
								value={password}
								onChange={(e) => setPassword(e.target.value)}
								className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-zinc-100 outline-none focus:border-indigo-500"
								placeholder="Enter your mail password"
								autoFocus
								required
							/>
						</div>
						<button
							type="submit"
							disabled={busy}
							className="flex w-full items-center justify-center gap-2 rounded-lg bg-indigo-600 py-2 font-medium text-white transition hover:bg-indigo-500 disabled:opacity-50"
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
						<div className="mb-3 rounded-lg border border-zinc-700 bg-white p-4">
							<img
								src={qrDraft.qrCode}
								alt="TOTP enrollment QR code"
								className="mx-auto h-44 w-44 object-contain"
							/>
						</div>
						<p className="mb-3 text-center text-xs text-zinc-400">
							Scan with your authenticator app (e.g. Google Authenticator, Aegis).
						</p>
						<form onSubmit={handleComplete} className="space-y-3">
							<div>
								<label className="mb-1 block text-sm font-medium text-zinc-400">
									Enter the 6-digit code
								</label>
								<input
									type="text"
									value={code}
									onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
									className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-center text-lg tracking-[0.3em] text-zinc-100 outline-none focus:border-indigo-500"
									placeholder="000000"
									maxLength={6}
									inputMode="numeric"
									autoComplete="one-time-code"
									autoFocus
									required
								/>
							</div>
							<div className="flex gap-2">
								<button
									type="button"
									onClick={() => setStep("idle")}
									className="rounded-lg border border-zinc-700 px-3 py-2 text-sm font-medium text-zinc-400 transition hover:bg-zinc-800"
								>
									Back
								</button>
								<button
									type="submit"
									disabled={busy}
									className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-emerald-600 py-2 font-medium text-white transition hover:bg-emerald-500 disabled:opacity-50"
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
					<div className="rounded-lg border border-emerald-800/60 bg-emerald-950/30 p-4 text-center">
						<ShieldCheck className="mx-auto mb-2 h-8 w-8 text-emerald-400" />
						<p className="text-sm font-medium text-emerald-300">
							TOTP enabled. Sign in with your code from now on.
						</p>
						<button
							onClick={close}
							className="mt-3 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-emerald-500"
						>
							Done
						</button>
					</div>
				)}
			</div>
		</div>
	);
}