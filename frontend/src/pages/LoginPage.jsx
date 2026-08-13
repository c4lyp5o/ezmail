import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../context/auth.jsx";
import { Mail, ShieldCheck, ArrowLeft, Loader2 } from "lucide-react";
import ThemeToggle from "../components/ThemeToggle.jsx";
import { apiCall } from "../utils/apiCall.js";

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
	// step: "email" -> "password" | "totp"
	const [step, setStep] = useState("email");
	const [code, setCode] = useState("");

	// Step 1: check whether this mailbox uses passwordless TOTP. If so, we only
	// ask for a 6-digit code — never a password. Otherwise fall through to the
	// normal password login.
	const toNextStep = async (e) => {
		e.preventDefault();
		if (!mailbox.trim()) {
			setError("Enter your email address.");
			return;
		}
		setError("");
		const next = (s) => {
			setStep(s);
			setCode("");
			setPassword("");
		};
		try {
			const res = await apiCall.post("/totp/status", { mailbox: mailbox.trim() });
			const data = res?.data || {};
			if (data.enabled) {
				next("totp");
			} else {
				next("password");
			}
		} catch (err) {
			// If the status check fails (e.g. transient), fall back to password login.
			next("password");
		}
	};

	const submitPassword = async (e) => {
		e.preventDefault();
		setBusy(true);
		setError("");
		try {
			const res = await login(mailbox.trim(), password, rememberMe);
			// Edge case: TOTP got enabled between the status check and submit.
			if (res?.totp) {
				setStep("totp");
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

	const backToEmail = () => {
		setStep("email");
		setCode("");
		setPassword("");
		setError("");
	};

	const submit = step === "password" ? submitPassword : submitCode;

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
						{step !== "email" ? (
							<ShieldCheck className="h-6 w-6" />
						) : (
							<Mail className="h-6 w-6" />
						)}
					</div>
					<div className="text-center">
						<h1 className="text-xl font-semibold text-ink">
							{step === "totp"
								? "Enter your code"
								: step === "password"
									? "Welcome back"
									: "Sign in"}
						</h1>
						<p className="mt-1 text-sm text-ink-muted">
							{step === "totp"
								? "This mailbox uses passwordless login — enter your 6-digit code."
								: step === "password"
									? "This mailbox uses a password to log in."
									: "Enter your email to continue."}
						</p>
					</div>
				</div>

				{step === "email" ? (
					<form onSubmit={toNextStep} className="space-y-4">
						<div>
							<label className="mb-1.5 block text-sm font-medium text-ink-2">
								Email address
							</label>
							<input
								type="email"
								value={mailbox}
								onChange={(e) => setMailbox(e.target.value)}
								className={`${inputCls} ${step === "email" ? "" : ""}`.trim()}
								placeholder="you@example.com"
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
								<Mail className="h-4 w-4" />
							)}
							{busy ? "Checking…" : "Continue"}
						</button>
					</form>
				) : (
					<form onSubmit={submit} className="space-y-4">
						{step === "totp" ? (
							<div>
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
									autoFocus
									required
								/>
							</div>
						) : (
							<div>
								<label className="mb-1.5 block text-sm font-medium text-ink-2">
									Password
								</label>
								<input
									type="password"
									value={password}
									onChange={(e) => setPassword(e.target.value)}
									className={inputCls}
									placeholder="Enter your mail password"
									autoFocus
									required
								/>
							</div>
						)}

						{step === "password" && (
							<label className="flex items-center gap-2 text-sm text-ink-muted">
								<input
									type="checkbox"
									checked={rememberMe}
									onChange={(e) => setRememberMe(e.target.checked)}
									className="h-4 w-4 rounded border-hair-strong bg-panel accent-accent"
								/>
								Remember me
							</label>
						)}

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
							onClick={backToEmail}
							className="flex w-full items-center justify-center gap-2 rounded-lg py-2 text-sm text-ink-muted transition hover:text-ink"
						>
							<ArrowLeft className="h-4 w-4" />
							Back
						</button>
					</form>
				)}
			</div>
		</div>
	);
}