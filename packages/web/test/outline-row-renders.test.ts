// @vitest-environment happy-dom
import {afterEach, beforeEach, describe, expect, it, vi} from "vite-plus/test";
import type {Root} from "react-dom/client";
import {renders} from "./helpers/render-counter.js";
import type {NodeResponse} from "../src/node-types.js";

declare global
{
	// React reads this to know act() wraps every update.
	var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const {act, createElement} = await import("react");
const {createRoot} = await import("react-dom/client");
const {QueryClient, QueryClientProvider} = await import("@tanstack/react-query");
const {MemoryRouter} = await import("react-router-dom");
const {OutlineRow} = await import("../src/client/components/outline-node.js");
const {useOutlineStore} = await import("../src/client/stores/outline.js");
const {nodeKeys} = await import("../src/client/node-cache.js");

function restingRow(hasChildren: boolean): NodeResponse
{
	return {
		id: "alice",
		parent_id: null,
		name: "Alice",
		note: null,
		priority: 0,
		data:
		{
			layoutMode: null,
		},
		completedAt: null,
		createdAt: 0,
		modifiedAt: 0,
		hasChildren,
		hasUncompletedChildren: hasChildren,
	};
}

let root: Root | undefined;

beforeEach(() =>
{
	globalThis.IS_REACT_ACT_ENVIRONMENT = true;
	useOutlineStore.setState(useOutlineStore.getInitialState(), true);
	vi.stubGlobal(
		"fetch",
		vi.fn<typeof fetch>(async () =>
			Promise.resolve(
				Response.json(
					{},
					{
						status: 404,
					},
				),
			),
		),
	);
});

afterEach(() =>
{
	act(() =>
	{
		root?.unmount();
	});
	root = undefined;
	vi.unstubAllGlobals();
});

/** The test's providers, which mount alongside the row. */
const PROVIDERS =
{
	QueryClientProvider: 1,
	MemoryRouter: 1,
	Router: 1,
};

/** Components rendered, by name, mounting one row. */
function mountRenders(node: NodeResponse): Record<string, number>
{
	const queryClient = new QueryClient(
		{
			defaultOptions:
			{
				queries:
				{
					retry: false,
				},
			},
		},
	);
	root = createRoot(document.createElement("div"));
	renders.clear();
	act(() =>
	{
		root?.render(
			createElement(
				QueryClientProvider,
				{
					client: queryClient,
				},
				createElement(
					MemoryRouter,
					null,
					createElement(
						OutlineRow,
						{
							node,
						},
					),
				),
			),
		);
	});
	return Object.fromEntries(renders);
}

describe("resting OutlineRow components", () =>
{
	it("mounts a resting leaf row as three components: the row, its name, and its resting text", () =>
	{
		expect(mountRenders(restingRow(false))).toStrictEqual(
			{
				...PROVIDERS,
				OutlineRow: 1,
				NodeName: 1,
				RestingText: 1,
			},
		);
	});

	it("mounts a resting collapsed parent row as the same three components", () =>
	{
		expect(mountRenders(restingRow(true))).toStrictEqual(
			{
				...PROVIDERS,
				OutlineRow: 1,
				NodeName: 1,
				RestingText: 1,
			},
		);
	});
});

describe("code block rows", () =>
{
	function nameHtml(node: NodeResponse): string
	{
		const host = document.createElement("div");
		root = createRoot(host);
		const queryClient = new QueryClient(
			{
				defaultOptions:
				{
					queries:
					{
						retry: false,
					},
				},
			},
		);
		act(() =>
		{
			root?.render(
				createElement(
					QueryClientProvider,
					{
						client: queryClient,
					},
					createElement(
						MemoryRouter,
						null,
						createElement(
							OutlineRow,
							{
								node,
							},
						),
					),
				),
			);
		});
		return host.querySelector(".name .content")?.innerHTML ?? "";
	}

	it("renders no tag pill or link in a code block, but still renders them in a bullet", () =>
	{
		const name = "x #tag https://example.com";
		const code = nameHtml(
			{
				...restingRow(false),
				name,
				data:
				{
					layoutMode: "code-block",
				},
			},
		);
		act(() =>
		{
			root?.unmount();
		});
		const bullet = nameHtml(
			{
				...restingRow(false),
				name,
			},
		);
		expect(
			{
				code: [code.includes("contentTag"), code.includes("contentLink")],
				bullet: [bullet.includes("contentTag"), bullet.includes("contentLink")],
			},
		).toStrictEqual(
			{
				code: [false, false],
				bullet: [true, true],
			},
		);
	});
});

describe("calendar day OutlineRow", () =>
{
	const PREFIX_CLASS =
		"flex h-[var(--line-height)] whitespace-nowrap items-center pr-m pt-[--wf-content-padding-top] pb-[--wf-content-padding-bottom]";

	beforeEach(() =>
	{
		vi.useFakeTimers(
			{
				toFake: ["Date"],
			},
		);
		vi.setSystemTime(new Date(2026, 9, 22, 10, 0));
	});
	afterEach(() =>
	{
		vi.useRealTimers();
	});

	function dayRow(dateId: number): NodeResponse
	{
		return {
			...restingRow(false),
			id: `d${dateId}`,
			parent_id: "m10",
			name: "day",
			calendar:
			{
				level: "day",
				dateId,
				root: false,
				foundDates: null,
				dayPrefix: null,
				restorableUniqueNode: false,
			},
		};
	}

	/** Mount `node` under a cached 📆 Calendar > 2026 > 10 chain whose root sets `dayPrefix`; its prefix span, components and ancestor requests. */
	function mountDay(
		node: NodeResponse,
		dayPrefix: boolean,
	):
	{
		html: string;
		components: Record<string, number>;
		ancestorRequests: string[];
	}
	{
		const queryClient = new QueryClient(
			{
				defaultOptions:
				{
					queries:
					{
						retry: false,
						staleTime: 60_000,
					},
				},
			},
		);
		const chainNode = (id: string, parent: string | null, calendar: NodeResponse["calendar"]): NodeResponse => (
		{
			...restingRow(true),
			id,
			parent_id: parent,
			calendar,
		});
		queryClient.setQueryData(nodeKeys.ancestors("m10"), [
			chainNode(
				"cal",
				null,
				{
					level: null,
					dateId: null,
					root: true,
					foundDates: true,
					dayPrefix,
					restorableUniqueNode: false,
				},
			),
			chainNode(
				"y2026",
				"cal",
				{
					level: "year",
					dateId: 20_260_000,
					root: false,
					foundDates: null,
					dayPrefix: null,
					restorableUniqueNode: false,
				},
			),
			chainNode(
				"m10",
				"y2026",
				{
					level: "month",
					dateId: 20_261_000,
					root: false,
					foundDates: null,
					dayPrefix: null,
					restorableUniqueNode: false,
				},
			),
		]);
		queryClient.setQueryData(nodeKeys.children("m10"), [node]);
		act(() =>
		{
			root?.unmount();
		});
		const container = document.createElement("div");
		root = createRoot(container);
		renders.clear();
		act(() =>
		{
			root?.render(
				createElement(
					QueryClientProvider,
					{
						client: queryClient,
					},
					createElement(
						MemoryRouter,
						null,
						createElement(
							OutlineRow,
							{
								node,
							},
						),
					),
				),
			);
		});
		const span = container.querySelector(`span[class="${PREFIX_CLASS}"]`);
		return {
			html: span?.outerHTML ?? "",
			components: Object.fromEntries(renders),
			ancestorRequests: vi
				.mocked(fetch)
				.mock.calls.map(([url]) => (url instanceof Request ? url.url : url.toString()))
				.filter((url) => url.includes("ancestors")),
		};
	}

	it("renders upstream's friendly day name before yesterday's, today's and tomorrow's date, mounting one prefix component and building its ancestors from the cache", () =>
	{
		expect([
			mountDay(dayRow(20_261_021), true),
			mountDay(dayRow(20_261_022), true),
			mountDay(dayRow(20_261_023), true),
		]).toStrictEqual(
			["Yesterday,", "Today,", "Tomorrow,"].map((prefix) => (
			{
				html: `<span class="${PREFIX_CLASS}">${prefix}</span>`,
				components:
				{
					...PROVIDERS,
					OutlineRow: 1,
					NodeName: 1,
					RestingText: 1,
					DayTitlePrefix: 1,
				},
				ancestorRequests: [],
			})),
		);
	});

	it("renders no prefix on other days or when the root turns Friendly day names off", () =>
	{
		expect([mountDay(dayRow(20_261_020), true).html, mountDay(dayRow(20_261_021), false).html]).toStrictEqual([
			"",
			"",
		]);
	});
});
