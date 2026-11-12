// @vitest-environment happy-dom
import {afterEach, beforeAll, beforeEach, describe, expect, it, vi} from "vite-plus/test";
import type {Root} from "react-dom/client";

declare global
{
	var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

vi.mock("../src/client/stores/outline.js", () => (
{
	useOutlineStore: () =>
	{
	},
}));
vi.mock("../src/client/hooks/use-global-keymap.js", () => (
{
	activeCommandRegistry: () => ({}),
}));
vi.mock("../src/client/keys/dispatch.js", () => (
{
	hotkeyTable: () => new Map(),
}));

const {act, createElement} = await import("react");
const {createRoot} = await import("react-dom/client");
const {CommandPalette} = await import("../src/client/components/command-palette.js");
const {PALETTE_ORDER} = await import("../src/client/keys/palette-order.js");

let root: Root | undefined;
let host: HTMLElement | undefined;
const NA = "Not available in the current context";

beforeAll(() =>
{
	globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() =>
{
	vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 0);
	vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
});

afterEach(() =>
{
	vi.restoreAllMocks();
	act(() =>
	{
		root?.unmount();
	});
	host?.remove();
});

const entries = PALETTE_ORDER.map((key) => (
{
	key,
	disabled: key === "swap_mirror_origin" || key === "detach_mirror" ? NA : null,
}));

function mount(
	props:
	{
		itemCount?: number;
	} = {},
)
{
	const onExecute = vi.fn<(key: string) => void>();
	const onClose = vi.fn<() => void>();
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	act(() =>
	{
		root?.render(
			createElement(
				CommandPalette,
				{
					entries,
					hotkeys:
					{
						select_all: "meta+a",
					},
					itemCount: props.itemCount ?? 1,
					onExecute,
					onClose,
				},
			),
		);
	});
	return {
		onExecute,
		onClose,
	};
}

function input(): HTMLInputElement
{
	const found = document.querySelector("input");
	if (!found)
	{
		throw new Error("no input");
	}
	return found;
}

function type(value: string)
{
	act(() =>
	{
		// oxlint-disable-next-line typescript/unbound-method -- React tracks the native value setter
		const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
		setter?.call(input(), value);
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

function press(key: string, target: EventTarget = input())
{
	act(() =>
	{
		target.dispatchEvent(
			new KeyboardEvent(
				"keydown",
				{
					key,
					bubbles: true,
					cancelable: true,
				},
			),
		);
	});
}

function rows(): HTMLElement[]
{
	return [...document.querySelectorAll<HTMLElement>("div[aria-disabled]")];
}

function footer(): string
{
	return document.querySelector(".bg-secondary.px-m")?.textContent ?? "";
}

describe("CommandPalette", () =>
{
	it("renders the upstream box, rows, chip and footer", () =>
	{
		mount();
		expect(document.querySelector(".wf-dialog")?.className).not.toContain("transition-[transform,opacity]");
		expect(document.activeElement).toBe(input());
		expect(rows()).toHaveLength(192);
		expect(rows()[0]?.classList.contains("bg-secondary")).toBe(true);
		expect(rows()[1]?.classList.contains("falsebg-secondary")).toBe(true);
		expect(rows()[0]?.querySelector("div:nth-child(2)")?.textContent).toBe("meta+a");
		const disabled = rows().find((row) => row.textContent === "swap_mirror_origin");
		expect(
			{
				title: disabled?.title,
				aria: disabled?.getAttribute("aria-disabled"),
			},
		).toStrictEqual(
			{
				title: NA,
				aria: "true",
			},
		);
		expect(footer()).toBe("1 node selected192 / 192Labs");
	});

	it("filters, keeps disabled rows, and ignores Enter on a disabled row", () =>
	{
		const {onExecute} = mount();
		type("mirror");
		expect(rows()).toHaveLength(10);
		expect(footer()).toContain("10 / 192");
		for (let i = 0; i < 7; i++)
		{
			press("ArrowDown");
		}
		press("Enter");
		expect(onExecute).not.toHaveBeenCalled();
		press("ArrowUp");
		press("ArrowUp");
		press("ArrowUp");
		press("ArrowUp");
		press("ArrowUp");
		press("ArrowUp");
		press("ArrowUp");
		press("ArrowDown");
		press("ArrowDown");
		press("Enter");
		expect(onExecute.mock.calls).toStrictEqual([["mirror_to_child"]]);
	});

	it("does nothing on click, empties on no match, and keeps keys off the window and closes on Escape", () =>
	{
		const {onExecute, onClose} = mount();
		act(() =>
		{
			rows()[0]?.click();
		});
		const seen: string[] = [];
		const spy = (event: KeyboardEvent) =>
		{
			seen.push(event.key);
		};
		window.addEventListener("keydown", spy);
		press("w");
		press("ArrowDown");
		press("Escape");
		window.removeEventListener("keydown", spy);
		expect(seen).toStrictEqual([]);
		expect(onClose).toHaveBeenCalledOnce();
		type("qqq");
		expect(
			{
				rows: rows().length,
				footer: footer(),
			},
		).toStrictEqual(
			{
				rows: 0,
				footer: "1 node selected0 / 192Labs",
			},
		);
		press("Enter");
		expect(onExecute).not.toHaveBeenCalled();
	});
});
