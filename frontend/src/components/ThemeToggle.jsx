import { Sun, Moon } from "lucide-react";
import { useTheme } from "../context/theme.jsx";

export default function ThemeToggle() {
	const { theme, toggle } = useTheme();
	const isDark = theme === "dark";

	return (
		<button
			type="button"
			onClick={toggle}
			aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
			title={isDark ? "Light mode" : "Dark mode"}
			className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-ink-muted transition hover:bg-hover hover:text-ink-2"
		>
			{isDark ? (
				<Sun className="h-4 w-4" />
			) : (
				<Moon className="h-4 w-4" />
			)}
		</button>
	);
}