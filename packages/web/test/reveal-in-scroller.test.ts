import {describe, expect, it} from "vite-plus/test";
import {nearestScrollTop, revealInScroller} from "../src/client/reveal-in-scroller.js";

interface Box
{
	top: number;
	bottom: number;
}

function fakeScroller(box: Box, scrollTop: number)
{
	return {
		scrollTop,
		getBoundingClientRect: () => box,
	};
}

function fakeItem(box: Box, scroller: ReturnType<typeof fakeScroller> | null)
{
	const calls: string[] = [];
	return {
		calls,
		element:
		{
			getBoundingClientRect: () => box,
			closest: (selector: string) =>
			{
				calls.push(`closest ${selector}`);
				return scroller;
			},
			scrollIntoView: () =>
			{
				calls.push("scrollIntoView");
			},
		},
	};
}

describe("nearestScrollTop", () =>
{
	it("keeps the scroll position when the item is fully visible", () =>
	{
		expect(
			nearestScrollTop(
				{
					top: 120,
					bottom: 140,
				},
				{
					top: 100,
					bottom: 300,
				},
				40,
			),
		).toBe(40);
	});

	it("scrolls up so an item above the view lines up with its top", () =>
	{
		expect(
			nearestScrollTop(
				{
					top: 80,
					bottom: 100,
				},
				{
					top: 100,
					bottom: 300,
				},
				40,
			),
		).toBe(20);
	});

	it("scrolls down so an item below the view lines up with its bottom", () =>
	{
		expect(
			nearestScrollTop(
				{
					top: 290,
					bottom: 320,
				},
				{
					top: 100,
					bottom: 300,
				},
				40,
			),
		).toBe(60);
	});
});

describe("revealInScroller", () =>
{
	it("scrolls only the menu's scroller and never the document, unlike scrollIntoView", () =>
	{
		const scroller = fakeScroller(
			{
				top: 100,
				bottom: 300,
			},
			0,
		);
		const {calls, element} = fakeItem(
			{
				top: 310,
				bottom: 337,
			},
			scroller,
		);

		revealInScroller(element as unknown as HTMLElement);

		expect(
			{
				calls,
				scrollTop: scroller.scrollTop,
			},
		).toStrictEqual(
			{
				calls: ["closest .scroller"],
				scrollTop: 37,
			},
		);
	});

	it("does nothing outside a scroller", () =>
	{
		const {calls, element} = fakeItem(
			{
				top: 310,
				bottom: 337,
			},
			null,
		);

		revealInScroller(element as unknown as HTMLElement);

		expect(calls).toStrictEqual(["closest .scroller"]);
	});
});
