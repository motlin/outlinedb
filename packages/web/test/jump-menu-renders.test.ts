// @vitest-environment happy-dom
import {afterAll, beforeAll, describe, expect, it, vi} from "vite-plus/test";
import type {Root} from "react-dom/client";
import {renders} from "./helpers/render-counter.js";
import type {SwitcherResult} from "../src/server/switcher-search.js";

declare global
{
	// React reads this to know act() wraps every update.
	var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const {act, createElement} = await import("react");
const {createRoot} = await import("react-dom/client");
const {QueryClient, QueryClientProvider} = await import("@tanstack/react-query");
const {MemoryRouter} = await import("react-router-dom");
const {JumpMenu, SwitcherDialog} = await import("../src/client/components/jump-menu.js");
const {emitSwitcherStep} = await import("../src/client/switcher-keys.js");
const {useOutlineStore} = await import("../src/client/stores/outline.js");

/** Twenty matches, answered as fresh JSON for every query like the server does. */
const results: SwitcherResult[] = Array.from(
	{
		length: 20,
	},
	(_, index) => (
	{
		id: `alice-${index}`,
		labelHtml: `Alice ${index}`,
		completed: false,
		starred: false,
		ancestors: [
			{
				id: "bob",
				name: "Bob",
			},
		],
	}),
);

const queryClient = new QueryClient(
	{
		defaultOptions:
		{
			queries:
			{
				retry: false,
				staleTime: Number.POSITIVE_INFINITY,
			},
		},
	},
);
let root: Root | undefined;

async function settle(): Promise<void>
{
	await act(async () =>
	{
		await new Promise((resolve) =>
		{
			setTimeout(resolve, 250);
		});
	});
}

function input(): HTMLInputElement
{
	const element = document.querySelector("input");
	if (!(element instanceof HTMLInputElement))
	{
		throw new TypeError("no switcher input");
	}
	return element;
}

function type(value: string): void
{
	act(() =>
	{
		const element = input();
		Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(element, value);
		element.dispatchEvent(
			new Event(
				"input",
				{
					bubbles: true,
				},
			),
		);
	});
}

beforeAll(async () =>
{
	globalThis.IS_REACT_ACT_ENVIRONMENT = true;
	vi.stubGlobal(
		"fetch",
		vi.fn<typeof fetch>(async (request) =>
		{
			const url = typeof request === "string" ? request : request instanceof URL ? request.href : request.url;
			return Promise.resolve(
				url.includes("/api/search/switcher")
					? Response.json(
							{
								results,
								hasMore: false,
							},
						)
					: Response.json(
							{},
							{
								status: 404,
							},
						),
			);
		}),
	);
	useOutlineStore.setState(
		{
			jumpMenuOpen: true,
		},
	);
	const container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	act(() =>
	{
		root?.render(
			createElement(
				QueryClientProvider,
				{
					client: queryClient,
				},
				createElement(MemoryRouter, null, createElement(JumpMenu)),
			),
		);
	});
	type("a");
	await settle();
});

afterAll(() =>
{
	act(() =>
	{
		root?.unmount();
	});
	vi.unstubAllGlobals();
});

describe("JumpMenu render count", () =>
{
	it("lists the server's matches", () =>
	{
		expect(document.querySelectorAll(".switcher-option")).toHaveLength(20);
	});

	it("does not re-render unchanged options when a keystroke brings back the same matches", async () =>
	{
		renders.clear();
		type("al");
		await settle();
		expect(renders.get("SwitcherOption") ?? 0).toBe(0);
	});

	it("scrolls a newly selected row into view with block nearest", async () =>
	{
		const scrollIntoView = vi.fn<(options?: ScrollIntoViewOptions) => void>();
		const original: unknown = Reflect.get(Element.prototype, "scrollIntoView");
		Element.prototype.scrollIntoView = function scroll(this: Element, options?: ScrollIntoViewOptions)
		{
			scrollIntoView.call(this, options);
		};
		try
		{
			act(() =>
			{
				emitSwitcherStep("next");
			});
			await settle();
			expect(scrollIntoView.mock.calls).toStrictEqual([
				[
					{
						block: "nearest",
					},
				],
			]);
			expect(scrollIntoView.mock.contexts).toStrictEqual([document.querySelectorAll(".switcher-option")[1]]);
		}
		finally
		{
			Reflect.set(Element.prototype, "scrollIntoView", original);
		}
	});

	it("re-renders only the two options the selection moves between", async () =>
	{
		renders.clear();
		act(() =>
		{
			emitSwitcherStep("next");
		});
		await settle();
		expect(renders.get("SwitcherOption") ?? 0).toBe(2);
	});

	it("does not re-render the options below a row that drops out of the list", () =>
	{
		const rows = results.map((result) => (
		{
			...result,
			key: result.id,
			nodeId: result.id,
			query: null,
			search: null,
		}));
		const noop = () =>
		{
		};
		const dialog = (shown: typeof rows) =>
			createElement(
				SwitcherDialog,
				{
					query: "",
					rows: shown,
					selectedIndex: 0,
					emptyText: null,
					indexing: false,
					onQueryChange: noop,
					onKeyDown: noop,
					onSelect: noop,
					onOpenInPane: noop,
					onHover: noop,
					onClose: noop,
					onScrollNearEnd: noop,
				},
			);
		const dialogRoot = createRoot(document.createElement("div"));
		act(() =>
		{
			dialogRoot.render(dialog(rows));
		});
		renders.clear();
		act(() =>
		{
			dialogRoot.render(
				dialog(
					rows.slice(1).map((row) => (
					{
						...row,
					})),
				),
			);
		});
		act(() =>
		{
			dialogRoot.unmount();
		});
		// Only the new first row, which takes the selection.
		expect(renders.get("SwitcherOption") ?? 0).toBe(1);
	});
});
