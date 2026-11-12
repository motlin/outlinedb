import {describe, expect, it} from "vite-plus/test";
import {movePaneItems} from "../src/client/components/move-pane-items.js";

const A = "AAAAAAAAAAA";
const B = "BBBBBBBBBBB";

function rows(
	panes:
	{
		id: string;
	}[],
	paneId: string,
)
{
	const moves: string[] = [];
	const items = movePaneItems(
		{
			panes,
		},
		paneId,
		(id, index) =>
		{
			moves.push(`${id}:${index}`);
		},
	);
	for (const item of items)
	{
		if (item.disabled !== true)
		{
			item.onSelect();
		}
	}
	return {
		rows: items.map((item) => `${item.label}${item.disabled === true ? " (disabled)" : ""}`),
		moves,
	};
}

describe("movePaneItems", () =>
{
	it("is hidden with no pane open", () =>
	{
		expect(rows([], "main")).toStrictEqual(
			{
				rows: [],
				moves: [],
			},
		);
	});

	it("disables the direction the pane cannot move and moves the menu's own pane one place", () =>
	{
		expect(
			{
				main: rows(
					[
						{
							id: A,
						},
						{
							id: B,
						},
					],
					"main",
				),
				middle: rows(
					[
						{
							id: A,
						},
						{
							id: B,
						},
					],
					A,
				),
				last: rows(
					[
						{
							id: A,
						},
						{
							id: B,
						},
					],
					B,
				),
			},
		).toStrictEqual(
			{
				main:
				{
					rows: ["Move pane left (disabled)", "Move pane right"],
					moves: ["main:1"],
				},
				middle:
				{
					rows: ["Move pane left", "Move pane right"],
					moves: [`${A}:0`, `${A}:2`],
				},
				last:
				{
					rows: ["Move pane left", "Move pane right (disabled)"],
					moves: [`${B}:1`],
				},
			},
		);
	});
});
