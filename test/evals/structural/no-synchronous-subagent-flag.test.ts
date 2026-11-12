import {expect, describe, it} from "vite-plus/test";
import {readFileSync} from "node:fs";
import {PROJECT_ROOT, collectComponentFiles} from "./helpers/scan-roots.js";

// The Agent tool has no synchronous mode: `run_in_background: false` is not a parameter, so a
// prompt that relies on it fans in before its subagents report and silently writes nothing.
describe("Structural Eval: No synchronous subagent flag", () =>
{
	it("no agent or command relies on run_in_background: false", () =>
	{
		const offenders: string[] = [];
		for (const filePath of [
			...collectComponentFiles("commands"),
			...collectComponentFiles("agents"),
			...collectComponentFiles("prompts"),
		])
		{
			const lines = readFileSync(filePath, "utf8").split("\n");
			for (const [index, line] of lines.entries())
			{
				if (/run_in_background:\s*false/u.test(line))
				{
					offenders.push(`${filePath.replace(`${PROJECT_ROOT}/`, "")}:${index + 1}`);
				}
			}
		}
		expect(offenders).toStrictEqual([]);
	});
});
