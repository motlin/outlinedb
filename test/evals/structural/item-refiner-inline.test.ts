import {expect, describe, it} from "vite-plus/test";
import {readFileSync} from "node:fs";
import {join} from "node:path";
import {PLUGINS_DIR} from "./helpers/scan-roots.js";

// item-refiner is itself a subagent. Nested tagger subagents returned launch acknowledgements the
// refiner mistook for results (writing nothing) or left it hanging for an hour, so the refiner
// applies every tagger and composer prompt inline and runs its ./bin/run.js calls one at a time.
const REFINEMENT_DIR = join(PLUGINS_DIR, "gtd", "prompts", "refinement");
const refiner = readFileSync(join(REFINEMENT_DIR, "item-refiner.md"), "utf8");

describe("Structural Eval: item-refiner runs taggers inline", () =>
{
	it("never launches nested subagents", () =>
	{
		const offenders = refiner
			.split("\n")
			.map((line, index) => (
			{
				line,
				at: index + 1,
			}))
			.filter(({line}) => /Agent tool|subagent_type|run_in_background|in parallel/iu.test(line))
			.map(({line, at}) => `${at}: ${line.trim()}`);
		expect(offenders).toStrictEqual([]);
	});

	it("applies every tagger and composer prompt", () =>
	{
		const expected = [
			"agenda-detector",
			"context-tagger",
			"destination-guesser",
			"due-date-detector",
			"people-tagger",
			"project-tagger",
			"tag-cleaner",
			"text-composer",
			"url-linker",
		];
		const missing = expected.filter((name) => !refiner.includes(`prompts/refinement/${name}.md`));
		expect(missing).toStrictEqual([]);
	});

	it("serializes lock-holding CLI calls", () =>
	{
		expect(refiner).toMatch(/run one CLI call at a time/u);
	});
});
