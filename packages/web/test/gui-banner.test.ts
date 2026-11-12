// @vitest-environment happy-dom
import {afterEach, describe, expect, it, vi} from "vite-plus/test";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";

const {GuiBannerView} = await import("../src/client/components/gui-banner.js");
const {cutBannerText} = await import("../src/client/copy-cut-plan.js");
const {useBannerStore, showBanner, hideBanner, bannerEscapeAction} = await import("../src/client/stores/banner.js");
afterEach(() =>
{
	hideBanner();
});

describe("GuiBanner", () =>
{
	it("renders upstream's banner classes and message", () =>
	{
		const markup = renderToStaticMarkup(
			createElement(
				GuiBannerView,
				{
					kind: "info",
					text: cutBannerText(8, true),
					action:
					{
						label: "Restore.",
						run: () =>
						{
						},
					},
					left: 0,
					onClose: () =>
					{
					},
					onAction: () =>
					{
					},
				},
			),
		);
		const classes = [...markup.matchAll(/class="([^"]*)"/gu)].map((match) =>
			match[1]?.replaceAll("&amp;", "&").split(/\s+/u),
		);
		expect(classes[0]).toStrictEqual([
			"fixed",
			"right-0",
			"top-[calc(var(--wf-header-height,0)+var(--safe-area-inset-top,0))]",
			"overflow-hidden",
			"z-10",
			"print:hidden",
			"transition-[left]",
			"duration-250",
		]);
		expect(classes[1]).toStrictEqual([
			"font-system",
			"flex",
			"items-center",
			"px-2xl",
			"py-ml",
			"text-s",
			"text-center",
			"transition-transform",
			"duration-300",
			"bg-info",
			"[&_a]:text-[var(--wf-gray-800)]",
			"[&_a]:underline",
			"[&_a]:cursor-pointer",
			"[&_a.undelete]:font-bold",
		]);
		expect(classes[2]).toStrictEqual(["messageContent", "flex-grow", "flex-shrink", "leading-base"]);
		expect(markup).toContain(
			'8 items and their descendantscut and added to clipboard. <a class="undelete" href="#">Restore.</a>',
		);
	});

	it("uses bg-warning for warnings", () =>
	{
		const markup = renderToStaticMarkup(
			createElement(
				GuiBannerView,
				{
					kind: "warn",
					text: "careful",
					left: 0,
					onClose: () =>
					{
					},
					onAction: () =>
					{
					},
				},
			),
		);
		expect(markup).toContain("bg-warning");
		expect(markup).not.toContain("bg-info");
	});

	it("words the cut message with and without descendants", () =>
	{
		expect([cutBannerText(12, false), cutBannerText(1, true), cutBannerText(10, true)]).toStrictEqual([
			"12 items cut and added to clipboard. ",
			"1 item and its descendantscut and added to clipboard. ",
			"10 items and their descendantscut and added to clipboard. ",
		]);
	});

	it("hides on Escape unless focus is in the search box", () =>
	{
		expect([
			bannerEscapeAction(
				{
					open: true,
					inSearchBox: false,
				},
			),
			bannerEscapeAction(
				{
					open: true,
					inSearchBox: true,
				},
			),
			bannerEscapeAction(
				{
					open: false,
					inSearchBox: false,
				},
			),
		]).toStrictEqual(["hide", "ignore", "ignore"]);
	});

	it("the store keeps one banner, replaced by the next, and hides on demand", () =>
	{
		showBanner(
			"first",
			{
				kind: "info",
			},
		);
		showBanner(
			"second",
			{
				kind: "warn",
			},
		);
		expect(useBannerStore.getState().banner).toStrictEqual(
			{
				kind: "warn",
				text: "second",
			},
		);
		hideBanner();
		expect(useBannerStore.getState().banner).toBeNull();
	});

	it("clicking the undelete action runs it once and keeps the banner", () =>
	{
		const run = vi.fn<() => void>();
		showBanner(
			"x ",
			{
				kind: "info",
				action:
				{
					label: "Restore.",
					run,
				},
			},
		);
		useBannerStore.getState().banner?.action?.run();
		expect(run).toHaveBeenCalledOnce();
		expect(useBannerStore.getState().banner).not.toBeNull();
	});
});
