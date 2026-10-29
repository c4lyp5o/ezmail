import { describe, expect, test } from "bun:test";
import { createLimiter } from "../services/rate-limit.service.js";

describe("createLimiter", () => {
	test("blocks after max failures, until the window ends", () => {
		const l = createLimiter({ max: 3, windowMs: 60000 });
		for (let i = 0; i < 3; i++) {
			expect(l.retryAfter("a", 0)).toBe(0);
			l.fail("a", 0);
		}
		expect(l.retryAfter("a", 1000)).toBe(59);
		expect(l.retryAfter("b", 1000)).toBe(0);
		expect(l.retryAfter("a", 60000)).toBe(0);
	});

	test("reset clears failures", () => {
		const l = createLimiter({ max: 1, windowMs: 60000 });
		l.fail("a", 0);
		expect(l.retryAfter("a", 0)).toBeGreaterThan(0);
		l.reset("a");
		expect(l.retryAfter("a", 0)).toBe(0);
	});

	test("caps tracked keys", () => {
		const l = createLimiter({ max: 1, windowMs: 60000, maxKeys: 2 });
		l.fail("a", 0);
		l.fail("b", 0);
		l.fail("c", 0);
		expect(l.retryAfter("a", 0)).toBe(0);
		expect(l.retryAfter("c", 0)).toBeGreaterThan(0);
	});

	test("success does not erase concurrent reservations", () => {
		const l = createLimiter({ max: 2, windowMs: 60000 });
		const a = l.reserve("a", 0);
		const b = l.reserve("a", 0);
		expect(l.reserve("a", 0).wait).toBe(60);
		a.settle(true);
		expect(l.reserve("a", 0).wait).toBe(0);
		b.settle(false);
		expect(l.reserve("a", 0).wait).toBe(60);
	});
});
