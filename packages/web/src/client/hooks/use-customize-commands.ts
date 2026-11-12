/**
 * Upstream's `customize_hotkeys` and `customize_themes` Labs commands. They have no label, so they are reachable by id
 * only: each creates the Custom root and its Hotkeys/Themes node on first use, then zooms into it.
 */

import {isFeatureOn} from "../features.js";
import {useQueryClient} from "@tanstack/react-query";
import type {NodeEnvelope} from "../../node-types.js";
import {readJson} from "../read-json.js";
import {nodeUrl} from "../navigation.js";
import type {Command} from "../keys/dispatch.js";
import {planCustomizeHotkeys, planCustomizeThemes, runCustomizePlan} from "../keys/custom-templates.js";
import type {CustomizePlan} from "../keys/custom-templates.js";
import {THEME_PROPS} from "../custom-themes.js";
import {CUSTOM_ROOT_STORAGE_KEY, chosenCustomRootId, fetchCustomTree} from "./use-custom-tree.js";

async function postNode(
	parentId: string | null,
	node:
	{
		name: string;
		note?: string;
	},
	index?: number,
): Promise<string>
{
	const response = await fetch(
		"/api/v1/nodes",
		{
			method: "POST",
			headers:
			{
				"Content-Type": "application/json",
			},
			body: JSON.stringify(
				{
					...node,
					...(parentId === null
						? {}
						:
							{
								parent_id: parentId,
							}),
					...(index === undefined
						? {}
						:
							{
								index,
							}),
				},
			),
		},
	);
	if (!response.ok)
	{
		throw new Error("Failed to create a custom node");
	}
	const data = await readJson<NodeEnvelope>(response);
	return data.node.id;
}

/** The current computed `--wf-<prop>` values, so the Light Copy theme starts as the current look. */
function currentThemeValues(): Record<string, string>
{
	const styles = getComputedStyle(document.body);
	const values: Record<string, string> = {};
	for (const prop of THEME_PROPS)
	{
		const value = styles.getPropertyValue(`--wf-${prop}`).trim();
		if (value !== "")
		{
			values[prop] = value;
		}
	}
	return values;
}

export function useCustomizeCommands(navigate: (url: string) => void): Record<string, Command>
{
	const queryClient = useQueryClient();
	const run = async (makePlan: (info: Parameters<typeof planCustomizeHotkeys>[0]) => CustomizePlan): Promise<void> =>
	{
		const tree = await fetchCustomTree(chosenCustomRootId());
		const info =
			tree.rootId === null
				? null
				:
					{
						id: tree.rootId,
						children: tree.rootChildren,
					};
		const {rootId, zoomTo} = await runCustomizePlan(
			makePlan(info),
			{
				rootId: tree.rootId,
				create: postNode,
			},
		);
		try
		{
			localStorage.setItem(CUSTOM_ROOT_STORAGE_KEY, rootId);
		}
		catch
		{
			// Storage can be blocked; the root is still found by its name.
		}
		await queryClient.invalidateQueries(
			{
				queryKey: ["custom-tree"],
			},
		);
		navigate(nodeUrl(zoomTo));
	};
	return {
		customize_hotkeys:
		{
			execute()
			{
				if (!isFeatureOn("beta_redirect"))
				{
					return;
				}
				void run((info) => planCustomizeHotkeys(info));
			},
		},
		customize_themes:
		{
			execute()
			{
				if (!isFeatureOn("beta_redirect"))
				{
					return;
				}
				void run((info) => planCustomizeThemes(info, currentThemeValues()));
			},
		},
	};
}
