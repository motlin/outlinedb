import fs from "node:fs";
import path from "node:path";
import {describe, expect, it} from "vite-plus/test";
import {readNodeConfig} from "../src/server/config.js";
import {DEFAULT_PORT, resolvePort} from "../src/server/port.js";
import {WEB_ROOT, importsReachableFrom} from "./import-graph.js";

describe("server config", () => {
	describe("readNodeConfig", () => {
		it("reads every setting from the environment", () => {
			expect(
				readNodeConfig({
					WORKFLOWY_API_KEY: "key",
					WORKFLOWY_API_URL: "http://localhost:9",
					WORKFLOWY_USERNAME: "user@example.com",
					OUTLINEDB_SQL_QUERY_LOGGING: "true",
					CALENDAR_ENSURE_ENABLED: "false",
					CALENDAR_LAYOUT_ENABLED: "false",
				}),
			).toStrictEqual({
				mode: "mirror",
				apiKey: "key",
				apiUrl: "http://localhost:9",
				accountEmail: "user@example.com",
				sqlQueryLogging: true,
				calendarEnsureEnabled: false,
				calendarLayoutEnabled: false,
				features: {embeddings: true, treeSnapshot: true},
			});
		});

		it("defaults: flags on, logging off, no key so standalone, empty email", () => {
			expect(readNodeConfig({})).toStrictEqual({
				mode: "standalone",
				apiKey: undefined,
				apiUrl: undefined,
				accountEmail: "",
				sqlQueryLogging: false,
				calendarEnsureEnabled: true,
				calendarLayoutEnabled: true,
				features: {embeddings: true, treeSnapshot: true},
			});
		});
	});

	describe("server source", () => {
		it("reads process.env only in the Node entry modules", () => {
			const root = path.resolve(import.meta.dirname, "../src/server");
			const allowed = new Set(["config.ts", "db.ts", "index.ts", "node-context.ts"]);
			const offenders: string[] = [];
			const walk = (dir: string): void => {
				for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
					const full = path.join(dir, entry.name);
					if (entry.isDirectory()) {
						walk(full);
					} else if (
						entry.name.endsWith(".ts") &&
						!allowed.has(path.relative(root, full)) &&
						/process\.env\b/u.test(fs.readFileSync(full, "utf8").replaceAll(/\/\*[\s\S]*?\*\//gu, ""))
					) {
						offenders.push(path.relative(root, full));
					}
				}
			};
			walk(root);
			expect(offenders).toStrictEqual([]);
		});
	});
});

describe("server port", () => {
	describe("resolvePort", () => {
		it("defaults to a port no sibling project claims, so dev never lands on the crowded 3000", () => {
			expect(DEFAULT_PORT).toBe(5176);
			expect(resolvePort({})).toBe(5176);
		});

		it("honours PORT so a second instance can run beside a running dev server", () => {
			expect(resolvePort({PORT: "3010"})).toBe(3010);
		});

		it("falls back to the default when PORT is empty or not a number", () => {
			expect(resolvePort({PORT: ""})).toBe(5176);
			expect(resolvePort({PORT: "nope"})).toBe(5176);
		});
	});
});

describe("server worker safe imports", () => {
	const APP_ENTRY = path.join(WEB_ROOT, "src/server/app.ts");
	const ALLOWED_BUILTINS = new Set(["node:crypto", "node:buffer"]);
	const FORBIDDEN_PACKAGE = /(?: -> )(better-sqlite3|sqlite-vec|@hono\/node-.*|drizzle-orm\/better-sqlite3.*)$/u;

	describe("worker-safe server import graph", () => {
		const {builtins, packages} = importsReachableFrom(APP_ENTRY);

		it("reaches only node:crypto and node:buffer builtins from src/server/app.ts", () => {
			expect(builtins.filter((label) => !ALLOWED_BUILTINS.has(label.split(" -> ")[1]))).toStrictEqual([]);
		});

		it("reaches no Node-only package from src/server/app.ts", () => {
			expect(packages.filter((label) => FORBIDDEN_PACKAGE.test(label))).toStrictEqual([]);
		});
	});
});
