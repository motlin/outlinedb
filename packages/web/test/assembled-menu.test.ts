import {describe, expect, it, vi} from "vite-plus/test";

const showMenuById = vi.fn<
	(
		menuId: string,
		target:
		{
			top: number;
			left: number;
		},
	) => void
>();
vi.mock("../src/client/stores/outline.js", () => (
{
	useOutlineStore:
	{
		getState: () => (
		{
			showMenuById,
		}),
	},
}));

const {renderAssembledMenu} = await import("../src/client/components/assembled-menu.js");

const cmd =
{
	key: "delete",
	label: "Delete",
	icon: "trash-can",
	shortcut: "⇧⌘⌫",
};
const entries = [
	{
		kind: "submenu" as const,
		id: "node_type_picker",
	},
	{
		kind: "separator" as const,
	},
	{
		kind: "command" as const,
		id: "delete",
		cmd,
	},
];
const options =
{
	cmdContext:
	{
		nodeIds: ["alice"],
	},
	qualifiers: ["is_bullets"],
	onSelect: () =>
	{
	},
};

describe("renderAssembledMenu", () =>
{
	it("drops separators on mobile and keeps them on desktop", () =>
	{
		expect([
			renderAssembledMenu(entries, options).length,
			renderAssembledMenu(
				entries,
				{
					...options,
					isMobile: true,
				},
			).length,
		]).toStrictEqual([3, 2]);
	});

	it("opens the submenu at the click's page point with the parent's context and qualifiers", () =>
	{
		const [submenuRow] = renderAssembledMenu(entries, options);
		submenuRow.props.onSelect?.(
			{
				pageX: 40,
				pageY: 60,
			},
		);
		expect(showMenuById.mock.calls).toStrictEqual([
			[
				"node_type_picker",
				{
					top: 60,
					left: 40,
				},
				{
					nodeIds: ["alice"],
				},
				["is_bullets"],
			],
		]);
	});

	it("labels the submenu row from the config and gives it no handbook or shortcut", () =>
	{
		const [submenuRow, , commandRow] = renderAssembledMenu(entries, options);
		expect(
			{
				submenu: [
					submenuRow.props.label,
					submenuRow.props.icon,
					submenuRow.props.handbook,
					submenuRow.props.shortcut,
				],
				command: [
					commandRow.props.label,
					commandRow.props.icon,
					commandRow.props.handbook,
					commandRow.props.shortcut,
				],
			},
		).toStrictEqual(
			{
				submenu: ["Turn into...", "fal:list-ul", undefined, undefined],
				command: ["Delete", "fal:trash-can", "delete", "⇧⌘⌫"],
			},
		);
	});

	it("runs onSelect with the command", () =>
	{
		const onSelect = vi.fn<(command: typeof cmd) => void>();
		renderAssembledMenu(
			entries,
			{
				...options,
				onSelect,
			},
		)[2]?.props.onSelect?.();
		expect(onSelect.mock.calls).toStrictEqual([[cmd]]);
	});
});
