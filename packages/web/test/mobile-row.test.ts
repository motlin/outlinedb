// @vitest-environment happy-dom
import type * as IsMobileModule from "../src/client/is-mobile.js";
import {afterEach, beforeEach, describe, expect, it, vi} from "vite-plus/test";
import type {Root} from "react-dom/client";
import type {NodeResponse} from "../src/node-types.js";

declare global
{
	// React reads this to know act() wraps every update.
	var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const device = vi.hoisted(() => (
{
	mobile: true,
}));
vi.mock("../src/client/is-mobile.js", async (importOriginal) =>
{
	const original = await importOriginal<typeof IsMobileModule>();
	return {
		...original,
		get IS_MOBILE()
		{
			return device.mobile;
		},
	};
});

const {act, createElement} = await import("react");
const {createRoot} = await import("react-dom/client");
const {QueryClient, QueryClientProvider} = await import("@tanstack/react-query");
const {MemoryRouter} = await import("react-router-dom");
const {OutlineRow} = await import("../src/client/components/outline-node.js");
const {useOutlineStore} = await import("../src/client/stores/outline.js");
const {resetFontSizeForTests, setFontSize} = await import("../src/client/mobile-font-size.js");

function row(hasChildren: boolean): NodeResponse
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
	localStorage.clear();
	resetFontSizeForTests();
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
	device.mobile = true;
	vi.unstubAllGlobals();
});

function mount(node: NodeResponse): HTMLElement
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
	return host;
}

describe("phone row geometry", () =>
{
	it("sets the name variables, a 26px div bullet and a right-aligned scaled arrow at the default size", () =>
	{
		const host = mount(row(true));
		const nameElement = host.querySelector<HTMLElement>(".name");
		const bullet = host.querySelector<HTMLElement>(".bullet");
		const arrow = host.querySelector<HTMLElement>("button.expand");
		expect(
			{
				nameStyle: nameElement?.getAttribute("style"),
				bulletTag: bullet?.tagName,
				bulletHref: bullet?.getAttribute("href"),
				bulletStyle: bullet?.getAttribute("style"),
				arrowStyle: arrow?.getAttribute("style"),
				arrowClasses: arrow?.className
					.split(" ")
					.filter((cls) => /^(w-\[|max-\[600px\]|min-\[600px\])/u.test(cls)),
				arrowWrapper: arrow?.querySelector("div")?.getAttribute("style"),
			},
		).toStrictEqual(
			{
				nameStyle: "--name-padding-left: 30px; --name-font-size: 19px;",
				bulletTag: "DIV",
				bulletHref: null,
				bulletStyle: "left: -2px; width: 26px; opacity: 0.5; --bullet-size: 26px;",
				arrowStyle: "color: var(--wf-text-tertiary);",
				arrowClasses: [
					"w-[30px]",
					"max-[600px]:-right-xl",
					"max-[600px]:left-[unset]",
					"max-[600px]:opacity-50",
					"min-[600px]:-left-2xl",
				],
				arrowWrapper: "transform: scale(1.2);",
			},
		);
	});

	it("follows the font size setting", () =>
	{
		setFontSize(28);
		const host = mount(row(false));
		expect(
			{
				nameStyle: host.querySelector(".name")?.getAttribute("style"),
				bulletStyle: host.querySelector(".bullet")?.getAttribute("style"),
			},
		).toStrictEqual(
			{
				nameStyle: `--name-padding-left: ${48 / 1.3}px; --name-font-size: 28px;`,
				bulletStyle: "left: -8px; width: 39px; opacity: 0.5; --bullet-size: 39px;",
			},
		);
	});

	it("leaves the desktop markup alone", () =>
	{
		device.mobile = false;
		const host = mount(row(true));
		const bullet = host.querySelector<HTMLElement>(".bullet");
		expect(
			{
				nameStyle: host.querySelector(".name")?.getAttribute("style"),
				bulletTag: bullet?.tagName,
				bulletStyle: bullet?.getAttribute("style"),
			},
		).toStrictEqual(
			{
				nameStyle: null,
				bulletTag: "A",
				bulletStyle: "left: calc(var(--name-left-overhang) + 1px); width: 18px; --bullet-size: 18px;",
			},
		);
	});
});
