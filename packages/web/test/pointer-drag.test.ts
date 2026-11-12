// @vitest-environment happy-dom
import {describe, expect, it} from "vite-plus/test";
import
{
	DRAG_THRESHOLD_PX,
	autoScrollBy,
	edgeAutoscrollSpeed,
	createEdgeAutoscroller,
	isDragGesture,
	pickScroller,
	stepAutoscroll,
} from "../src/client/pointer-drag.js";

describe("isDragGesture", () =>
{
	it("ignores the jitter of a tap so a tap never refiles a row", () =>
	{
		expect(
			isDragGesture(
				{
					x: 10,
					y: 10,
				},
				{
					x: 12,
					y: 13,
				},
			),
		).toBe(false);
	});

	it("becomes a drag once the finger travels past the threshold", () =>
	{
		expect(
			isDragGesture(
				{
					x: 10,
					y: 10,
				},
				{
					x: 10,
					y: 10 + DRAG_THRESHOLD_PX + 1,
				},
			),
		).toBe(true);
	});

	it("measures travel in either direction", () =>
	{
		expect(
			isDragGesture(
				{
					x: 100,
					y: 100,
				},
				{
					x: 100 - DRAG_THRESHOLD_PX - 1,
					y: 100,
				},
			),
		).toBe(true);
	});
});

describe("autoScrollBy", () =>
{
	const viewport = 800;

	it("does not scroll while the pointer is in the middle of the screen", () =>
	{
		expect(autoScrollBy(400, viewport)).toBe(0);
	});

	it("scrolls up near the top edge, so a long tier can be dragged out of", () =>
	{
		expect(autoScrollBy(10, viewport)).toBeLessThan(0);
	});

	it("scrolls down near the bottom edge", () =>
	{
		expect(autoScrollBy(viewport - 10, viewport)).toBeGreaterThan(0);
	});

	it("scrolls faster the closer the pointer gets to the edge", () =>
	{
		expect(Math.abs(autoScrollBy(2, viewport))).toBeGreaterThan(Math.abs(autoScrollBy(60, viewport)));
	});
});

describe("edgeAutoscrollSpeed", () =>
{
	const base =
	{
		scrollerTop: 0,
		scrollerHeight: 1000,
		startY: 500,
		haveScrolled: false,
		mobile: false,
	};

	it("follows upstream's quadratic curve inside the 15% edge zones", () =>
	{
		const speeds = [
			edgeAutoscrollSpeed(
				{
					...base,
					pointerY: 0,
				},
			),
			edgeAutoscrollSpeed(
				{
					...base,
					pointerY: 75,
				},
			),
			edgeAutoscrollSpeed(
				{
					...base,
					pointerY: 100,
					startY: 50,
				},
			),
			edgeAutoscrollSpeed(
				{
					...base,
					pointerY: 100,
					startY: 50,
					haveScrolled: true,
				},
			),
			edgeAutoscrollSpeed(
				{
					...base,
					pointerY: 925,
				},
			),
			edgeAutoscrollSpeed(
				{
					...base,
					pointerY: 500,
				},
			),
			edgeAutoscrollSpeed(
				{
					...base,
					pointerY: 0,
					mobile: true,
				},
			),
		];
		expect(speeds).toStrictEqual([-1250, -313, 0, -139, 313, 0, -1000]);
	});

	it("measures the pointer relative to the scroller's top", () =>
	{
		expect(
			edgeAutoscrollSpeed(
				{
					...base,
					scrollerTop: 200,
					pointerY: 275,
				},
			),
		).toBe(-313);
	});

	it("ignores the bottom zone while the drag started below the pointer and nothing has scrolled", () =>
	{
		expect(
			edgeAutoscrollSpeed(
				{
					...base,
					pointerY: 925,
					startY: 950,
				},
			),
		).toBe(0);
	});
});

describe("stepAutoscroll", () =>
{
	it("steps 0 on the first frame after a (re)start but arms haveScrolled", () =>
	{
		expect(
			stepAutoscroll(
				{
					scrollTop: 500,
					speed: -1250,
					lastFrameAt: null,
					haveScrolled: false,
				},
				1000,
			),
		).toStrictEqual(
			{
				scrollTop: 500,
				haveScrolled: true,
			},
		);
	});

	it("arms haveScrolled even when pinned at the top", () =>
	{
		expect(
			stepAutoscroll(
				{
					scrollTop: 0,
					speed: -868,
					lastFrameAt: 1000,
					haveScrolled: false,
				},
				1016,
			),
		).toStrictEqual(
			{
				scrollTop: 0,
				haveScrolled: true,
			},
		);
	});

	it("scrolls by the speed times the seconds since the last frame", () =>
	{
		const state =
		{
			scrollTop: 500,
			speed: -1250,
			lastFrameAt: 1000,
			haveScrolled: false,
		};
		expect(stepAutoscroll(state, 1100)).toStrictEqual(
			{
				scrollTop: 375,
				haveScrolled: true,
			},
		);
	});

	it("rounds a sub-pixel step to zero", () =>
	{
		expect(
			stepAutoscroll(
				{
					scrollTop: 500,
					speed: 35,
					lastFrameAt: 1000,
					haveScrolled: true,
				},
				1008,
			),
		).toStrictEqual(
			{
				scrollTop: 500,
				haveScrolled: true,
			},
		);
	});

	it("does not scroll above the top", () =>
	{
		const state =
		{
			scrollTop: 50,
			speed: -1250,
			lastFrameAt: 1000,
			haveScrolled: true,
		};
		expect(stepAutoscroll(state, 1100)).toStrictEqual(
			{
				scrollTop: 0,
				haveScrolled: true,
			},
		);
	});
});

describe("createEdgeAutoscroller", () =>
{
	function harness(initialScrollTop: number)
	{
		const frames: ((now: number) => void)[] = [];
		const scroller =
		{
			scrollTop: initialScrollTop,
		};
		let clock = 0;
		const autoscroller = createEdgeAutoscroller(
			{
				scroller:
				{
					getScrollTop: () => scroller.scrollTop,
					setScrollTop: (value) =>
					{
						scroller.scrollTop = value;
					},
					bounds: () => (
					{
						top: 0,
						height: 800,
					}),
				},
				startY: 400,
				mobile: false,
				raf: (callback) => frames.push(callback),
				cancelRaf: () =>
				{
					frames.length = 0;
				},
				now: () => clock,
				afterScroll: () =>
				{
				},
			},
		);
		const run = (at: number) =>
		{
			clock = at;
			frames.shift()?.(at);
		};
		return {
			autoscroller,
			scroller,
			frames,
			run,
		};
	}

	it("keeps scrolling with the pointer above the window until it returns", () =>
	{
		const {autoscroller, scroller, frames, run} = harness(300);
		autoscroller.update(400);
		autoscroller.update(-5);
		run(0);
		const afterFirst = scroller.scrollTop;
		run(16);
		run(116);
		expect([afterFirst, scroller.scrollTop, frames.length]).toStrictEqual([300, 155, 1]);
		autoscroller.update(400);
		run(132);
		expect(frames).toHaveLength(0);
	});

	it("cancels a pending frame on dispose", () =>
	{
		const {autoscroller, frames} = harness(300);
		autoscroller.update(-5);
		autoscroller.dispose();
		expect(frames).toHaveLength(0);
	});
});

describe("pickScroller", () =>
{
	it("returns the pointer target's scroller and whether it changed", () =>
	{
		document.body.innerHTML =
			'<div class="side-pane-scroller vertical-scrollable-container"><span id="t"></span></div>';
		const target = document.querySelector("#t")!;
		const pane = document.querySelector(".vertical-scrollable-container")!;
		const page = document.scrollingElement ?? document.documentElement;
		expect([
			pickScroller(target, page).scroller === pane,
			pickScroller(target, page).changed,
			pickScroller(target, pane).changed,
		]).toStrictEqual([true, true, false]);
	});
});
