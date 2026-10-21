// True when a keystroke belongs to a text field rather than to app shortcuts.
// Checkboxes/radios don't count, so clicking a row's checkbox doesn't swallow
// list navigation afterwards.
export function isTypingTarget(el) {
	return !!el?.closest?.(
		"input:not([type=checkbox]):not([type=radio]), textarea, select, [contenteditable=''], [contenteditable='true']",
	);
}
