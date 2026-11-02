// @vitest-environment happy-dom
import {afterEach, describe, expect, it} from "vite-plus/test";
import {installLinkStatusBar} from "../src/client/link-status-bar.js";

let uninstall: (() => void) | undefined;

afterEach(() =>
{
	uninstall?.();
	uninstall = undefined;
	document.body.innerHTML = "";
});

describe("installLinkStatusBar", () =>
{
	it("appends upstream's fixed bottom-left bar, hidden until a link is hovered", () =>
	{
		uninstall = installLinkStatusBar(document);
		const bar = document.body.lastElementChild as HTMLElement;

		expect(
			[
				"position: fixed",
				"bottom: 0px",
				"left: 0px",
				"z-index: 1000",
				"font-size: 12px",
				"padding: 2px 5px",
				"opacity: 0",
				"transition: opacity 0.3s",
				"color: rgb(60, 64, 67)",
				"background: rgb(222, 225, 230)",
			].filter((part) => !bar.style.cssText.includes(part)),
		).toStrictEqual([]);
	});

	it("shows the hovered link's href and hides on leave and on hashchange", () =>
	{
		document.body.innerHTML = '<a class="contentLink" href="https://example.com/page">example</a>';
		uninstall = installLinkStatusBar(document);
		const bar = document.body.lastElementChild as HTMLElement;
		const anchor = document.querySelector("a")!;

		anchor.dispatchEvent(
			new MouseEvent(
				"mouseover",
				{
					bubbles: true,
				},
			),
		);
		const hovered =
		{
			text: bar.textContent,
			opacity: bar.style.opacity,
		};
		anchor.dispatchEvent(
			new MouseEvent(
				"mouseout",
				{
					bubbles: true,
				},
			),
		);
		const left = bar.style.opacity;
		anchor.dispatchEvent(
			new MouseEvent(
				"mouseover",
				{
					bubbles: true,
				},
			),
		);
		window.dispatchEvent(new Event("hashchange"));

		expect(
			{
				hovered,
				left,
				afterHashChange: bar.style.opacity,
			},
		).toStrictEqual(
			{
				hovered:
				{
					text: "https://example.com/page",
					opacity: "1",
				},
				left: "0",
				afterHashChange: "0",
			},
		);
	});

	it("removes the bar on uninstall", () =>
	{
		uninstall = installLinkStatusBar(document);
		uninstall();
		uninstall = undefined;

		expect(document.body.children).toHaveLength(0);
	});
});
