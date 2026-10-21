import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

afterEach(() => {
	cleanup();
	localStorage.clear();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

// happy-dom has no layout engine.
Element.prototype.scrollIntoView ??= () => {};
