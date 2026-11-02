// @vitest-environment happy-dom
import {afterEach, beforeAll, describe, expect, it, vi} from "vite-plus/test";
import type {Root} from "react-dom/client";

declare global
{
	// React reads this to know act() wraps every update.
	var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const {act, createElement} = await import("react");
const {createRoot} = await import("react-dom/client");
const {Dropdown, DropdownOption} = await import("../src/client/components/flyout/dropdown.js");

let root: Root | undefined;

/** Runs `change` inside act and lets React flush it. */
async function run(change: () => void): Promise<void>
{
	await act(async () =>
	{
		change();
		await Promise.resolve();
	});
}
let host: HTMLElement | undefined;

beforeAll(() =>
{
	globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () =>
{
	await run(() =>
	{
		root?.unmount();
	});
	host?.remove();
	vi.useRealTimers();
});

async function render(element: ReturnType<typeof createElement>): Promise<void>
{
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await run(() =>
	{
		root?.render(element);
	});
}

function collapse(value: string): string
{
	return value.replaceAll(/\s+/gu, " ").trim();
}

function wrapper(): HTMLElement
{
	const found = document.querySelector<HTMLElement>(".menu[tabindex]");
	if (!found)
	{
		throw new Error("no menu wrapper");
	}
	return found;
}

function trigger(): HTMLElement
{
	return wrapper().firstElementChild as HTMLElement;
}

function triggerBox():
{
	padding: string;
	borderRadius: string;
}
{
	const {style} = trigger();
	return {
		padding: style.padding,
		borderRadius: style.borderRadius,
	};
}

const JUMP_OPTIONS = [
	createElement(
		DropdownOption,
		{
			key: "jump",
			label: "Jump to",
			disabled: true,
			isSelected: true,
			className: "!cursor-default",
		},
	),
	createElement(
		DropdownOption,
		{
			key: "account",
			label: "Account",
		},
	),
];

const DISABLED_ROW =
	"pl-l py-xs pr-l block !no-underline cursor-pointer whitespace-nowrap leading-base border-solid border-primary text-tertiary mobile:border-t mobile:last:border-b mobile:py-ml mobile:landscape:pl-safe-left mobile:landscape:pr-safe-right menuItem !cursor-default";
const ENABLED_ROW =
	"pl-l py-xs pr-l block !no-underline cursor-pointer whitespace-nowrap leading-base border-solid border-primary text-primary hover:bg-secondary mobile:border-t mobile:last:border-b mobile:py-ml mobile:landscape:pl-safe-left mobile:landscape:pr-safe-right menuItem menuItem canHover";

async function open(): Promise<void>
{
	await run(() =>
	{
		wrapper().focus();
	});
}

describe("Dropdown", () =>
{
	it("labels the trigger with the first selected child", async () =>
	{
		await render(createElement(Dropdown, null, ...JUMP_OPTIONS));
		expect(trigger().textContent).toBe("Jump to");
	});

	it("has an empty label when nothing is selected", async () =>
	{
		await render(
			createElement(
				Dropdown,
				null,
				createElement(
					DropdownOption,
					{
						label: "Account",
					},
				),
			),
		);
		expect(trigger().textContent).toBe("");
	});

	it("replaces dropdown with a custom className", async () =>
	{
		await render(
			createElement(
				Dropdown,
				{
					className: "dropdownFont",
				},
				...JUMP_OPTIONS,
			),
		);
		expect(trigger().classList.contains("dropdownFont")).toBe(true);
		expect(trigger().classList.contains("dropdown")).toBe(false);
	});

	it("uses the small and large trigger padding", async () =>
	{
		await render(createElement(Dropdown, null, ...JUMP_OPTIONS));
		expect(triggerBox()).toStrictEqual(
			{
				padding: "3px 11px",
				borderRadius: "12px",
			},
		);
		await run(() =>
		{
			root?.render(
				createElement(
					Dropdown,
					{
						large: true,
					},
					...JUMP_OPTIONS,
				),
			);
		});
		expect(triggerBox()).toStrictEqual(
			{
				padding: "9px 17px",
				borderRadius: "18px",
			},
		);
	});

	it("renders the chevron after the label", async () =>
	{
		await render(createElement(Dropdown, null, ...JUMP_OPTIONS));
		expect(trigger().querySelector("svg")?.getAttribute("data-icon")).toBe("chevron-down");
	});

	it("opens a portaled flyout on focus with unmarked rows", async () =>
	{
		await render(createElement(Dropdown, null, ...JUMP_OPTIONS));
		expect(document.querySelector(".flyout")).toBeNull();
		await open();
		const flyouts = document.querySelectorAll("body > .flyout.menu");
		expect(flyouts).toHaveLength(1);
		const rows = [...flyouts[0].querySelectorAll("a")];
		expect(rows.map((row) => collapse(row.className))).toStrictEqual([DISABLED_ROW, ENABLED_ROW]);
	});

	it("selects an option, closes and leaves focus on body", async () =>
	{
		vi.useFakeTimers();
		const onSelect = vi.fn<() => void>();
		await render(
			createElement(
				Dropdown,
				null,
				createElement(
					DropdownOption,
					{
						label: "Account",
						onSelect,
					},
				),
				createElement(
					DropdownOption,
					{
						label: "Dates",
					},
				),
			),
		);
		await open();
		await run(() =>
		{
			vi.advanceTimersByTime(400);
		});
		const row = [...document.querySelectorAll<HTMLElement>(".flyout a")].find(
			(candidate) => candidate.textContent === "Account",
		);
		await run(() =>
		{
			row?.dispatchEvent(
				new MouseEvent(
					"mousedown",
					{
						bubbles: true,
						cancelable: true,
					},
				),
			);
			row?.click();
		});
		expect(onSelect).toHaveBeenCalledOnce();
		expect(document.querySelector(".flyout")).toBeNull();
		expect(document.activeElement).toBe(document.body);
	});

	it("caps the scroller at maxHeight", async () =>
	{
		await render(
			createElement(
				Dropdown,
				{
					maxHeight: 360,
				},
				...JUMP_OPTIONS,
			),
		);
		await open();
		expect(document.querySelector<HTMLElement>(".flyout .scroller")?.style.cssText).toBe("--menu-max-h: 360px;");
	});

	it("caps the scroller at the viewport without maxHeight", async () =>
	{
		await render(createElement(Dropdown, null, ...JUMP_OPTIONS));
		await open();
		expect(document.querySelector<HTMLElement>(".flyout .scroller")?.style.cssText).toBe(
			"--menu-max-h: calc(100vh - 50px);",
		);
	});
});
