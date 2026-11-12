import {describe, expect, it} from "vite-plus/test";
import {BUTTON_MENU_Z, POPUP_Z, popoverBox} from "../src/client/components/flyout/popover-box.js";

const WF_MENU_CLASS_NAME = `wf-menu flex flex-col
      border border-solid border-primary font-normal text-xs
      rounded-md bg-primary shadow-md
      overflow-x-hidden
      [transition:200ms_opacity]
      print:hidden`;

describe("popoverBox", () =>
{
	it("returns the upstream wf-menu surface style and class string", () =>
	{
		expect(
			popoverBox(
				{
					minWidth: 0,
					maxWidth: 240,
					offset: [0, 0],
				},
			),
		).toStrictEqual(
			{
				style:
				{
					pointerEvents: "auto",
					zIndex: 300,
					minWidth: 0,
					maxWidth: 240,
					marginTop: 4,
				},
				className: WF_MENU_CLASS_NAME,
			},
		);
	});

	it("ignores the horizontal offset like upstream", () =>
	{
		expect(
			popoverBox(
				{
					minWidth: 100,
					maxWidth: 240,
					offset: [-8, 0],
				},
			),
		).toStrictEqual(
			{
				style:
				{
					pointerEvents: "auto",
					zIndex: 300,
					minWidth: 100,
					maxWidth: 240,
					marginTop: 4,
				},
				className: WF_MENU_CLASS_NAME,
			},
		);
	});

	it("uses the given surface name and omits marginTop without an offset", () =>
	{
		expect(
			popoverBox(
				{
					surfaceName: "x",
				},
			),
		).toStrictEqual(
			{
				style:
				{
					pointerEvents: "auto",
					zIndex: 300,
					minWidth: undefined,
					maxWidth: undefined,
				},
				className: WF_MENU_CLASS_NAME.replace(/^wf-menu /u, "x "),
			},
		);
	});

	it("defaults to the wf-menu surface with no arguments", () =>
	{
		expect(popoverBox().className).toBe(WF_MENU_CLASS_NAME);
	});
});

describe("z-index levels", () =>
{
	it("matches upstream popup and button-menu levels", () =>
	{
		expect(
			{
				POPUP_Z,
				BUTTON_MENU_Z,
			},
		).toStrictEqual(
			{
				POPUP_Z: 300,
				BUTTON_MENU_Z: 1001,
			},
		);
	});
});
