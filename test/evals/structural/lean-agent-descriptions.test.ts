import {expect, describe, it} from "vite-plus/test";
import {readFileSync} from "node:fs";
import {PROJECT_ROOT, collectComponentFiles} from "./helpers/scan-roots.js";

// Every registered agent's description is loaded into context on every session. Examples only help
// auto-delegation, and these agents are always spawned by name, so they are pure listing cost.
describe("Structural Eval: Lean agent descriptions", () =>
{
	it("no agent frontmatter carries <example> blocks", () =>
	{
		const offenders: string[] = [];
		for (const filePath of collectComponentFiles("agents"))
		{
			const frontmatter = /^---\n([\s\S]*?)\n---/u.exec(readFileSync(filePath, "utf8"))?.[1] ?? "";
			if (frontmatter.includes("<example>"))
			{
				offenders.push(filePath.replace(`${PROJECT_ROOT}/`, ""));
			}
		}
		expect(offenders).toStrictEqual([]);
	});
});
