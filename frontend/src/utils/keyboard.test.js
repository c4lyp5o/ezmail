import { expect, test } from "vitest";
import { isTypingTarget } from "./keyboard.js";

test.each([
	["<input>", true],
	['<input type="email">', true],
	["<textarea></textarea>", true],
	["<select></select>", true],
	['<div contenteditable="true"><span id="t"></span></div>', true],
	['<input type="checkbox">', false],
	["<button></button>", false],
	["<div></div>", false],
])("%s → %s", (html, expected) => {
	document.body.innerHTML = html;
	const el = document.getElementById("t") || document.body.firstElementChild;
	expect(isTypingTarget(el)).toBe(expected);
});

test("null-safe", () => {
	expect(isTypingTarget(null)).toBe(false);
	expect(isTypingTarget(window)).toBe(false);
});
