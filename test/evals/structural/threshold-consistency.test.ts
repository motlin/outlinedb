import {beforeAll, describe, expect, it} from "vite-plus/test";
import {parseMarkdownFile} from "./helpers/markdown-parser.js";
import {PROJECT_ROOT, collectComponentFiles} from "./helpers/scan-roots.js";

interface ThresholdOccurrence
{
	value: number;
	context: string;
	file: string;
	line: number;
}

describe("Structural Eval: Numeric Thresholds", () =>
{
	let allThresholds: ThresholdOccurrence[];

	beforeAll(() =>
	{
		allThresholds = [];
		const sourceFiles = [
			...collectComponentFiles("commands"),
			...collectComponentFiles("agents"),
			...collectComponentFiles("skills"),
		];

		for (const filePath of sourceFiles)
		{
			const analysis = parseMarkdownFile(filePath);
			const relativeFile = filePath.replace(`${PROJECT_ROOT}/`, "");

			for (const ref of analysis.thresholds)
			{
				allThresholds.push(
					{
						value: ref.value,
						context: ref.context,
						file: relativeFile,
						line: ref.line,
					},
				);
			}
		}
	});

	it("keeps numeric thresholds out of GTD markdown", () =>
	{
		expect(allThresholds).toStrictEqual([]);
	});
});
