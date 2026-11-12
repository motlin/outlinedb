import {describe, expect, it} from "vite-plus/test";
import
{
	placePopper,
	placeSideMenu,
	popperTransform,
	popperViewport,
} from "../src/client/components/flyout/place-popper.js";

describe("placePopper", () =>
{
	it("centers a bottom popper under the breadcrumb reference", () =>
	{
		expect(
			placePopper(
				{
					reference:
					{
						left: 526.37,
						top: 12,
						width: 24,
						height: 24,
					},
					popper:
					{
						width: 252,
						height: 60.28,
					},
					placement: "bottom",
					viewport:
					{
						width: 1680,
						height: 860,
					},
				},
			),
		).toStrictEqual(
			{
				x: 412.37,
				y: 36,
				placement: "bottom",
			},
		);
	});

	it("clamps x to 10px from the right viewport edge", () =>
	{
		expect(
			placePopper(
				{
					reference:
					{
						left: 1240,
						top: 12,
						width: 24,
						height: 24,
					},
					popper:
					{
						width: 183.66,
						height: 40,
					},
					placement: "bottom",
					viewport:
					{
						width: 1272,
						height: 860,
					},
				},
			),
		).toStrictEqual(
			{
				x: 1272 - 10 - 183.66,
				y: 36,
				placement: "bottom",
			},
		);
	});

	it("clamps x to 10px from the left viewport edge", () =>
	{
		expect(
			placePopper(
				{
					reference:
					{
						left: 0,
						top: 100,
						width: 20,
						height: 20,
					},
					popper:
					{
						width: 200,
						height: 40,
					},
					placement: "bottom",
					viewport:
					{
						width: 1000,
						height: 800,
					},
				},
			),
		).toStrictEqual(
			{
				x: 10,
				y: 120,
				placement: "bottom",
			},
		);
	});

	it("aligns left edges for bottom-start", () =>
	{
		expect(
			placePopper(
				{
					reference:
					{
						left: 300,
						top: 100,
						width: 24,
						height: 28,
					},
					popper:
					{
						width: 260,
						height: 200,
					},
					placement: "bottom-start",
					viewport:
					{
						width: 1000,
						height: 800,
					},
				},
			),
		).toStrictEqual(
			{
				x: 300,
				y: 128,
				placement: "bottom-start",
			},
		);
	});

	// Measured read-only on workflowy.com (2026-10-18) in a 386x697 window: the bullet "..." menu
	// (bottom-start, margin-top 4px) rendered translate3d(37px, 28px) with visual top 32 for both a row
	// near the bottom and a row near the top. 28 = 697 - 10 - 659: popper ignores the CSS margin.
	it("pins the upstream bullet menu opened from a row near the bottom of the window", () =>
	{
		expect(
			placePopper(
				{
					reference:
					{
						left: 37,
						top: 602.1875,
						width: 24,
						height: 28,
					},
					popper:
					{
						width: 263.4140625,
						height: 659,
					},
					placement: "bottom-start",
					viewport:
					{
						width: 386,
						height: 697,
					},
				},
			),
		).toStrictEqual(
			{
				x: 37,
				y: 28,
				placement: "bottom-start",
			},
		);
	});

	it("pins the upstream bullet menu opened from a row near the top of the window", () =>
	{
		expect(
			placePopper(
				{
					reference:
					{
						left: 37,
						top: 154,
						width: 24,
						height: 28,
					},
					popper:
					{
						width: 255.1953125,
						height: 659,
					},
					placement: "bottom-start",
					viewport:
					{
						width: 386,
						height: 697,
					},
				},
			),
		).toStrictEqual(
			{
				x: 37,
				y: 28,
				placement: "bottom-start",
			},
		);
	});

	it("pins to the top padding when the popper is taller than the padded viewport", () =>
	{
		expect(
			placePopper(
				{
					reference:
					{
						left: 37,
						top: 400,
						width: 24,
						height: 28,
					},
					popper:
					{
						width: 250,
						height: 900,
					},
					placement: "bottom-start",
					viewport:
					{
						width: 1000,
						height: 800,
					},
				},
			),
		).toStrictEqual(
			{
				x: 37,
				y: 10,
				placement: "bottom-start",
			},
		);
	});

	it("pushes the popper down to the top padding when the reference is scrolled above the viewport", () =>
	{
		expect(
			placePopper(
				{
					reference:
					{
						left: 37,
						top: -100,
						width: 24,
						height: 28,
					},
					popper:
					{
						width: 250,
						height: 100,
					},
					placement: "bottom-start",
					viewport:
					{
						width: 1000,
						height: 800,
					},
				},
			),
		).toStrictEqual(
			{
				x: 37,
				y: 10,
				placement: "bottom-start",
			},
		);
	});
});

describe("popperTransform", () =>
{
	it("rounds to device pixels and uses the 2d form at dpr 1, translate3d above it", () =>
	{
		expect([
			popperTransform(285.84, 36, 1),
			popperTransform(412.37, 36, 2),
			popperTransform(39.7, 0.2, 1),
			popperTransform(-0.2, 0, 1),
		]).toStrictEqual([
			"translate(286px, 36px)",
			"translate3d(412.5px, 36px, 0px)",
			"translate(40px, 0px)",
			"translate(0px, 0px)",
		]);
	});
});

describe("popperViewport", () =>
{
	it("reads the root client box, which excludes a scrollbar", () =>
	{
		expect(
			popperViewport(
				{
					documentElement:
					{
						clientWidth: 1265,
						clientHeight: 860,
					},
				},
			),
		).toStrictEqual(
			{
				width: 1265,
				height: 860,
			},
		);
	});
});

describe("main menu right clamp", () =>
{
	it("clamps against the clipping width (1265) rather than innerWidth (1272)", () =>
	{
		expect(
			placePopper(
				{
					reference:
					{
						left: 1170,
						top: 12,
						width: 24,
						height: 24,
					},
					popper:
					{
						width: 183.66,
						height: 40,
					},
					placement: "bottom",
					viewport: popperViewport(
						{
							documentElement:
							{
								clientWidth: 1265,
								clientHeight: 860,
							},
						},
					),
				},
			).x,
		).toBe(1071.34);
	});
});

describe("placeSideMenu", () =>
{
	const anchor = (right: number, top: number) => (
	{
		left: 0,
		right,
		top,
		bottom: top + 27,
	});

	it("flips to left-start when right-start would overflow and pins y inside the viewport", () =>
	{
		expect(
			placeSideMenu(
				{
					anchor: anchor(1120, 168),
					popper:
					{
						width: 194,
						height: 752,
					},
					viewport:
					{
						width: 1272,
						height: 800,
					},
				},
			),
		).toStrictEqual(
			{
				placement: "left-start",
				x: 918,
				y: 38,
				referenceHidden: false,
				style:
				{
					inset: "0px 0px auto auto",
					transform: "translate(-160px, 38px)",
				},
			},
		);
	});

	it("keeps an unclamped y on a tall viewport", () =>
	{
		expect(
			placeSideMenu(
				{
					anchor: anchor(1448, 140),
					popper:
					{
						width: 187,
						height: 821,
					},
					viewport:
					{
						width: 1600,
						height: 1400,
					},
				},
			),
		).toStrictEqual(
			{
				placement: "left-start",
				x: 1253,
				y: 140,
				referenceHidden: false,
				style:
				{
					inset: "0px 0px auto auto",
					transform: "translate(-160px, 140px)",
				},
			},
		);
	});

	it("stays right-start when it fits", () =>
	{
		expect(
			placeSideMenu(
				{
					anchor: anchor(600, 100),
					popper:
					{
						width: 194,
						height: 300,
					},
					viewport:
					{
						width: 1272,
						height: 800,
					},
				},
			),
		).toStrictEqual(
			{
				placement: "right-start",
				x: 608,
				y: 100,
				referenceHidden: false,
				style:
				{
					inset: "0px auto auto 0px",
					transform: "translate(608px, 100px)",
				},
			},
		);
	});

	it("keeps right-start and clamps x when neither side fits", () =>
	{
		expect(
			placeSideMenu(
				{
					anchor: anchor(150, 100),
					popper:
					{
						width: 300,
						height: 300,
					},
					viewport:
					{
						width: 320,
						height: 800,
					},
				},
			),
		).toStrictEqual(
			{
				placement: "right-start",
				x: 10,
				y: 100,
				referenceHidden: false,
				style:
				{
					inset: "0px auto auto 0px",
					transform: "translate(10px, 100px)",
				},
			},
		);
	});

	it("reports the reference hidden once the anchor row leaves the viewport", () =>
	{
		expect(
			placeSideMenu(
				{
					anchor:
					{
						left: 0,
						right: 600,
						top: -50,
						bottom: -23,
					},
					popper:
					{
						width: 194,
						height: 300,
					},
					viewport:
					{
						width: 1272,
						height: 800,
					},
				},
			),
		).toStrictEqual(
			{
				placement: "right-start",
				x: 608,
				y: 10,
				referenceHidden: true,
				style:
				{
					inset: "0px auto auto 0px",
					transform: "translate(608px, 10px)",
				},
			},
		);
	});
});
