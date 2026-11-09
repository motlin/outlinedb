import fs from "node:fs";
import path from "node:path";
import {describe, expect, it} from "vite-plus/test";
import {MCP_ROOT, importGraphFrom} from "./import-graph.js";

const manifest = JSON.parse(fs.readFileSync(path.join(MCP_ROOT, "package.json"), "utf8")) as {
	exports?: Record<string, {source?: string}>;
};
const TOOLS_SOURCE = manifest.exports?.["./tools"]?.source;
const ALLOWED_BUILTIN = / -> node:(?:crypto|buffer)$/u;
const FORBIDDEN_PACKAGE = /(?: -> )(better-sqlite3|sqlite-vec|drizzle-orm\/better-sqlite3.*)$/u;

describe("@outlinedb/mcp/tools worker-safe import graph", () => {
	it("exports ./tools from src/register.ts", () => {
		expect(TOOLS_SOURCE).toBe("./src/register.ts");
	});

	const graph = importGraphFrom(path.join(MCP_ROOT, TOOLS_SOURCE ?? "src/register.ts"));

	it("reaches only node:crypto and node:buffer builtins", () => {
		expect(graph.builtins.filter((label) => !ALLOWED_BUILTIN.test(label))).toStrictEqual([]);
	});

	it("reaches no better-sqlite3 package", () => {
		expect(graph.packages.filter((label) => FORBIDDEN_PACKAGE.test(label))).toStrictEqual([]);
	});

	it("reaches no services.ts module", () => {
		expect(graph.files.filter((file) => path.basename(file) === "services.ts")).toStrictEqual([]);
	});
});
