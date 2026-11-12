import {readFileSync} from "node:fs";
import {describe, expect, it} from "vite-plus/test";
import {FULL_WIDTH_ZEN_COMMANDS} from "../src/client/full-width-zen-commands.js";

describe("full width and zen commands", () =>
{
	it("carry upstream's ids, labels and icons", () =>
	{
		expect(FULL_WIDTH_ZEN_COMMANDS).toStrictEqual([
			{
				id: "toggle_full_width_page",
				label: "Toggle Full Width Page",
				icon: null,
			},
			{
				id: "zen_mode",
				label: "Toggle Zen Mode",
				icon: "bullseye",
			},
		]);
	});

	it("are registered in the command registry", () =>
	{
		const source = readFileSync(new URL("../src/client/hooks/use-command-registry.ts", import.meta.url), "utf8");
		expect(FULL_WIDTH_ZEN_COMMANDS.map(({id}) => source.includes(`${id}:`))).toStrictEqual([true, true]);
	});
});
