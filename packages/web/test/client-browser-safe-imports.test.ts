import path from "node:path";
import {describe, expect, it} from "vite-plus/test";
import {WEB_ROOT, nodeImportsReachableFrom} from "./import-graph.js";

const CLIENT_ENTRY = path.join(WEB_ROOT, "src/client/main.tsx");

describe("browser client import graph", () =>
{
	it("reaches no Node builtin from src/client/main.tsx", () =>
	{
		expect(nodeImportsReachableFrom(CLIENT_ENTRY)).toStrictEqual([]);
	});
});
