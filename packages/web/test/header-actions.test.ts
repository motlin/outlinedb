import {describe, expect, it, vi} from "vite-plus/test";
import {createElement} from "react";
import type {ReactElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import type {HeaderActions} from "../src/client/components/header-actions.js";

const starState =
{
	keys: [] as string[],
	unavailable: false,
};
const toggleStar = vi.fn<(loc: {nodeId: string | null; query: string | null}) => Promise<boolean>>(async () =>
	Promise.resolve(true),
);

vi.mock("../src/client/hooks/use-starred.js", () => (
{
	useStarActions: () => (
	{
		toggleStar,
	}),
	useStars: () => (
	{
		stars: starState.keys.map((key) => (
		{
			key,
		})),
		unavailable: starState.unavailable,
	}),
}));
vi.mock("../src/client/stores/outline.js", () => (
{
	useOutlineStore: (selector: (state: Record<string, unknown>) => unknown) =>
		selector(
			{
				showCompleted: false,
				searchQuery: "",
				openPresentation: () =>
				{
				},
				showItemTypePicker: () =>
				{
				},
			},
		),
}));
vi.mock("../src/client/hooks/use-nodes.js", () => (
{
	useChildren: () => (
	{
		data: [],
	}),
	useHome: () => (
	{
		data: undefined,
	}),
	useNode: () => (
	{
		data: undefined,
	}),
}));
vi.mock("../src/client/hooks/use-show-completed-toggle.js", () => (
{
	useShowCompletedToggle: () => () =>
	{
	},
}));

const {compactHeaderItems, useHeaderActions} = await import("../src/client/components/header-actions.js");

function actionsFor(zoomedId: string | null, query: string | null): HeaderActions
{
	const captured:
	{
		actions?: HeaderActions;
	} = {};
	renderToStaticMarkup(
		createElement(() =>
		{
			captured.actions = useHeaderActions(zoomedId, query);
			return null;
		}),
	);
	return captured.actions!;
}

function starRow(zoomedId: string | null, query: string | null)
{
	const actions = actionsFor(zoomedId, query);
	const row = compactHeaderItems(actions, zoomedId, undefined, query).find(
		(item) => item.label === "Star" || item.label === "Unstar",
	);
	return {
		actions,
		row,
	};
}

describe("the compact more-menu Star entry", () =>
{
	it("is a light star with a fixed width and the starring handbook when unstarred", () =>
	{
		starState.keys = [];
		const {row} = starRow("S", null);
		expect(
			{
				label: row?.label,
				handbook: row?.handbook,
				icon: renderToStaticMarkup(row?.icon as ReactElement).match(
					/data-prefix="fal" data-icon="star" class="[^"]*"/u,
				)?.[0],
			},
		).toStrictEqual(
			{
				label: "Star",
				handbook: "starring.star",
				icon: 'data-prefix="fal" data-icon="star" class="svg-inline--fa fa-star fa-fw fa-1x "',
			},
		);
	});

	it("is a solid spark-colored star without a fixed width when starred", () =>
	{
		starState.keys = ["S"];
		const {row} = starRow("S", null);
		const markup = renderToStaticMarkup(row?.icon as ReactElement);
		expect(
			{
				label: row?.label,
				markup: markup.includes('data-prefix="fas" data-icon="star" class="svg-inline--fa fa-star fa-1x "'),
				spark: markup.includes('style="color:var(--wf-text-spark)"'),
			},
		).toStrictEqual(
			{
				label: "Unstar",
				markup: true,
				spark: true,
			},
		);
	});

	it("is absent at Home without a search, and stars the pane's search at Home with one", () =>
	{
		starState.keys = [];
		toggleStar.mockClear();
		const home = starRow(null, null);
		const searched = starRow(null, "#x");
		searched.actions.toggleStar();
		expect(
			{
				homeRow: home.row,
				searchedRow: searched.row?.label,
				calls: toggleStar.mock.calls,
			},
		).toStrictEqual(
			{
				homeRow: undefined,
				searchedRow: "Star",
				calls: [
					[
						{
							nodeId: null,
							query: "#x",
						},
					],
				],
			},
		);
	});

	it("toggles the page plus the pane's query", () =>
	{
		starState.keys = [];
		toggleStar.mockClear();
		actionsFor("S", "zzq").toggleStar();
		expect(toggleStar.mock.calls).toStrictEqual([
			[
				{
					nodeId: "S",
					query: "zzq",
				},
			],
		]);
	});
});
