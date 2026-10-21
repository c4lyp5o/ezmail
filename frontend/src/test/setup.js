import { cleanup, configure } from "@testing-library/react";
import { afterEach, vi } from "vitest";

// findBy*/waitFor default to 1s, which a cold first run (fresh transform
// cache, loaded machine) can exceed; keep a generous ceiling.
configure({ asyncUtilTimeout: 5000 });

afterEach(() => {
	cleanup();
	localStorage.clear();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

// happy-dom has no layout engine.
Element.prototype.scrollIntoView ??= () => {};
