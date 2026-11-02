// @vitest-environment happy-dom
import {afterEach, beforeEach, describe, expect, it} from "vite-plus/test";
import type {Root} from "react-dom/client";

declare global
{
	// React reads this to know act() wraps every update.
	var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const {act, createElement} = await import("react");
const {createRoot} = await import("react-dom/client");
const {renderToStaticMarkup} = await import("react-dom/server");
const {MemoryRouter, useNavigate} = await import("react-router-dom");
const {MobileMenu} = await import("../src/client/components/mobile-menu.js");
const {MobileSheetHost} = await import("../src/client/components/mobile-sheet-host.js");
const {MoreMenuRows} = await import("../src/client/components/mobile-more-menu.js");
const {moreMenuLabels, moreMenuRows} = await import("../src/client/mobile-more-menu-model.js");
const {Sheet} = await import("../src/client/stores/sheet.js");
const {getFontSize, resetFontSizeForTests} = await import("../src/client/mobile-font-size.js");

const noop = () =>
{
};
const baseContext =
{
	zoomedId: "alice" as string | null,
	canUndo: true,
	canRedo: false,
	starred: false,
	starsAvailable: true,
	showCompleted: false,
	completedForced: false,
	canTurnInto: true,
	actions:
	{
		undo: noop,
		redo: noop,
		turnInto: noop,
		toggleStar: noop,
		share: noop,
		exportZoomed: noop,
		expandAll: noop,
		collapseAll: noop,
		deleteZoomed: noop,
		adjustTextSize: noop,
		toggleCompleted: noop,
		openSettings: noop,
	},
};

describe("moreMenuRows", () =>
{
	it("lists upstream's rows in order, with Trash left out (no trash view locally)", () =>
	{
		expect(moreMenuLabels(moreMenuRows(baseContext))).toStrictEqual([
			"Undo",
			"Redo",
			"-",
			"Turn into...",
			"-",
			"Add to Starred",
			"-",
			"Share",
			"Export",
			"-",
			"Expand all",
			"Collapse all",
			"-",
			"Delete",
			"-",
			"Adjust Text Size",
			"Show completed",
			"Settings",
			"-",
		]);
	});

	it("says Remove from Starred for a starred page and drops page-only rows at Home", () =>
	{
		expect(
			{
				starred: moreMenuLabels(
					moreMenuRows(
						{
							...baseContext,
							starred: true,
						},
					),
				).filter((label) => label.includes("Starred")),
				home: moreMenuLabels(
					moreMenuRows(
						{
							...baseContext,
							zoomedId: null,
						},
					),
				).filter((label) => ["Share", "Delete", "Add to Starred"].includes(label)),
			},
		).toStrictEqual(
			{
				starred: ["Remove from Starred"],
				home: [],
			},
		);
	});

	it("drops the Show completed toggle while a revealing search forces completed rows", () =>
	{
		expect(
			moreMenuLabels(
				moreMenuRows(
					{
						...baseContext,
						completedForced: true,
					},
				),
			),
		).not.toContain("Show completed");
	});
});

describe("MoreMenuRows markup", () =>
{
	it("renders action rows with upstream's classes and the Undo | Redo pair", () =>
	{
		const html = renderToStaticMarkup(
			createElement(
				MoreMenuRows,
				{
					rows: moreMenuRows(baseContext),
				},
			),
		);
		const host = document.createElement("div");
		host.innerHTML = html;
		const items = [...host.querySelectorAll(".cursor-pointer.px-l")];
		expect(
			{
				itemClass: items[0]?.className,
				itemCount: items.length,
				redoDimmed: host.querySelectorAll(".opacity-30").length,
				separators: host.querySelectorAll(".separator").length,
			},
		).toStrictEqual(
			{
				itemClass:
					"flex items-center flex-row gap-m leading-base cursor-pointer px-l py-ml mobile:landscape:pl-safe-left mobile:landscape:pr-safe-right",
				itemCount: 10,
				redoDimmed: 1,
				separators: 7,
			},
		);
	});
});

describe("MobileMenu markup", () =>
{
	it("is a scrim plus a bottom-attached panel", () =>
	{
		const host = document.createElement("div");
		host.innerHTML = renderToStaticMarkup(
			createElement(
				MobileMenu,
				{
					onClose: noop,
					header: true,
				},
				createElement("span", null, "body"),
			),
		);
		expect(
			{
				scrim: host.children[0]?.className,
				attached: host.children[1]?.className,
				attachedZ: (host.children[1] as HTMLElement).style.zIndex,
				panel: host.children[1]?.children[0]?.className,
				header: host.querySelectorAll(".header-row").length,
			},
		).toStrictEqual(
			{
				scrim: "modal-scrim fixed inset-0 bg-[var(--wf-black-opaque-20)] transition-opacity duration-200",
				attached: "fixed right-0 left-0 bottom-0",
				attachedZ: "300",
				panel: "wf-menu text-primary relative bg-primary overflow-y-auto rounded-tl-s rounded-tr-s max-h-[66vh] shadow-[rgba(0,0,0,0.2)_0px_2px_20px] box-border pb-3xl mobile-menu",
				header: 1,
			},
		);
	});
});

let root: Root | undefined;

function Navigator()
{
	const navigate = useNavigate();
	return createElement(
		"button",
		{
			type: "button",
			className: "go-elsewhere",
			onClick: () =>
			{
				void navigate("/elsewhere");
			},
		},
	);
}

beforeEach(() =>
{
	globalThis.IS_REACT_ACT_ENVIRONMENT = true;
	localStorage.clear();
	resetFontSizeForTests();
	Sheet.hide();
});

afterEach(() =>
{
	act(() =>
	{
		root?.unmount();
	});
	root = undefined;
	Sheet.hide();
});

function mountHost(): HTMLElement
{
	const host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	act(() =>
	{
		root?.render(createElement(MemoryRouter, null, createElement(Navigator), createElement(MobileSheetHost)));
	});
	return host;
}

describe("MobileSheetHost", () =>
{
	it("shows the font-size sheet, steps the size on taps, and locks the body while open", () =>
	{
		const host = mountHost();
		act(() =>
		{
			Sheet.set("font-size");
		});
		const buttons = [...host.querySelectorAll<HTMLElement>(".font-size-sheet button")];
		act(() =>
		{
			buttons[1]?.click();
			buttons[1]?.click();
			buttons[0]?.click();
		});
		expect(
			{
				title: host.querySelector(".font-size-sheet > div")?.textContent,
				labels: buttons.map((button) => button.textContent),
				size: getFontSize(),
				locked: document.body.classList.contains("mobile-sheet-open"),
			},
		).toStrictEqual(
			{
				title: "Text size",
				labels: ["Aa", "Aa"],
				size: 20,
				locked: true,
			},
		);
	});

	it("closes on a scrim tap and releases the body", () =>
	{
		const host = mountHost();
		act(() =>
		{
			Sheet.set("font-size");
		});
		act(() =>
		{
			host.querySelector<HTMLElement>(".modal-scrim")?.click();
		});
		expect(
			{
				sheet: Sheet.get(),
				locked: document.body.classList.contains("mobile-sheet-open"),
				scrims: host.querySelectorAll(".modal-scrim").length,
			},
		).toStrictEqual(
			{
				sheet: null,
				locked: false,
				scrims: 0,
			},
		);
	});

	it("closes on a location change", async () =>
	{
		mountHost();
		act(() =>
		{
			Sheet.set("font-size");
		});
		act(() =>
		{
			document.querySelector<HTMLElement>(".go-elsewhere")?.click();
		});
		await act(async () =>
		{
			await new Promise<void>((resolve) =>
			{
				setTimeout(resolve, 5);
			});
		});
		expect(Sheet.get()).toBeNull();
	});
});
