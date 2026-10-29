import { describe, expect, test } from "bun:test";
import { generateSieveScript, parseGeneratedScript } from "../services/filter.service.js";

const rules = [
	{ field: "subject", match: "contains", value: 'invoice "quoted"', folder: "Finance" },
	{ field: "from", match: "is", value: "boss@example.com", folder: "Boss" },
];

describe("generated Sieve scripts", () => {
	test("round-trips existing generated rules", () => {
		const script = generateSieveScript(rules);
		expect(script).toContain('fileinto :create "Finance";');
		expect(parseGeneratedScript(script)).toEqual(rules);
		expect(parseGeneratedScript(generateSieveScript([]))).toEqual([]);
	});

	test("rejects modified and arbitrary scripts even with the marker", () => {
		const script = generateSieveScript(rules);
		expect(parseGeneratedScript(`${script}\nredirect "other@example.com";`)).toBeNull();
		expect(parseGeneratedScript(script.replace("\tstop;", "\tkeep;"))).toBeNull();
		expect(parseGeneratedScript('require ["fileinto"];\nkeep;')).toBeNull();
	});

	test("rejects generated scripts containing control characters", () => {
		const script = generateSieveScript([{ ...rules[0], value: "bad\nvalue" }]);
		expect(parseGeneratedScript(script)).toBeNull();
	});
});

import { filterState, saveFilters } from "../services/filter.service.js";

function fakeSieve(active, scripts = {}) {
	return {
		active, scripts: { ...scripts }, calls: [], fail: "", errmsg: "server refused",
		async listscripts() { return [this.active, Object.keys(this.scripts).filter((n) => n !== this.active)]; },
		async getscript(name) { return this.scripts[name] ?? null; },
		async checkscript() { this.calls.push("check"); return this.fail !== "check"; },
		async putscript(name, source) { this.calls.push("put"); if (this.fail === "put") return false; this.scripts[name] = source; return true; },
		async deletescript(name) { delete this.scripts[name]; return true; },
		async setactive(name) { this.calls.push("activate"); if (this.fail === "activate") return false; this.active = name || undefined; return true; },
	};
}

describe("ManageSieve filter operations", () => {
	test("custom active scripts are read-only", async () => {
		const client = fakeSieve("custom", { custom: "keep;" });
		expect((await filterState(client)).conflict).toBe(true);
		await expect(saveFilters(client, rules, true)).rejects.toThrow("not managed");
		expect(client.calls).toEqual([]);
		expect(client.scripts.custom).toBe("keep;");
	});

	for (const stage of ["check", "put", "activate"]) {
		test(`${stage} failure preserves the active script`, async () => {
			const original = generateSieveScript(rules);
			const client = fakeSieve("original", { original });
			client.fail = stage;
			await expect(saveFilters(client, [], true)).rejects.toThrow();
			expect(client.active).toBe("original");
			expect(client.scripts.original).toBe(original);
		});
	}

	test("validates, saves and activates a new script without deleting the old one", async () => {
		const client = fakeSieve("original", { original: generateSieveScript([]) });
		await saveFilters(client, rules, true);
		expect(client.calls).toEqual(["check", "put", "activate"]);
		expect(client.active).not.toBe("original");
		expect((await filterState(client)).rules).toEqual(rules);
		expect(client.scripts.original).toBeDefined();
	});
});
