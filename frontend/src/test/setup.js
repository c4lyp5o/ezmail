import { cleanup, configure } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";
import { installEventSource } from "./event-source.js";
import { resetClosingSaves } from "../utils/closingSaves.js";

// No real network from tests: a fake EventSource by default.
beforeEach(() => {
	installEventSource();
});

// findBy*/waitFor default to 1s, which a cold first run (fresh transform
// cache, loaded machine) can exceed; keep a generous ceiling.
configure({ asyncUtilTimeout: 5000 });

afterEach(async () => {
	cleanup();
	// A composer's close-time draft save goes out a microtask after unmount;
	// let it reach the mocked fetch before the globals are restored.
	await Promise.resolve();
	resetClosingSaves();
	localStorage.clear();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

// happy-dom has no layout engine.
Element.prototype.scrollIntoView ??= () => {};
