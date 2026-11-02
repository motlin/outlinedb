// @vitest-environment happy-dom
import {afterEach, beforeEach, describe, expect, it, vi} from "vite-plus/test";
import {act, createElement} from "react";
import {createRoot} from "react-dom/client";
import type {Root} from "react-dom/client";

vi.mock("react-router-dom", () => (
{
	useNavigate: () => () =>
	{
	},
}));
vi.mock("@tanstack/react-query", () => (
{
	useQueryClient: () => (
	{
		invalidateQueries: async () => Promise.resolve(),
	}),
	useQuery: () => (
	{
		data: undefined,
	}),
}));
vi.mock("../src/client/hooks/use-breakpoint.js", () => (
{
	useBreakpoint: () => false,
}));

const {SearchBox} = await import("../src/client/components/search-box.js");
const {useOutlineStore} = await import("../src/client/stores/outline.js");

declare global
{
	var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let root: Root | undefined;
let container: HTMLDivElement;

beforeEach(() =>
{
	globalThis.IS_REACT_ACT_ENVIRONMENT = true;
	useOutlineStore.setState(
		{
			searchFocused: false,
			searchInput: "",
		},
	);
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	act(() =>
	{
		root?.render(createElement(SearchBox));
	});
});

afterEach(() =>
{
	act(() =>
	{
		root?.unmount();
	});
	root = undefined;
	container.remove();
});

function label(): HTMLLabelElement
{
	const element = container.querySelector("label.searchBox");
	if (!(element instanceof HTMLLabelElement))
	{
		throw new TypeError("no search label");
	}
	return element;
}

function input(): HTMLInputElement
{
	const element = container.querySelector("#srch-input");
	if (!(element instanceof HTMLInputElement))
	{
		throw new TypeError("no search input");
	}
	return element;
}

describe("compact SearchBox focus", () =>
{
	it("keeps the same label and focus when the input is focused", () =>
	{
		const before = label();
		act(() =>
		{
			input().focus();
		});
		expect(
			{
				sameLabel: label() === before,
				focused: document.activeElement === input(),
				width: label().style.width,
			},
		).toStrictEqual(
			{
				sameLabel: true,
				focused: true,
				width: "320px",
			},
		);
	});

	it("keeps focus when the store flips searchFocused in the same tick as focus (Escape path)", () =>
	{
		const before = label();
		act(() =>
		{
			useOutlineStore.setState(
				{
					searchFocused: true,
				},
			);
			input().focus();
		});
		expect(
			{
				sameLabel: label() === before,
				focused: document.activeElement === input(),
				width: label().style.width,
			},
		).toStrictEqual(
			{
				sameLabel: true,
				focused: true,
				width: "320px",
			},
		);
	});

	it("uses upstream's collapsed class order", () =>
	{
		expect(label().className).toBe(
			"relative shrink-0 max-w-[60vw] transition-[width] duration-300 ease-base hover:!bg-tertiary searchBox",
		);
	});
});
