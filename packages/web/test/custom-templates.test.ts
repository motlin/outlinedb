import {describe, expect, it} from "vite-plus/test";
import
{
	CUSTOM_ROOT_NOTE,
	HOTKEYS_EXAMPLE,
	HOTKEYS_NOTE,
	planCustomizeHotkeys,
	planCustomizeThemes,
	runCustomizePlan,
} from "../src/client/keys/custom-templates.js";

describe("planCustomizeHotkeys", () =>
{
	it("creates the root and the Hotkeys node with upstream's note and examples", () =>
	{
		expect(planCustomizeHotkeys(null)).toStrictEqual(
			{
				createRoot:
				{
					name: "Custom",
					note: CUSTOM_ROOT_NOTE,
				},
				createGrammar:
				{
					position: "top",
					name: "Hotkeys",
					note: HOTKEYS_NOTE,
					children: HOTKEYS_EXAMPLE,
				},
				zoomTo: "grammar",
			},
		);
		expect(HOTKEYS_EXAMPLE).toStrictEqual([
			{
				name: "alt+q",
				children: [
					{
						name: "show_command_palette",
					},
				],
			},
			{
				name: "alt+shift+e",
				children: [
					{
						name: "show_test_message",
					},
				],
			},
			{
				name: "ctrl+shift+m",
				children: [
					{
						name: "mirror_to",
						note: "Yes, we'd rather implement custom hotkeys than add this one ourselves.",
					},
				],
			},
		]);
		expect(HOTKEYS_NOTE.startsWith("\nStructure:")).toBe(true);
		expect(HOTKEYS_NOTE.endsWith("MacOS: Opt = alt, Cmd = meta.\n\n")).toBe(true);
	});

	it("only zooms when the root already has a Hotkeys child", () =>
	{
		expect(
			planCustomizeHotkeys(
				{
					id: "r",
					children: [
						{
							id: "h1",
							name: "Hotkeys",
						},
					],
				},
			),
		).toStrictEqual(
			{
				zoomTo: "h1",
			},
		);
	});

	it("creates just the Hotkeys node under an existing root", () =>
	{
		expect(
			planCustomizeHotkeys(
				{
					id: "r",
					children: [],
				},
			).createRoot,
		).toBeUndefined();
	});
});

describe("planCustomizeThemes", () =>
{
	it("copies the current values under Light Copy with placeholder surfaces", () =>
	{
		const {createGrammar} = planCustomizeThemes(
			{
				id: "r",
				children: [],
			},
			{
				"background-primary": "#fff",
			},
		);
		expect(createGrammar?.children).toStrictEqual([
			{
				name: "Light Copy",
				children: [
					{
						name: "main",
						note: "Try to change background to #EEEEEE",
						children: [
							{
								name: "background-primary",
								children: [
									{
										name: "#fff",
									},
								],
							},
						],
					},
					{
						name: "menu",
						children: [
							{
								name: "...",
							},
						],
					},
					{
						name: "header",
						children: [
							{
								name: "...",
							},
						],
					},
					{
						name: "left-bar",
						children: [
							{
								name: "...",
							},
						],
					},
					{
						name: "dialog",
						children: [
							{
								name: "...",
							},
						],
					},
				],
			},
		]);
	});
});

describe("runCustomizePlan", () =>
{
	it("creates the root, then the grammar at the top with its children, and zooms to the grammar", async () =>
	{
		const calls: [string | null, string, number | undefined][] = [];
		let next = 0;
		const result = await runCustomizePlan(
			planCustomizeHotkeys(null),
			{
				rootId: null,
				create: async (parentId, node, index) =>
				{
					calls.push([parentId, node.name, index]);
					next += 1;
					return Promise.resolve(`id${next}`);
				},
			},
		);
		expect(
			{
				result,
				firstThree: calls.slice(0, 3),
			},
		).toStrictEqual(
			{
				result:
				{
					rootId: "id1",
					zoomTo: "id2",
				},
				firstThree: [
					[null, "Custom", undefined],
					["id1", "Hotkeys", 0],
					["id2", "alt+q", undefined],
				],
			},
		);
	});
});
