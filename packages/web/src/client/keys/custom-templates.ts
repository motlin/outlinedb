/**
 * Upstream's `customize_hotkeys` / `customize_themes` templates: the notes and example nodes a first run creates
 * under the account's Custom root. The texts are upstream's, byte for byte.
 */

export interface PlannedNode
{
	name: string;
	note?: string;
	children?: PlannedNode[];
}

export const CUSTOM_ROOT_NOTE = '\n"Custom" is a special node but you can move and rename it.\n\n';

export const HOTKEYS_NOTE =
	"\nStructure:\n- [hotkey]\n    - [command]\n\nYou can find all available commands in the command palette.\n\nIf a hotkey is defined multiple times, the definition lowest in the tree wins.\n\nDefining a custom hotkey for a command releases all default hotkeys for that command.\n\nOnly commands available in the palette can have their hotkeys overridden.\n\nOrder: alt+ctrl+meta+shift+[key].\n\nMacOS: Opt = alt, Cmd = meta.\n\n";

const THEMES_NOTE =
	"\nStructure:\n- [theme]\n    - [surface]\n        - [property]\n            - [hex]\n\nThemes defined in this list appear in the Settings.\n\nYou can create new themes or override existing ones.\n\nThe 'Light Copy' is set as current, try to change it.\n\nSurfaces use the same properties as 'main' e.g. background-primary.\n\n";

export const HOTKEYS_EXAMPLE: PlannedNode[] = [
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
];

export interface CustomizePlan
{
	/** Created as the last child of the account root when there is no Custom root. */
	createRoot?:
	{
		name: "Custom";
		note: string;
	};
	/** Created as the first child of the root when it has no child of that name. */
	createGrammar?:
	{
		position: "top";
	} & PlannedNode;
	/** The existing grammar node's id, or "grammar" for the one this plan creates. */
	zoomTo: string;
}

export interface CustomRootInfo
{
	id: string;
	children: readonly
	{
		id: string;
		name: string;
	}[];
}

function planFor(root: CustomRootInfo | null, grammar: string, template: PlannedNode): CustomizePlan
{
	const existing = root?.children.find((child) => child.name === grammar);
	if (existing !== undefined)
	{
		return {
			zoomTo: existing.id,
		};
	}
	return {
		...(root === null
			?
				{
					createRoot:
					{
						name: "Custom" as const,
						note: CUSTOM_ROOT_NOTE,
					},
				}
			: {}),
		createGrammar:
		{
			position: "top",
			...template,
		},
		zoomTo: "grammar",
	};
}

export function planCustomizeHotkeys(root: CustomRootInfo | null): CustomizePlan
{
	return planFor(
		root,
		"Hotkeys",
		{
			name: "Hotkeys",
			note: HOTKEYS_NOTE,
			children: HOTKEYS_EXAMPLE,
		},
	);
}

/** `values` are the current computed `--wf-<prop>` values, so the copy starts as the current theme. */
export function planCustomizeThemes(
	root: CustomRootInfo | null,
	values: Readonly<Record<string, string>>,
): CustomizePlan
{
	const main: PlannedNode =
	{
		name: "main",
		note: "Try to change background to #EEEEEE",
		children: Object.entries(values).map(([prop, value]) => (
		{
			name: prop,
			children: [
				{
					name: value,
				},
			],
		})),
	};
	const others = ["menu", "header", "left-bar", "dialog"].map((name): PlannedNode => (
	{
		name,
		children: [
			{
				name: "...",
			},
		],
	}));
	return planFor(
		root,
		"Themes",
		{
			name: "Themes",
			note: THEMES_NOTE,
			children: [
				{
					name: "Light Copy",
					children: [main, ...others],
				},
			],
		},
	);
}

export interface PlanDeps
{
	/** Creates one node and returns its id; `parentId` null is the account root, `index` omitted is the bottom. */
	create: (
		parentId: string | null,
		node:
		{
			name: string;
			note?: string;
		},
		index?: number,
	) => Promise<string>;
	rootId: string | null;
}

/** Runs a plan with the given node creator and returns the id to zoom into. */
export async function runCustomizePlan(
	customizePlan: CustomizePlan,
	deps: PlanDeps,
): Promise<
{
	rootId: string;
	zoomTo: string;
}>
{
	let rootId = deps.rootId;
	if (customizePlan.createRoot !== undefined)
	{
		rootId = await deps.create(null, customizePlan.createRoot);
	}
	if (rootId === null)
	{
		throw new Error("No Custom root to create under");
	}
	const parent = rootId;
	if (customizePlan.createGrammar === undefined)
	{
		return {
			rootId: parent,
			zoomTo: customizePlan.zoomTo,
		};
	}
	const build = async (parentId: string, node: PlannedNode, index?: number): Promise<string> =>
	{
		const id = await deps.create(
			parentId,
			{
				name: node.name,
				...(node.note === undefined
					? {}
					:
						{
							note: node.note,
						}),
			},
			index,
		);
		for (const child of node.children ?? [])
		{
			await build(id, child);
		}
		return id;
	};
	const zoomTo = await build(parent, customizePlan.createGrammar, 0);
	return {
		rootId: parent,
		zoomTo,
	};
}
