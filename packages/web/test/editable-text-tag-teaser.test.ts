// @vitest-environment happy-dom
import {afterEach, beforeEach, describe, expect, it, vi} from "vite-plus/test";
import {act, createElement} from "react";
import {createRoot} from "react-dom/client";
import type {Root} from "react-dom/client";
import {QueryClient, QueryClientProvider} from "@tanstack/react-query";
import {editableText} from "../src/client/components/editable-text.js";
import {useOutlineStore} from "../src/client/stores/outline.js";
import {is, pop, resetPopupsForTests} from "../src/client/popups.js";

declare global
{
	var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let root: Root | undefined;
let host: HTMLDivElement | undefined;

beforeEach(() =>
{
	globalThis.IS_REACT_ACT_ENVIRONMENT = true;
	vi.useFakeTimers();
	useOutlineStore.setState(useOutlineStore.getInitialState(), true);
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => Promise.resolve(Response.json({}))),
	);
});

afterEach(() =>
{
	act(() =>
	{
		root?.unmount();
	});
	host?.remove();
	root = undefined;
	host = undefined;
	for (const element of document.body.querySelectorAll(".flyout, .hidden"))
	{
		element.remove();
	}
	resetPopupsForTests();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

function mountRow(): HTMLElement
{
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	act(() =>
	{
		root?.render(
			createElement(
				QueryClientProvider,
				{
					client: new QueryClient(),
				},
				createElement(
					editableText,
					{
						nodeId: "alice",
						initialValue: "Alice #todo later",
						parentId: null,
						priority: 0,
						isEditing: false,
					},
				),
			),
		);
	});
	const content = host.querySelector<HTMLElement>(".innerContentContainer");
	if (!content)
	{
		throw new Error("no resting content");
	}
	return content;
}

function tagOf(content: HTMLElement): HTMLElement
{
	const tag = content.querySelector<HTMLElement>(".contentTag");
	if (!tag)
	{
		throw new Error("no rendered tag");
	}
	return tag;
}

function hover(target: Element): void
{
	act(() =>
	{
		target.dispatchEvent(
			new MouseEvent(
				"mouseover",
				{
					bubbles: true,
				},
			),
		);
	});
}

function teaserOpen(): boolean
{
	return document.querySelector(".tag-color-teaser") !== null;
}

function advance(ms: number): void
{
	act(() =>
	{
		vi.advanceTimersByTime(ms);
	});
}

describe("tag color teaser", () =>
{
	it("opens on tag hover and closes 150ms after the pointer moves from the tag onto plain text in the same row", () =>
	{
		const content = mountRow();
		hover(tagOf(content));
		const opened = teaserOpen();
		hover(content);
		const justAfter = teaserOpen();
		advance(150);
		expect(
			{
				opened,
				justAfter,
				after: teaserOpen(),
			},
		).toStrictEqual(
			{
				opened: true,
				justAfter: true,
				after: false,
			},
		);
	});

	it("stays open when the pointer returns to the tag before the hide delay ends", () =>
	{
		const content = mountRow();
		hover(tagOf(content));
		hover(content);
		advance(100);
		hover(tagOf(content));
		advance(200);
		expect(teaserOpen()).toBe(true);
	});

	it("closes when the caret moves", () =>
	{
		const content = mountRow();
		hover(tagOf(content));
		const opened = teaserOpen();
		act(() =>
		{
			document.dispatchEvent(new Event("selectionchange"));
		});
		expect(
			{
				opened,
				after: teaserOpen(),
			},
		).toStrictEqual(
			{
				opened: true,
				after: false,
			},
		);
	});

	it("closes when the editor blurs", () =>
	{
		const content = mountRow();
		hover(tagOf(content));
		const opened = teaserOpen();
		act(() =>
		{
			document.body.dispatchEvent(
				new FocusEvent(
					"focusout",
					{
						bubbles: true,
					},
				),
			);
		});
		expect(
			{
				opened,
				after: teaserOpen(),
			},
		).toStrictEqual(
			{
				opened: true,
				after: false,
			},
		);
	});

	it("opens beside the always-mounted hidden search-helpers flyout", () =>
	{
		const content = mountRow();
		const hidden = document.createElement("div");
		hidden.className = "hidden";
		hidden.innerHTML = '<div class="flyout menu"></div>';
		document.body.append(hidden);
		hover(tagOf(content));
		expect(
			{
				teaser: teaserOpen(),
				registered: is("TAG_COLOR_TEASER_POPUP"),
			},
		).toStrictEqual(
			{
				teaser: true,
				registered: true,
			},
		);
	});

	it("opens while an unregistered flyout such as the tag autocomplete is visible", () =>
	{
		const content = mountRow();
		const menu = document.createElement("div");
		menu.className = "flyout menu";
		document.body.append(menu);
		hover(tagOf(content));
		expect(teaserOpen()).toBe(true);
	});

	it("does not open while the selection toolbar is registered", () =>
	{
		const content = mountRow();
		pop("CTX_MENU_POPUP");
		hover(tagOf(content));
		expect(teaserOpen()).toBe(false);
	});

	it("unregisters when the teaser closes", () =>
	{
		const content = mountRow();
		hover(tagOf(content));
		act(() =>
		{
			document.dispatchEvent(new Event("selectionchange"));
		});
		expect(is("TAG_COLOR_TEASER_POPUP")).toBe(false);
	});

	it("does not open while a modal is open", () =>
	{
		const content = mountRow();
		useOutlineStore.setState(
			{
				jumpMenuOpen: true,
			},
		);
		hover(tagOf(content));
		expect(teaserOpen()).toBe(false);
	});
});
