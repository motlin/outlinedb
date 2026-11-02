import {describe, expect, it} from "vite-plus/test";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {Flyout} from "../src/client/components/flyout/flyout.js";
import {FlyoutAlign, bottomShift, flyoutStyle} from "../src/client/components/flyout/flyout-style.js";

describe("flyoutStyle", () =>
{
	it("anchors a Left-aligned flyout at offset[0] below its parent", () =>
	{
		expect(
			flyoutStyle(
				{
					align: FlyoutAlign.Left,
				},
			),
		).toStrictEqual(
			{
				maxHeight: undefined,
				left: 0,
				top: "100%",
				transform: "scale(1, 1) translateX(0)",
				transformOrigin: "10% 0",
				opacity: 1,
			},
		);
	});

	it("centers by default, shifting by offset[0] through marginLeft", () =>
	{
		expect(
			flyoutStyle(
				{
					offset: [12, 0],
				},
			),
		).toStrictEqual(
			{
				maxHeight: undefined,
				left: "50%",
				top: "100%",
				marginLeft: 12,
				transform: "scale(1, 1) translateX(-50%)",
				transformOrigin: "0 0",
				opacity: 1,
			},
		);
	});

	it("uses an explicit position with None alignment and a 90% origin", () =>
	{
		expect(
			flyoutStyle(
				{
					position: [30, 40],
					align: FlyoutAlign.None,
				},
			),
		).toStrictEqual(
			{
				maxHeight: undefined,
				left: 30,
				top: 40,
				transform: "scale(1, 1) translateX(0)",
				transformOrigin: "90% 0",
				opacity: 1,
			},
		);
	});

	it("appends the bottom-overflow translate and scrolls when maxHeight is set", () =>
	{
		expect(
			flyoutStyle(
				{
					maxHeight: 300,
					shiftY: -50,
				},
			),
		).toStrictEqual(
			{
				maxHeight: 300,
				overflowY: "auto",
				left: "50%",
				top: "100%",
				marginLeft: 0,
				transform: "scale(1, 1) translateX(-50%) translate(0px, -50px)",
				transformOrigin: "0 0",
				opacity: 1,
			},
		);
	});

	it("applies the rounded and dense overrides and hides when collapsed", () =>
	{
		expect(
			flyoutStyle(
				{
					align: FlyoutAlign.Left,
					rounded: true,
					dense: true,
					expanded: false,
				},
			),
		).toStrictEqual(
			{
				maxHeight: undefined,
				left: 0,
				top: "100%",
				transform: "scale(1, 1) translateX(0)",
				transformOrigin: "10% 0",
				borderTop: "none",
				margin: "0",
				boxShadow: "none",
				borderRadius: "0 0 16px 16px",
				boxSizing: "border-box",
				paddingTop: 0,
				paddingBottom: 0,
				pointerEvents: "none",
				opacity: 0,
			},
		);
	});
});

describe("bottomShift", () =>
{
	it("lifts a flyout that overflows the viewport bottom to 10px inside it", () =>
	{
		expect(
			bottomShift(
				{
					top: 700,
					bottom: 900,
				},
				860,
			),
		).toBe(-50);
	});

	it("clamps a too-tall flyout so its top lands at 10", () =>
	{
		const shift = bottomShift(
			{
				top: 20,
				bottom: 1000,
			},
			860,
		);
		expect(
			{
				shift,
				top: 20 + shift,
			},
		).toStrictEqual(
			{
				shift: -10,
				top: 10,
			},
		);
	});

	it("does not shift a flyout that fits", () =>
	{
		expect(
			bottomShift(
				{
					top: 100,
					bottom: 500,
				},
				860,
			),
		).toBe(0);
	});
});

describe("Flyout", () =>
{
	it("renders the popoverBox surface with absolute flyout classes and z-index 300", () =>
	{
		expect(
			renderToStaticMarkup(
				createElement(
					Flyout,
					{
						align: FlyoutAlign.Left,
						className: "x",
					},
					"body",
				),
			),
		).toBe(
			`<div style="pointer-events:auto;z-index:300;max-width:240px;margin-top:4px;left:0;top:100%;transform:scale(1, 1) translateX(0);transform-origin:10% 0;opacity:1" class="wf-menu flex flex-col
      border border-solid border-primary font-normal text-xs
      rounded-md bg-primary shadow-md
      overflow-x-hidden
      [transition:200ms_opacity]
      print:hidden absolute flyout x">body</div>`,
		);
	});

	it("renders nothing when collapsed on mount", () =>
	{
		expect(
			renderToStaticMarkup(
				createElement(
					Flyout,
					{
						expanded: false,
					},
					"body",
				),
			),
		).toBe("");
	});
});
