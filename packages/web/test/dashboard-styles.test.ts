import {describe, expect, it} from "vite-plus/test";
import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {cssBlock} from "./helpers/css-block.js";

const styles = readFileSync(fileURLToPath(new URL("../src/client/styles.css", import.meta.url)), "utf8");

describe("dashboard-layout CSS (upstream wf-base)", () =>
{
	it("sizes a card like upstream", () =>
	{
		const card = cssBlock(styles, ".is-desktop .dashboard-card");
		expect(card["flex-basis"]).toBe("343px");
		expect(card["max-width"]).toBe("500px");
		expect(card.height).toBe("298px");
		expect(card["border-radius"]).toBe("6px");
		expect(card["box-shadow"]).toBe("0 4px 4px #0000000f");
	});

	it("lays children out as a wrapping grid", () =>
	{
		const grid = cssBlock(styles, ".is-desktop .dashboard > .children");
		expect(grid.display).toBe("flex");
		expect(grid.gap).toBe("24px");
		expect(grid["flex-wrap"]).toBe("wrap");
	});

	it("hides card controls until hover and moves them right", () =>
	{
		expect(
			cssBlock(
				styles,
				".is-desktop .show-controls-on-hover > .name > .bullet, .is-desktop .show-controls-on-hover > .name > .expand, .is-desktop .show-controls-on-hover > .name > .itemMenu",
			).opacity,
		).toBe("0");
		expect(cssBlock(styles, ".is-desktop .dashboard-card > .name > .bullet").left).toBe(
			"calc(100% - 60px) !important",
		);
		expect(cssBlock(styles, ".is-desktop .dashboard-card > .name > .itemMenu").left).toBe(
			"calc(100% - 32px) !important",
		);
	});

	it("keeps upstream's quirks verbatim", () =>
	{
		expect(cssBlock(styles, ".is-desktop .dashboard-card > .name")["line-height"]).toBe("26");
		expect(cssBlock(styles, ".dashboard-add-button-bottom").color).toBe("var(--text-secondary)");
	});

	it("widens the dashboard page", () =>
	{
		const page = cssBlock(styles, ".is-desktop .page.dashboard-page");
		expect(page["max-width"]).toBe("none !important");
		expect(page["padding-left"]).toBe("var(--wf-space-3xl)");
	});
});
