import path from "node:path";
import {describe, expect, it} from "vite-plus/test";
import {WEB_ROOT, importsReachableFrom} from "./import-graph.js";

const APP_ENTRY = path.join(WEB_ROOT, "src/server/app.ts");
const ALLOWED_BUILTINS = new Set(["node:crypto", "node:buffer"]);
const FORBIDDEN_PACKAGE = /(?: -> )(better-sqlite3|sqlite-vec|@hono\/node-.*|drizzle-orm\/better-sqlite3.*)$/u;

describe("worker-safe server import graph", () =>
{
	const {builtins, packages} = importsReachableFrom(APP_ENTRY);

	it("reaches only node:crypto and node:buffer builtins from src/server/app.ts", () =>
	{
		expect(builtins.filter((label) => !ALLOWED_BUILTINS.has(label.split(" -> ")[1]))).toStrictEqual([]);
	});

	it("reaches no Node-only package from src/server/app.ts", () =>
	{
		expect(packages.filter((label) => FORBIDDEN_PACKAGE.test(label))).toStrictEqual([]);
	});
});
