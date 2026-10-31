import {QueryClient} from "@tanstack/react-query";
import {afterEach, describe, expect, it} from "vite-plus/test";
import {applyCustomTree, invalidateCustomTreeOnWrites} from "../src/client/hooks/use-custom-tree.js";
import type {CustomTreeResponse} from "../src/node-types.js";
import {hint} from "../src/client/keys/hint.js";
import {useCustomKeymapStore} from "../src/client/stores/custom-keymap.js";
import {useCustomThemesStore} from "../src/client/stores/custom-themes.js";
import {allThemes} from "../src/client/themes.js";

const node = (name: string, children: CustomTreeResponse["sections"][string] = []) => ({
	name,
	completed: false,
	children,
});

afterEach(() => {
	applyCustomTree({rootId: null, rootChildren: [], watchedIds: [], sections: {}});
});

describe("applyCustomTree", () => {
	it("makes a custom hotkey the hint, and a missing root restores the default", () => {
		applyCustomTree({
			rootId: "r",
			rootChildren: [],
			watchedIds: [],
			sections: {Hotkeys: [node("Hotkeys", [node("alt+z", [node("zoom_in")])])]},
		});
		const custom = hint("zoom_in");
		applyCustomTree({rootId: null, rootChildren: [], watchedIds: [], sections: {}});
		expect({custom, restored: hint("zoom_in")}).toStrictEqual({custom: "⌥Z", restored: "⌘."});
	});

	it("registers custom themes in the theme list and removes them when the tree goes away", () => {
		applyCustomTree({
			rootId: "r",
			rootChildren: [],
			watchedIds: [],
			sections: {
				Themes: [node("Themes", [node("My Theme", [node("main", [node("text-primary", [node("#111")])])])])],
			},
		});
		const names = allThemes().map((theme) => theme.name);
		applyCustomTree({rootId: null, rootChildren: [], watchedIds: [], sections: {}});
		expect({
			added: names.at(-1),
			after: allThemes().some((theme) => theme.name === "My_Theme"),
			keymap: useCustomKeymapStore.getState().overrides,
			themes: useCustomThemesStore.getState().themes,
		}).toStrictEqual({added: "My_Theme", after: false, keymap: [], themes: []});
	});
});

describe("invalidateCustomTreeOnWrites", () => {
	/** Whether a successful mutation with `variables` answering `data` marks the cached custom tree stale. */
	async function refetchesAfter(variables: unknown, data: unknown = null): Promise<boolean> {
		const queryClient = new QueryClient();
		queryClient.setQueryData<CustomTreeResponse>(["custom-tree", null], {
			rootId: "custom",
			rootChildren: [],
			watchedIds: ["custom", "home-sibling", "hotkeys", "combo"],
			sections: {},
		});
		const unsubscribe = invalidateCustomTreeOnWrites(queryClient);
		await queryClient
			.getMutationCache()
			.build(queryClient, {mutationFn: async () => Promise.resolve(data)})
			.execute(variables);
		unsubscribe();
		return queryClient.getQueryState(["custom-tree", null])?.isInvalidated ?? false;
	}

	it("refetches only after a write that names a watched node or a top-level parent", async () => {
		const results = {
			moveOutside: await refetchesAfter({ids: ["a", "b"], parent_id: "c", index: 0, expandParent: true}),
			editOutside: await refetchesAfter({nodeId: "a", name: "zoom_in"}),
			preference: await refetchesAfter({theme: "dark"}),
			editCombo: await refetchesAfter({nodeId: "combo", name: "alt+y"}),
			moveIntoHotkeys: await refetchesAfter({ids: ["a"], parent_id: "hotkeys", index: 0}),
			renameTopLevel: await refetchesAfter({nodeId: "home-sibling", name: "Custom"}),
			createTopLevel: await refetchesAfter({parent_id: null, name: "Custom"}),
			createdUnderCombo: await refetchesAfter({name: "zoom_out"}, {node: {id: "new", parent_id: "combo"}}),
		};
		expect(results).toStrictEqual({
			moveOutside: false,
			editOutside: false,
			preference: false,
			editCombo: true,
			moveIntoHotkeys: true,
			renameTopLevel: true,
			createTopLevel: true,
			createdUnderCombo: true,
		});
	});
});
