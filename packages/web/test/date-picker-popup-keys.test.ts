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
const {DatePickerPopup} = await import("../src/client/components/date-picker-popup.js");
const {calendarPickerSettingsRows} = await import("../src/client/components/calendar-picker-settings.js");

let root: Root | undefined;
let host: HTMLElement | undefined;

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
	host?.remove();
});

async function mount(props: Record<string, unknown> = {}): Promise<void>
{
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () =>
	{
		root?.render(
			createElement(
				DatePickerPopup,
				{
					selected: [new Date(2026, 9, 15)],
					...props,
				},
			),
		);
		await Promise.resolve();
	});
}

async function press(key: string, target: EventTarget = window): Promise<void>
{
	await act(async () =>
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
		await Promise.resolve();
	});
}

function activeRows(): string[]
{
	return [...document.querySelectorAll(".menuItem.active")].map((row) => row.textContent);
}

describe("DatePickerPopup keyboard mode", () =>
{
	it("renders preset rows without hover classes", async () =>
	{
		await mount();
		const today = [...document.querySelectorAll(".menuItem")].find((row) => row.textContent === "Today");
		const tokens = (today?.className ?? "").split(/\s+/u);
		expect(
			{
				menuItem: tokens.includes("menuItem"),
				hover: tokens.includes("hover:bg-secondary"),
				canHover: tokens.includes("canHover"),
			},
		).toStrictEqual(
			{
				menuItem: true,
				hover: false,
				canHover: false,
			},
		);
	});

	it("walks Today, Tomorrow, Next week with ArrowDown, then focuses the month header", async () =>
	{
		await mount();
		document.querySelector<HTMLInputElement>("input")?.focus();
		const seen: string[][] = [];
		for (let i = 0; i < 3; i++)
		{
			await press("ArrowDown");
			seen.push(activeRows());
		}
		await press("ArrowDown");
		expect(
			{
				seen,
				focused: document.activeElement?.hasAttribute("data-date-picker-header-button"),
				text: document.activeElement?.textContent,
			},
		).toStrictEqual(
			{
				seen: [["Today"], ["Tomorrow"], ["Next week"]],
				focused: true,
				text: "Oct",
			},
		);
	});

	it("selects the active preset with Enter exactly once", async () =>
	{
		const onPreset = vi.fn<(...args: never[]) => void>();
		await mount(
			{
				onPreset,
			},
		);
		document.querySelector<HTMLInputElement>("input")?.focus();
		await press("ArrowDown");
		await press("ArrowDown");
		await press("Enter");
		expect(onPreset.mock.calls).toStrictEqual([["tomorrow"]]);
	});

	it("reaches the strip picker settings rows with ArrowUp from the input", async () =>
	{
		const onToggle = vi.fn<(key: "foundDates" | "dayPrefix") => void>();
		const onLayout = vi.fn<() => void>();
		await mount(
			{
				showControls: false,
				afterCalendar: calendarPickerSettingsRows(
					{
						foundDates: true,
						dayPrefix: true,
					},
					onToggle,
					onLayout,
				),
			},
		);
		document.querySelector<HTMLInputElement>("input")?.focus();
		const seen: string[][] = [];
		for (let i = 0; i < 3; i++)
		{
			await press("ArrowUp");
			seen.push(activeRows());
		}
		await press("Enter");
		expect(
			{
				seen,
				toggles: onToggle.mock.calls,
				layouts: onLayout.mock.calls.length,
			},
		).toStrictEqual(
			{
				seen: [
					["Calendar Layout"],
					["Friendly day namesYesterday, Today, Tomorrow"],
					["Found DatesShows all matching dates"],
				],
				toggles: [["foundDates"]],
				layouts: 0,
			},
		);
	});

	it("clicks a focused day button on Enter instead of closing", async () =>
	{
		const onApply = vi.fn<(...args: never[]) => void>();
		const onClose = vi.fn<(...args: never[]) => void>();
		await mount(
			{
				onApply,
				onClose,
			},
		);
		const first = document.querySelector<HTMLElement>('[data-date-picker-day-button="true"]');
		first?.focus();
		await press("Enter", first ?? window);
		expect(
			{
				applied: onApply.mock.calls,
				closed: onClose.mock.calls.length,
			},
		).toStrictEqual(
			{
				applied: [[[new Date(2026, 8, 27)]]],
				closed: 0,
			},
		);
	});

	it("opens the month view when Enter is pressed on the month header", async () =>
	{
		await mount();
		const header = document.querySelector<HTMLElement>('[data-date-picker-header-button="true"]');
		header?.focus();
		await press("Enter", header ?? window);
		const months = [...document.querySelectorAll('[data-date-picker-grid-button="true"]')].map(
			(button) => button.textContent,
		);
		expect(months).toStrictEqual([
			"Jan",
			"Feb",
			"Mar",
			"Apr",
			"May",
			"Jun",
			"Jul",
			"Aug",
			"Sep",
			"Oct",
			"Nov",
			"Dec",
		]);
	});

	it("does not register Escape while the body is replaced", async () =>
	{
		const onEscape = vi.fn<(...args: never[]) => void>();
		await mount(
			{
				onEscape,
				content: createElement("div"),
			},
		);
		await press("Escape");
		expect(onEscape.mock.calls).toHaveLength(0);
	});

	it("registers Escape with the normal body", async () =>
	{
		const onEscape = vi.fn<(...args: never[]) => void>();
		await mount(
			{
				onEscape,
			},
		);
		await press("Escape");
		expect(onEscape.mock.calls).toHaveLength(1);
	});
});
