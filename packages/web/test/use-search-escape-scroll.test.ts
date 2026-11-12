// @vitest-environment happy-dom
import {afterEach, beforeAll, describe, expect, it, vi} from "vite-plus/test";
import type {Root} from "react-dom/client";

declare global
{
	// React reads this to know act() wraps every update.
	var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

vi.mock("../src/client/hooks/use-stable-navigate.js", () => (
{
	useStableNavigate: () => () =>
	{
	},
}));

const {act, createElement} = await import("react");
const {createRoot} = await import("react-dom/client");
const {QueryClient, QueryClientProvider} = await import("@tanstack/react-query");
const {useSearchEscape} = await import("../src/client/hooks/use-search-escape.js");

let root: Root | undefined;

beforeAll(() =>
{
	globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() =>
{
	act(() =>
	{
		root?.unmount();
	});
	root = undefined;
	document.body.innerHTML = "";
	globalThis.scrollTo(0, 0);
});

function Harness(): null
{
	useSearchEscape();
	return null;
}

function mount(): void
{
	const container = document.createElement("div");
	document.body.append(container);
	const input = document.createElement("input");
	input.id = "srch-input";
	document.body.append(input);
	root = createRoot(container);
	act(() =>
	{
		root?.render(
			createElement(
				QueryClientProvider,
				{
					client: new QueryClient(),
				},
				createElement(Harness),
			),
		);
	});
}

function pressEscape(): void
{
	act(() =>
	{
		globalThis.dispatchEvent(
			new KeyboardEvent(
				"keydown",
				{
					key: "Escape",
					cancelable: true,
				},
			),
		);
	});
}

describe("Escape to search and back", () =>
{
	it("restores the main pane's own scroller when panes are open", () =>
	{
		document.body.innerHTML =
			'<div data-pane-id="main"><div class="vertical-scrollable-container" style="height:100px;overflow:auto"><div style="height:5000px"></div></div></div>';
		const scroller = document.querySelector<HTMLElement>(".vertical-scrollable-container");
		mount();
		if (scroller === null)
		{
			throw new Error("no scroller");
		}
		scroller.scrollTop = 640;

		pressEscape();
		expect(document.activeElement?.id).toBe("srch-input");
		scroller.scrollTop = 0;
		pressEscape();

		expect(
			{
				scrollerTop: scroller.scrollTop,
				windowY: globalThis.scrollY,
			},
		).toStrictEqual(
			{
				scrollerTop: 640,
				windowY: 0,
			},
		);
	});

	it("restores the window scroll when no pane is open", () =>
	{
		mount();
		globalThis.scrollTo(0, 420);

		pressEscape();
		expect(document.activeElement?.id).toBe("srch-input");
		globalThis.scrollTo(0, 0);
		pressEscape();

		expect(globalThis.scrollY).toBe(420);
	});

	it("focuses search when Escape comes from a focused element inside a ButtonMenu trigger", () =>
	{
		mount();
		const menu = document.createElement("div");
		menu.className = "relative outline-none menu";
		const inner = document.createElement("button");
		menu.append(inner);
		document.body.append(menu);
		inner.focus();

		act(() =>
		{
			inner.dispatchEvent(
				new KeyboardEvent(
					"keydown",
					{
						key: "Escape",
						cancelable: true,
						bubbles: true,
					},
				),
			);
		});

		expect(document.activeElement?.id).toBe("srch-input");
	});
});
