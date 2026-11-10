import fs from "node:fs";
import path from "node:path";
import {describe, expect, it} from "vite-plus/test";
import {readNodeConfig} from "../src/server/config.js";

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
