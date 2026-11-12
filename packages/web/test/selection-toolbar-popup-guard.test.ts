// @vitest-environment happy-dom
import {afterEach, describe, expect, it} from "vite-plus/test";
import {otherPopupOpen} from "../src/client/hooks/use-selection-toolbar.js";
import {pop, resetPopupsForTests} from "../src/client/popups.js";

afterEach(() =>
{
	for (const element of document.body.querySelectorAll(".hidden"))
	{
		element.remove();
	}
	resetPopupsForTests();
});

describe("otherPopupOpen", () =>
{
	it("ignores the always-mounted hidden search-helpers flyout", () =>
	{
		const hidden = document.createElement("div");
		hidden.className = "hidden";
		hidden.innerHTML = '<div class="flyout menu"></div>';
		document.body.append(hidden);
		expect(otherPopupOpen("CTX_MENU_POPUP", () => false)).toBe(false);
	});

	it("counts another registered popup but not the toolbar itself", () =>
	{
		pop("CTX_MENU_POPUP");
		const self = otherPopupOpen("CTX_MENU_POPUP", () => false);
		pop("TAG_COLORS_POPUP");
		expect(
			{
				self,
				other: otherPopupOpen("CTX_MENU_POPUP", () => false),
			},
		).toStrictEqual(
			{
				self: false,
				other: true,
			},
		);
	});

	it("counts an open modal", () =>
	{
		expect(otherPopupOpen("CTX_MENU_POPUP", () => true)).toBe(true);
	});
});
