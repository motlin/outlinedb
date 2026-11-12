import {describe, expect, it} from "vite-plus/test";
import {canRenderLayout, complexLayouts} from "../src/client/layouts.js";

const reached =
{
	reachedRoot: true,
	dashboardsFlag: false,
};

describe("WF.Layouts port", () =>
{
	it("registers dashboard as complex only with the flag on", () =>
	{
		expect(
			{
				off: [...complexLayouts(false)],
				on: [...complexLayouts(true)],
			},
		).toStrictEqual(
			{
				off: ["table", "board"],
				on: ["table", "board", "dashboard"],
			},
		);
	});

	it("gates complex layouts on the ancestors up to the render root", () =>
	{
		const table =
		{
			layoutMode: "table",
		};
		const boardNode =
		{
			layoutMode: "board",
		};
		expect(
			{
				zoomRoot: canRenderLayout("table", table, [], reached),
				tableInBoard: canRenderLayout(
					"table",
					table,
					[
						{
							layoutMode: "board",
						},
					],
					reached,
				),
				boardInCard: canRenderLayout(
					"board",
					boardNode,
					[
						{
							layoutMode: null,
						},
						{
							layoutMode: "board",
						},
					],
					reached,
				),
				boardAsCell: canRenderLayout(
					"board",
					boardNode,
					[
						{
							layoutMode: null,
						},
						{
							layoutMode: "table",
						},
					],
					reached,
				),
				dashboardFlagOff: canRenderLayout(
					"table",
					table,
					[
						{
							layoutMode: "dashboard",
						},
					],
					reached,
				),
				dashboardFlagOn: canRenderLayout(
					"table",
					table,
					[
						{
							layoutMode: "dashboard",
						},
					],
					{
						reachedRoot: true,
						dashboardsFlag: true,
					},
				),
				simpleLayout: canRenderLayout(
					"h1",
					{
						layoutMode: "h1",
					},
					[
						{
							layoutMode: "board",
						},
					],
					reached,
				),
				wrongLayout: canRenderLayout("board", table, [], reached),
				outsideRoot: canRenderLayout(
					"table",
					table,
					[],
					{
						reachedRoot: false,
						dashboardsFlag: false,
					},
				),
			},
		).toStrictEqual(
			{
				zoomRoot: true,
				tableInBoard: false,
				boardInCard: false,
				boardAsCell: false,
				dashboardFlagOff: true,
				dashboardFlagOn: false,
				simpleLayout: true,
				wrongLayout: false,
				outsideRoot: false,
			},
		);
	});
});
