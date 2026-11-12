// @vitest-environment happy-dom
import {describe, expect, it, vi} from "vite-plus/test";
import {act, createElement} from "react";
import {createRoot} from "react-dom/client";
import {renderToStaticMarkup} from "react-dom/server";
import {MobileTabBarView} from "../src/client/components/mobile-tab-bar.js";
import {tabBarClassName} from "../src/client/mobile-tab-bar-model.js";
import type {TabBarButton} from "../src/client/components/mobile-tab-bar.js";

declare global
{
	// React reads this to know act() wraps every update.
	var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1";
const ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/126.0.0.0 Mobile Safari/537.36";

function buttons(
	back: boolean,
	press: () => void = () =>
	{
	},
): TabBarButton[]
{
	return [
		{
			id: "menu",
			icon: "fal:bars",
			enabled: true,
			onPress: press,
		},
		{
			id: "back",
			icon: "fal:chevron-left",
			enabled: back,
			onPress: press,
		},
		{
			id: "add",
			icon: "fal:plus",
			enabled: true,
			onPress: press,
		},
		{
			id: "today",
			icon: "fal:calendar-day",
			enabled: true,
			onPress: press,
		},
		{
			id: "search",
			icon: "fas:magnifying-glass",
			enabled: true,
			onPress: press,
		},
	];
}

function render(userAgent: string, list: TabBarButton[], sheetOpen = false): HTMLElement
{
	const host = document.createElement("div");
	host.innerHTML = renderToStaticMarkup(
		createElement(
			MobileTabBarView,
			{
				userAgent,
				buttons: list,
				sheetOpen,
			},
		),
	);
	return host;
}

describe("tab bar", () =>
{
	it("has upstream's classes and five 44px buttons on iOS, with Back dimmed when history is empty", () =>
	{
		const host = render(IPHONE, buttons(false));
		const bar = host.firstElementChild as HTMLElement;
		const tabs = [...bar.querySelectorAll<HTMLElement>(".tab-bar-button")];
		expect(
			{
				className: bar.className,
				icons: tabs.map((tab) => tab.querySelector("svg")?.getAttribute("data-icon")),
				tabClass: tabs[0]?.className,
				opacities: tabs.map((tab) => tab.style.opacity),
			},
		).toStrictEqual(
			{
				className:
					"tab-bar hideForSheetView fixed left-0 right-0 bottom-0 flex items-center pb-[var(--safe-area-inset-bottom)] bg-primary border-t-primary border-t border-solid z-10 text-tertiary justify-around h-[49px]",
				icons: ["bars", "chevron-left", "plus", "calendar-day", "magnifying-glass"],
				tabClass: "tab-bar-button w-[44px] h-[44px] flex items-center justify-center",
				opacities: ["", "0.5", "", "", ""],
			},
		);
	});

	it("is 56px tall on Android and has no back button", () =>
	{
		const host = render(ANDROID, buttons(true));
		const icons = [...host.querySelectorAll(".tab-bar-button svg")].map((icon) => icon.getAttribute("data-icon"));
		expect(
			{
				className: tabBarClassName(ANDROID).endsWith("h-[56px]"),
				icons,
			},
		).toStrictEqual(
			{
				className: true,
				icons: ["bars", "plus", "calendar-day", "magnifying-glass"],
			},
		);
	});

	it("fades out while a sheet is open", () =>
	{
		const host = render(IPHONE, buttons(true), true);
		expect((host.firstElementChild as HTMLElement).style.opacity).toBe("0");
	});

	it("ignores a tap on an unavailable command and runs an available one", () =>
	{
		globalThis.IS_REACT_ACT_ENVIRONMENT = true;
		const press = vi.fn<() => void>();
		const host = document.createElement("div");
		document.body.append(host);
		const root = createRoot(host);
		act(() =>
		{
			root.render(
				createElement(
					MobileTabBarView,
					{
						userAgent: IPHONE,
						buttons: buttons(false, press),
						sheetOpen: false,
					},
				),
			);
		});
		const tabs = host.querySelectorAll<HTMLElement>(".tab-bar-button");
		act(() =>
		{
			tabs[1]?.click();
		});
		const afterBack = press.mock.calls.length;
		act(() =>
		{
			tabs[2]?.click();
		});
		act(() =>
		{
			root.unmount();
		});
		expect(
			{
				afterBack,
				afterAdd: press.mock.calls.length,
			},
		).toStrictEqual(
			{
				afterBack: 0,
				afterAdd: 1,
			},
		);
	});
});
