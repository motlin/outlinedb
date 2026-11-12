import {describe, expect, it} from "vite-plus/test";
import {APP_MENU_CONFIG} from "../src/client/app-menu-config.js";
import fixture from "./fixtures/upstream-menu-config.json" with {type: "json"};

describe("APP_MENU_CONFIG", () =>
{
	it("holds upstream's ordered menus, with false flags", () =>
	{
		expect(
			Object.fromEntries(
				Object.entries(APP_MENU_CONFIG.orderedUi).map(([menu, keys]) => [
					menu,
					keys.map(([id, flag]) => (flag ? id : `${id}:false`)),
				]),
			),
		).toStrictEqual(fixture.ordered_ui);
	});

	it("holds upstream's active and block sets", () =>
	{
		const asSets = (sets: Record<string, readonly string[]>) =>
			Object.fromEntries(
				Object.entries(sets).map(([key, ids]) => [key, Object.fromEntries(ids.map((id) => [id, true]))]),
			);
		expect(
			{
				active: asSets(APP_MENU_CONFIG.activeSets),
				block: asSets(APP_MENU_CONFIG.blockSets),
			},
		).toStrictEqual(
			{
				active: fixture.menu_active_set,
				block: fixture.menu_block_set,
			},
		);
	});

	it("marks node_type_picker as the one submenu with its label and icon", () =>
	{
		expect(
			{
				submenus: [...APP_MENU_CONFIG.isSubmenu],
				labels: APP_MENU_CONFIG.labels,
				icons: APP_MENU_CONFIG.icons,
			},
		).toStrictEqual(
			{
				submenus: Object.keys(fixture.is_submenu),
				labels: fixture.ui_label,
				icons: fixture.icon,
			},
		);
	});
});
