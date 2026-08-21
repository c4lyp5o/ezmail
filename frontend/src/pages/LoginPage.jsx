import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../context/auth.jsx";
import { Mail, ShieldCheck, ArrowLeft, Loader2 } from "lucide-react";
import ThemeToggle from "../components/ThemeToggle.jsx";

const inputCls =
	"w-full rounded-lg border border-hair bg-panel px-3 py-2.5 text-ink placeholder:text-ink-faint outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/25";

export default function LoginPage() {
	const { login, loginWithCode } = useAuth();
	const navigate = useNavigate();
	const [mailbox, setMailbox] = useState("");
	const [password, setPassword] = useState("");
	const [rememberMe, setRememberMe] = useState(false);
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	const [needsCode, setNeedsCode] = useState(false);
	const [code, setCode] = useState("");

	const submit = async (e) => {
		e.preventDefault();
		setBusy(true);
		setError("");
		try {
			const res = await login(mailbox.trim(), password, rememberMe);
			if (res?.totp) {
				setNeedsCode(true);
				setPassword("");
				return;
			}
			navigate("/mail", { replace: true });
		} catch (err) {
			setError(err.message || "Login failed");
		} finally {
			setBusy(false);
		}
	};

	const submitCode = async (e) => {
		e.preventDefault();
		if (!/^\d{6}$/.test(code)) {
			setError("Enter the full 6-digit code from your authenticator.");
			return;
		}
		setBusy(true);
		setError("");
		try {
			await loginWithCode(mailbox.trim(), code, rememberMe);
			navigate("/mail", { replace: true });
		} catch (err) {
			setError(err.message || "Code verification failed");
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-canvas px-4">
			{/* theme toggle in top corner */}
			<div className="absolute right-4 top-4">
				<ThemeToggle />
			</div>
			{/* soft ambient glow behind the card — one restrained accent */}
			<div
				aria-hidden
				className="pointer-events-none absolute -top-40 left-1/2 h-80 w-[36rem] -translate-x-1/2 rounded-full bg-accent/15 blur-[120px]"
			/>
			<div className="relative w-full max-w-sm">
				<div className="mb-8 flex flex-col items-center gap-3">
					<div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-hair bg-panel text-accent shadow-sm">
						{needsCode ? (
							<ShieldCheck className="h-6 w-6" />
						) : (
							<Mail className="h-6 w-6" />
						)}
					</div>
					<h1 className="text-2xl font-semibold tracking-tight text-ink">
						ezmail
					</h1>
					<p className="text-sm text-ink-muted">
						{needsCode ? "Enter your 6-digit code" : "Sign in to your mailbox"}
					</p>
				</div>

				{needsCode ? (
					<form onSubmit={submitCode} className="space-y-4">
						<div>
							{/** biome-ignore lint/a11y/noLabelWithoutControl: later */}
							<label className="mb-1.5 block text-sm font-medium text-ink-2">
								Authenticator code
							</label>
							<input
								type="text"
								value={code}
								onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
								className={`${inputCls} text-center font-mono text-lg tracking-[0.3em] text-ink`}
								placeholder="000000"
								maxLength={6}
								inputMode="numeric"
								autoComplete="one-time-code"
								// biome-ignore lint/a11y/noAutofocus: later
								autoFocus
								required
							/>
						</div>

						{error && (
							<div className="rounded-lg border border-danger/20 bg-danger/10 px-3 py-2 text-sm text-danger">
								{error}
							</div>
						)}

						<button
							type="submit"
							disabled={busy}
							className="flex w-full items-center justify-center gap-2 rounded-lg bg-accent py-2.5 font-medium text-white transition hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 disabled:opacity-50"
						>
							{busy ? (
								<Loader2 className="h-4 w-4 animate-spin" />
							) : (
								<ShieldCheck className="h-4 w-4" />
							)}
							{busy ? "Signing in…" : "Verify"}
						</button>

						<button
							type="button"
							onClick={() => {
								setNeedsCode(false);
								setCode("");
								setError("");
							}}
							className="flex w-full items-center justify-center gap-2 rounded-lg py-2 text-sm text-ink-muted transition hover:text-ink"
						>
							<ArrowLeft className="h-4 w-4" />
							Back
						</button>
					</form>
				) : (
					<form onSubmit={submit} className="space-y-4">
						<div>
							{/** biome-ignore lint/a11y/noLabelWithoutControl: later */}
							<label className="mb-1.5 block text-sm font-medium text-ink-2">
								Email address
							</label>
							<input
								type="email"
								value={mailbox}
								onChange={(e) => setMailbox(e.target.value)}
								className={inputCls}
								placeholder="you@example.com"
								// biome-ignore lint/a11y/noAutofocus: later
								autoFocus
								required
							/>
						</div>

						<div>
							{/** biome-ignore lint/a11y/noLabelWithoutControl: later */}
							<label className="mb-1.5 block text-sm font-medium text-ink-2">
								Password
							</label>
							<input
								type="password"
								value={password}
								onChange={(e) => setPassword(e.target.value)}
								className={inputCls}
								placeholder="Enter your mail password"
								required
							/>
						</div>

						<label className="flex items-center gap-2 text-sm text-ink-muted">
							<input
								type="checkbox"
								checked={rememberMe}
								onChange={(e) => setRememberMe(e.target.checked)}
								className="h-4 w-4 rounded border-hair-strong bg-panel accent-accent"
							/>
							Remember me
						</label>

						{error && (
							<div className="rounded-lg border border-danger/20 bg-danger/10 px-3 py-2 text-sm text-danger">
								{error}
							</div>
						)}

						<button
							type="submit"
							disabled={busy}
							className="w-full rounded-lg bg-accent py-2.5 font-medium text-white transition hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 disabled:opacity-50"
						>
							{busy ? "Signing in…" : "Sign in"}
						</button>
					</form>
				)}
			</div>
		</div>
	);
}
