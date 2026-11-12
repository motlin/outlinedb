// @vitest-environment happy-dom
import {afterEach, beforeEach, describe, expect, it, vi} from "vite-plus/test";
import {installContentLinkContextMenu} from "../src/client/content-link-click.js";

let uninstall: (() => void) | undefined;

beforeEach(() =>
{
	vi.useFakeTimers();
});

afterEach(() =>
{
	uninstall?.();
	vi.useRealTimers();
	document.body.innerHTML = "";
});

describe("installContentLinkContextMenu", () =>
{
	it("makes a content link non-editable while the native menu opens, without preventing it", () =>
	{
		document.body.innerHTML =
			'<span contenteditable="true"><a class="contentLink" href="https://example.com/">link</a></span>';
		uninstall = installContentLinkContextMenu(document);
		const anchor = document.querySelector("a")!;
		const event = new MouseEvent(
			"contextmenu",
			{
				bubbles: true,
				cancelable: true,
			},
		);

		anchor.dispatchEvent(event);
		const during = anchor.getAttribute("contenteditable");
		vi.runAllTimers();

		expect(
			{
				during,
				after: anchor.getAttribute("contenteditable"),
				prevented: event.defaultPrevented,
			},
		).toStrictEqual(
			{
				during: "false",
				after: null,
				prevented: false,
			},
		);
	});

	it("leaves other elements alone, and stops after uninstall", () =>
	{
		document.body.innerHTML =
			'<span id="plain" contenteditable="true">x</span><a class="contentLink" href="https://example.com/">link</a>';
		uninstall = installContentLinkContextMenu(document);
		document.querySelector("#plain")!.dispatchEvent(
			new MouseEvent(
				"contextmenu",
				{
					bubbles: true,
				},
			),
		);
		const plain = document.querySelector("#plain")!.getAttribute("contenteditable");
		uninstall();
		uninstall = undefined;
		const anchor = document.querySelector("a")!;
		anchor.dispatchEvent(
			new MouseEvent(
				"contextmenu",
				{
					bubbles: true,
				},
			),
		);

		expect(
			{
				plain,
				anchor: anchor.getAttribute("contenteditable"),
			},
		).toStrictEqual(
			{
				plain: "true",
				anchor: null,
			},
		);
	});
});
