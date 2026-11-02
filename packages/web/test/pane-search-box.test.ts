// @vitest-environment happy-dom
import {afterEach, beforeEach, describe, expect, it} from "vite-plus/test";
import {act, createElement} from "react";
import {createRoot} from "react-dom/client";
import type {Root} from "react-dom/client";
import {PaneSearchBox} from "../src/client/components/pane-search-box.js";

declare global
{
	var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let root: Root | undefined;
let container: HTMLDivElement;
let commits: string[] = [];

beforeEach(() =>
{
	globalThis.IS_REACT_ACT_ENVIRONMENT = true;
	commits = [];
	container = document.createElement("div");
	document.body.append(container);
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

function mount(query: string): void
{
	root = createRoot(container);
	act(() =>
	{
		root?.render(
			createElement(
				PaneSearchBox,
				{
					query,
					compact: true,
					onCommit: (value: string) =>
					{
						commits.push(value);
					},
				},
			),
		);
	});
}

function input(): HTMLInputElement
{
	const element = container.querySelector("input");
	if (element === null)
	{
		throw new Error("no search input");
	}
	return element;
}

function label(): HTMLLabelElement
{
	const element = container.querySelector("label.searchBox");
	if (!(element instanceof HTMLLabelElement))
	{
		throw new TypeError("no search label");
	}
	return element;
}

function type(value: string): void
{
	act(() =>
	{
		const element = input();
		Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(element, value);
		input().dispatchEvent(
			new Event(
				"input",
				{
					bubbles: true,
				},
			),
		);
	});
}

function press(key: string): void
{
	act(() =>
	{
		input().dispatchEvent(
			new KeyboardEvent(
				"keydown",
				{
					key,
					bubbles: true,
				},
			),
		);
	});
}

describe("PaneSearchBox", () =>
{
	it("is upstream's compact 36px search circle while empty and unfocused", () =>
	{
		mount("");
		expect(
			{
				width: label().style.width,
				height: label().style.height,
				placeholder: input().placeholder,
				hidden: input().classList.contains("opacity-0"),
			},
		).toStrictEqual(
			{
				width: "36px",
				height: "36px",
				placeholder: "Search",
				hidden: true,
			},
		);
	});

	it("uses upstream's collapsed class order", () =>
	{
		mount("");
		expect(label().className).toBe(
			"relative shrink-0 max-w-[60vw] transition-[width] duration-300 ease-base hover:!bg-tertiary searchBox",
		);
	});

	it("opens into a pill on focus", () =>
	{
		mount("");
		const before = label();
		act(() =>
		{
			input().focus();
		});
		expect(
			{
				width: label().style.width,
				hidden: input().classList.contains("opacity-0"),
				sameLabel: label() === before,
				focused: document.activeElement === input(),
			},
		).toStrictEqual(
			{
				width: "210px",
				hidden: false,
				sameLabel: true,
				focused: true,
			},
		);
	});

	it("commits the typed query on Enter", () =>
	{
		mount("");
		act(() =>
		{
			input().focus();
		});
		type("#todo");
		press("Enter");
		expect(commits).toStrictEqual(["#todo"]);
	});

	it("shows the pane's committed query as an open pill", () =>
	{
		mount("#todo");
		expect(
			{
				value: input().value,
				width: label().style.width,
			},
		).toStrictEqual(
			{
				value: "#todo",
				width: "210px",
			},
		);
	});

	it("clears the pane search from its clear control", () =>
	{
		mount("#todo");
		act(() =>
		{
			container.querySelector("svg.cursor-pointer")?.dispatchEvent(
				new MouseEvent(
					"click",
					{
						bubbles: true,
					},
				),
			);
		});
		expect(
			{
				commits,
				value: input().value,
			},
		).toStrictEqual(
			{
				commits: [""],
				value: "",
			},
		);
	});

	it("clears the pane search and leaves the box on Escape", () =>
	{
		mount("#todo");
		act(() =>
		{
			input().focus();
		});
		press("Escape");
		expect(
			{
				commits,
				value: input().value,
				focused: document.activeElement === input(),
			},
		).toStrictEqual(
			{
				commits: [""],
				value: "",
				focused: false,
			},
		);
	});
});
