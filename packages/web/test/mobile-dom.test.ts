// @vitest-environment happy-dom
import {afterEach, beforeEach, describe, expect, it, vi} from "vite-plus/test";
import {
	DEFAULT_FONT_SIZE,
	FONT_SIZE_STORAGE_KEY,
	clampFontSize,
	getFontSize,
	mobileRowMetrics,
	resetFontSizeForTests,
	setFontSize,
	stepFontSize,
	subscribeFontSize,
} from "../src/client/mobile-font-size.js";
import {act, createElement} from "react";
import {createRoot} from "react-dom/client";
import {renderToStaticMarkup} from "react-dom/server";
import {MobileSearchFormView} from "../src/client/components/mobile-search-form.js";
import type {MobileSearchFormViewProps} from "../src/client/components/mobile-search-form.js";
import {mobileSearchBlurAction} from "../src/client/mobile-search-model.js";
import type {Root} from "react-dom/client";
import {MemoryRouter, useNavigate} from "react-router-dom";
import {MobileMenu} from "../src/client/components/mobile-menu.js";
import {MobileSheetHost} from "../src/client/components/mobile-sheet-host.js";
import {MoreMenuRows} from "../src/client/components/mobile-more-menu.js";
import {moreMenuLabels, moreMenuRows} from "../src/client/mobile-more-menu-model.js";
import {Sheet} from "../src/client/stores/sheet.js";
import {MobileTabBarView} from "../src/client/components/mobile-tab-bar.js";
import {tabBarClassName} from "../src/client/mobile-tab-bar-model.js";
import type {TabBarButton} from "../src/client/components/mobile-tab-bar.js";
import {homeButtonOpacity, truncateCrumb} from "../src/client/mobile-crumbs.js";
import {MobileBreadcrumbsView} from "../src/client/components/mobile-top-bar.js";

declare global {
	// React reads this to know act() wraps every update.
	var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

describe("mobile font size", () => {
	beforeEach(() => {
		localStorage.clear();
		resetFontSizeForTests();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe("font size setting", () => {
		it("defaults to 19 and clamps steps to 12..28", () => {
			expect({
				initial: getFontSize(),
				up: stepFontSize(19, 1),
				down: stepFontSize(19, -1),
				floor: stepFontSize(12, -1),
				ceiling: stepFontSize(28, 1),
				clampLow: clampFontSize(3),
				clampHigh: clampFontSize(99),
				defaultConst: DEFAULT_FONT_SIZE,
			}).toStrictEqual({
				initial: 19,
				up: 20,
				down: 18,
				floor: 12,
				ceiling: 28,
				clampLow: 12,
				clampHigh: 28,
				defaultConst: 19,
			});
		});

		it("persists per browser in localStorage and tells subscribers", () => {
			const seen: number[] = [];
			const unsubscribe = subscribeFontSize(() => {
				seen.push(getFontSize());
			});
			setFontSize(22);
			unsubscribe();
			setFontSize(23);
			expect({stored: localStorage.getItem(FONT_SIZE_STORAGE_KEY), seen, current: getFontSize()}).toStrictEqual({
				stored: "23",
				seen: [22],
				current: 23,
			});
		});

		it("reads a stored size on first use and ignores junk", () => {
			localStorage.setItem(FONT_SIZE_STORAGE_KEY, "24");
			resetFontSizeForTests();
			const stored = getFontSize();
			localStorage.setItem(FONT_SIZE_STORAGE_KEY, "huge");
			resetFontSizeForTests();
			expect({stored, junk: getFontSize()}).toStrictEqual({stored: 24, junk: 19});
		});

		it("still works when storage throws", () => {
			vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
				throw new Error("blocked");
			});
			setFontSize(21);
			expect(getFontSize()).toBe(21);
		});
	});

	describe("mobileRowMetrics", () => {
		it("matches upstream's measured row at the default size", () => {
			expect(mobileRowMetrics(19)).toStrictEqual({namePaddingLeft: 30, bulletSize: 26, bulletLeft: -2});
		});

		it("scales with the font size", () => {
			expect(mobileRowMetrics(28)).toStrictEqual({namePaddingLeft: 48 / 1.3, bulletSize: 39, bulletLeft: -8});
		});
	});
});

describe("mobile search form", () => {
	const noop = () => {};
	const base: MobileSearchFormViewProps = {
		visible: false,
		value: "",
		starred: false,
		onChange: noop,
		onFocus: noop,
		onBlur: noop,
		onClear: noop,
		onToggleStar: noop,
	};

	function render(props: Partial<MobileSearchFormViewProps>): HTMLFormElement {
		const host = document.createElement("div");
		host.innerHTML = renderToStaticMarkup(createElement(MobileSearchFormView, {...base, ...props}));
		return host.firstElementChild as HTMLFormElement;
	}

	describe("MobileSearchFormView", () => {
		it("is a hidden 44px form with a 17px Search input", () => {
			const form = render({});
			const input = form.querySelector("input");
			expect({
				className: form.className,
				inputClass: input?.className,
				placeholder: input?.getAttribute("placeholder"),
				autocomplete: input?.getAttribute("autocomplete"),
				star: form.querySelectorAll("[data-icon='star']").length,
			}).toStrictEqual({
				className:
					"hidden wf-header h-[44px] bg-primary border-b border-solid border-primary flex flex-row items-center px-l gap-m",
				inputClass:
					"newMobileSearchBox searchBoxInput flex-1 text-[17px] text-primary border-0 bg-primary placeholder:text-tertiary",
				placeholder: "Search",
				autocomplete: "off",
				star: 0,
			});
		});

		it("shows as a block with a star and clear button once there is a query", () => {
			const form = render({visible: true, value: "abc", starred: true});
			expect({
				block: form.classList.contains("block"),
				hidden: form.classList.contains("hidden"),
				icons: [...form.querySelectorAll("svg")].map(
					(icon) => `${icon.getAttribute("data-prefix")}:${icon.getAttribute("data-icon")}`,
				),
			}).toStrictEqual({
				block: true,
				hidden: false,
				icons: ["fas:magnifying-glass", "fas:star", "fas:circle-xmark"],
			});
		});

		it("blurs on Enter, reports the blur value and clears on the clear button", () => {
			globalThis.IS_REACT_ACT_ENVIRONMENT = true;
			const onBlur = vi.fn<(value: string) => void>();
			const onClear = vi.fn<() => void>();
			const host = document.createElement("div");
			document.body.append(host);
			const root = createRoot(host);
			act(() => {
				root.render(
					createElement(MobileSearchFormView, {...base, visible: true, value: "abc", onBlur, onClear}),
				);
			});
			const input = host.querySelector("input");
			act(() => {
				input?.focus();
			});
			act(() => {
				input?.dispatchEvent(new KeyboardEvent("keydown", {key: "Enter", bubbles: true}));
			});
			act(() => {
				host.querySelector<HTMLElement>("[data-icon='circle-xmark']")?.parentElement?.click();
			});
			act(() => {
				root.unmount();
			});
			expect({blurs: onBlur.mock.calls, clears: onClear.mock.calls.length}).toStrictEqual({
				blurs: [["abc"]],
				clears: 1,
			});
		});
	});

	describe("mobileSearchBlurAction", () => {
		it("commits a query and cancels an empty one", () => {
			expect([mobileSearchBlurAction("abc"), mobileSearchBlurAction("")]).toStrictEqual(["commit", "cancel"]);
		});
	});
});

describe("mobile sheet", () => {
	const noop = () => {};
	const baseContext = {
		zoomedId: "alice" as string | null,
		canUndo: true,
		canRedo: false,
		starred: false,
		starsAvailable: true,
		showCompleted: false,
		completedForced: false,
		canTurnInto: true,
		actions: {
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

	describe("moreMenuRows", () => {
		it("lists upstream's rows in order, with Trash left out (no trash view locally)", () => {
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

		it("says Remove from Starred for a starred page and drops page-only rows at Home", () => {
			expect({
				starred: moreMenuLabels(moreMenuRows({...baseContext, starred: true})).filter((label) =>
					label.includes("Starred"),
				),
				home: moreMenuLabels(moreMenuRows({...baseContext, zoomedId: null})).filter((label) =>
					["Share", "Delete", "Add to Starred"].includes(label),
				),
			}).toStrictEqual({starred: ["Remove from Starred"], home: []});
		});

		it("drops the Show completed toggle while a revealing search forces completed rows", () => {
			expect(moreMenuLabels(moreMenuRows({...baseContext, completedForced: true}))).not.toContain(
				"Show completed",
			);
		});
	});

	describe("MoreMenuRows markup", () => {
		it("renders action rows with upstream's classes and the Undo | Redo pair", () => {
			const html = renderToStaticMarkup(createElement(MoreMenuRows, {rows: moreMenuRows(baseContext)}));
			const host = document.createElement("div");
			host.innerHTML = html;
			const items = [...host.querySelectorAll(".cursor-pointer.px-l")];
			expect({
				itemClass: items[0]?.className,
				itemCount: items.length,
				redoDimmed: host.querySelectorAll(".opacity-30").length,
				separators: host.querySelectorAll(".separator").length,
			}).toStrictEqual({
				itemClass:
					"flex items-center flex-row gap-m leading-base cursor-pointer px-l py-ml mobile:landscape:pl-safe-left mobile:landscape:pr-safe-right",
				itemCount: 10,
				redoDimmed: 1,
				separators: 7,
			});
		});
	});

	describe("MobileMenu markup", () => {
		it("is a scrim plus a bottom-attached panel", () => {
			const host = document.createElement("div");
			host.innerHTML = renderToStaticMarkup(
				createElement(MobileMenu, {onClose: noop, header: true}, createElement("span", null, "body")),
			);
			expect({
				scrim: host.children[0]?.className,
				attached: host.children[1]?.className,
				attachedZ: (host.children[1] as HTMLElement).style.zIndex,
				panel: host.children[1]?.children[0]?.className,
				header: host.querySelectorAll(".header-row").length,
			}).toStrictEqual({
				scrim: "modal-scrim fixed inset-0 bg-[var(--wf-black-opaque-20)] transition-opacity duration-200",
				attached: "fixed right-0 left-0 bottom-0",
				attachedZ: "300",
				panel: "wf-menu text-primary relative bg-primary overflow-y-auto rounded-tl-s rounded-tr-s max-h-[66vh] shadow-[rgba(0,0,0,0.2)_0px_2px_20px] box-border pb-3xl mobile-menu",
				header: 1,
			});
		});
	});

	let root: Root | undefined;

	function Navigator() {
		const navigate = useNavigate();
		return createElement("button", {
			type: "button",
			className: "go-elsewhere",
			onClick: () => {
				void navigate("/elsewhere");
			},
		});
	}

	beforeEach(() => {
		globalThis.IS_REACT_ACT_ENVIRONMENT = true;
		localStorage.clear();
		resetFontSizeForTests();
		Sheet.hide();
	});

	afterEach(() => {
		act(() => {
			root?.unmount();
		});
		root = undefined;
		Sheet.hide();
	});

	function mountHost(): HTMLElement {
		const host = document.createElement("div");
		document.body.append(host);
		root = createRoot(host);
		act(() => {
			root?.render(createElement(MemoryRouter, null, createElement(Navigator), createElement(MobileSheetHost)));
		});
		return host;
	}

	describe("MobileSheetHost", () => {
		it("shows the font-size sheet, steps the size on taps, and locks the body while open", () => {
			const host = mountHost();
			act(() => {
				Sheet.set("font-size");
			});
			const buttons = [...host.querySelectorAll<HTMLElement>(".font-size-sheet button")];
			act(() => {
				buttons[1]?.click();
				buttons[1]?.click();
				buttons[0]?.click();
			});
			expect({
				title: host.querySelector(".font-size-sheet > div")?.textContent,
				labels: buttons.map((button) => button.textContent),
				size: getFontSize(),
				locked: document.body.classList.contains("mobile-sheet-open"),
			}).toStrictEqual({title: "Text size", labels: ["Aa", "Aa"], size: 20, locked: true});
		});

		it("closes on a scrim tap and releases the body", () => {
			const host = mountHost();
			act(() => {
				Sheet.set("font-size");
			});
			act(() => {
				host.querySelector<HTMLElement>(".modal-scrim")?.click();
			});
			expect({
				sheet: Sheet.get(),
				locked: document.body.classList.contains("mobile-sheet-open"),
				scrims: host.querySelectorAll(".modal-scrim").length,
			}).toStrictEqual({sheet: null, locked: false, scrims: 0});
		});

		it("closes on a location change", async () => {
			mountHost();
			act(() => {
				Sheet.set("font-size");
			});
			act(() => {
				document.querySelector<HTMLElement>(".go-elsewhere")?.click();
			});
			await act(async () => {
				await new Promise<void>((resolve) => {
					setTimeout(resolve, 5);
				});
			});
			expect(Sheet.get()).toBeNull();
		});
	});
});

describe("mobile tab bar", () => {
	const IPHONE =
		"Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1";
	const ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/126.0.0.0 Mobile Safari/537.36";

	function buttons(back: boolean, press: () => void = () => {}): TabBarButton[] {
		return [
			{id: "menu", icon: "fal:bars", enabled: true, onPress: press},
			{id: "back", icon: "fal:chevron-left", enabled: back, onPress: press},
			{id: "add", icon: "fal:plus", enabled: true, onPress: press},
			{id: "today", icon: "fal:calendar-day", enabled: true, onPress: press},
			{id: "search", icon: "fas:magnifying-glass", enabled: true, onPress: press},
		];
	}

	function render(userAgent: string, list: TabBarButton[], sheetOpen = false): HTMLElement {
		const host = document.createElement("div");
		host.innerHTML = renderToStaticMarkup(createElement(MobileTabBarView, {userAgent, buttons: list, sheetOpen}));
		return host;
	}

	describe("tab bar", () => {
		it("has upstream's classes and five 44px buttons on iOS, with Back dimmed when history is empty", () => {
			const host = render(IPHONE, buttons(false));
			const bar = host.firstElementChild as HTMLElement;
			const tabs = [...bar.querySelectorAll<HTMLElement>(".tab-bar-button")];
			expect({
				className: bar.className,
				icons: tabs.map((tab) => tab.querySelector("svg")?.getAttribute("data-icon")),
				tabClass: tabs[0]?.className,
				opacities: tabs.map((tab) => tab.style.opacity),
			}).toStrictEqual({
				className:
					"tab-bar hideForSheetView fixed left-0 right-0 bottom-0 flex items-center pb-[var(--safe-area-inset-bottom)] bg-primary border-t-primary border-t border-solid z-10 text-tertiary justify-around h-[49px]",
				icons: ["bars", "chevron-left", "plus", "calendar-day", "magnifying-glass"],
				tabClass: "tab-bar-button w-[44px] h-[44px] flex items-center justify-center",
				opacities: ["", "0.5", "", "", ""],
			});
		});

		it("is 56px tall on Android and has no back button", () => {
			const host = render(ANDROID, buttons(true));
			const icons = [...host.querySelectorAll(".tab-bar-button svg")].map((icon) =>
				icon.getAttribute("data-icon"),
			);
			expect({className: tabBarClassName(ANDROID).endsWith("h-[56px]"), icons}).toStrictEqual({
				className: true,
				icons: ["bars", "plus", "calendar-day", "magnifying-glass"],
			});
		});

		it("fades out while a sheet is open", () => {
			const host = render(IPHONE, buttons(true), true);
			expect((host.firstElementChild as HTMLElement).style.opacity).toBe("0");
		});

		it("ignores a tap on an unavailable command and runs an available one", () => {
			globalThis.IS_REACT_ACT_ENVIRONMENT = true;
			const press = vi.fn<() => void>();
			const host = document.createElement("div");
			document.body.append(host);
			const root = createRoot(host);
			act(() => {
				root.render(
					createElement(MobileTabBarView, {
						userAgent: IPHONE,
						buttons: buttons(false, press),
						sheetOpen: false,
					}),
				);
			});
			const tabs = host.querySelectorAll<HTMLElement>(".tab-bar-button");
			act(() => {
				tabs[1]?.click();
			});
			const afterBack = press.mock.calls.length;
			act(() => {
				tabs[2]?.click();
			});
			act(() => {
				root.unmount();
			});
			expect({afterBack, afterAdd: press.mock.calls.length}).toStrictEqual({afterBack: 0, afterAdd: 1});
		});
	});
});

describe("mobile top bar", () => {
	const noop = () => {};

	function render(crumbs: {id: string; label: string}[], searching = false): HTMLElement {
		const host = document.createElement("div");
		host.innerHTML = renderToStaticMarkup(
			createElement(MobileBreadcrumbsView, {crumbs, searching, onHome: noop, onCrumb: noop, onKebab: noop}),
		);
		return host;
	}

	describe("truncateCrumb", () => {
		it("cuts at 15 characters plus an ellipsis, and names an empty crumb Untitled", () => {
			expect({
				long: truncateCrumb("Seed rows with a long name"),
				exact: truncateCrumb("123456789012345"),
				short: truncateCrumb("Delta"),
				empty: truncateCrumb(""),
			}).toStrictEqual({long: "Seed rows with …", exact: "123456789012345", short: "Delta", empty: "Untitled"});
		});
	});

	describe("homeButtonOpacity", () => {
		it("dims the home button at the root unless a search can be left", () => {
			expect([
				homeButtonOpacity({atRoot: true, searching: false}),
				homeButtonOpacity({atRoot: true, searching: true}),
				homeButtonOpacity({atRoot: false, searching: false}),
			]).toStrictEqual([0.5, 1, 1]);
		});
	});

	describe("MobileBreadcrumbsView", () => {
		const trail = [
			{id: "a", label: "Seed rows with a long name"},
			{id: "b", label: "Delta"},
		];

		it("renders the home button, chevron, scrolling crumb trail and kebab", () => {
			const host = render(trail);
			const root = host.firstElementChild as HTMLElement;
			const home = root.querySelector<HTMLElement>(".homeButton");
			const spans = [...root.querySelectorAll(".italic")].map((italic) => {
				const inner = italic.firstElementChild as HTMLElement;
				return {text: inner.textContent, underline: inner.classList.contains("underline")};
			});
			const scroller = root.querySelector(".overflow-x-auto");
			const kebab = root.querySelector<HTMLElement>(String.raw`.basis-\[44px\]`);
			expect({
				rootClass: root.className,
				homeClass: home?.className,
				homeStyle: home?.getAttribute("style"),
				leadingChevron: root.children[1]?.getAttribute("style"),
				scrollerClass: scroller?.className,
				spans,
				trailChevrons: scroller?.querySelectorAll(".pointer-events-none").length,
				kebabStyle: kebab?.getAttribute("style"),
				kebabIcon: kebab?.querySelector("svg")?.getAttribute("data-icon"),
			}).toStrictEqual({
				rootClass:
					"h-[var(--wf-header-height)] flex items-stretch justify-start overflow-hidden bg-primary MobileBreadcrumbs",
				homeClass:
					"h-full shrink-0 flex items-center justify-center transition-opacity duration-100 ease-base homeButton",
				homeStyle: "width:48px;opacity:1",
				leadingChevron: "left:-8px",
				scrollerClass:
					"relative h-full flex-[1_1_auto] flex items-stretch flex-nowrap overflow-x-auto [--webkit-overflow-scrolling:touch]",
				spans: [
					{text: "Seed rows with …", underline: true},
					{text: "Delta", underline: false},
				],
				trailChevrons: 1,
				kebabStyle: "margin-right:4px",
				kebabIcon: "ellipsis-vertical",
			});
		});

		it("dims home and drops the chevron at the root", () => {
			const host = render([]);
			const home = host.querySelector<HTMLElement>(".homeButton");
			expect({
				homeStyle: home?.getAttribute("style"),
				chevron: host.querySelectorAll("[style='left:-8px']").length,
			}).toStrictEqual({homeStyle: "width:48px;opacity:0.5", chevron: 0});
		});

		it("shows Untitled for an empty name", () => {
			const host = render([{id: "a", label: ""}]);
			expect(host.querySelector(".italic")?.textContent).toBe("Untitled");
		});

		it("taps navigate only on ancestors, go home and open the kebab", () => {
			globalThis.IS_REACT_ACT_ENVIRONMENT = true;
			const calls: string[] = [];
			const host = document.createElement("div");
			document.body.append(host);
			const root = createRoot(host);
			act(() => {
				root.render(
					createElement(MobileBreadcrumbsView, {
						crumbs: trail,
						searching: false,
						onHome: () => {
							calls.push("home");
						},
						onCrumb: (id) => {
							calls.push(`crumb:${id}`);
						},
						onKebab: () => {
							calls.push("kebab");
						},
					}),
				);
			});
			const italics = host.querySelectorAll<HTMLElement>(".italic > span");
			act(() => {
				italics[0]?.click();
				italics[1]?.click();
				host.querySelector<HTMLElement>(".homeButton")?.click();
				host.querySelector<HTMLElement>(String.raw`.basis-\[44px\]`)?.click();
			});
			act(() => {
				root.unmount();
			});
			expect(calls).toStrictEqual(["crumb:a", "home", "kebab"]);
		});
	});
});
