import {describe, expect, it} from "vite-plus/test";
import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {TooltipBox, createTooltipController, tooltipPosition} from "../src/client/components/tooltip.js";
import {cssBlock, hasSelector} from "./helpers/css-block.js";

const styles = readFileSync(fileURLToPath(new URL("../src/client/styles.css", import.meta.url)), "utf8");

describe("TooltipBox", () =>
{
	it("renders upstream's tippy box with content and shortcut as one text node", () =>
	{
		expect(
			renderToStaticMarkup(
				createElement(
					TooltipBox,
					{
						content: "Today",
						shortcut: "⌃T",
						state: "visible",
					},
				),
			),
		).toBe(
			'<div class="tippy-box wf-helper tooltip text-xs shadow-md undefined" data-state="visible" tabindex="-1" data-animation="fade" role="tooltip" style="max-width:350px;transition-duration:300ms" data-placement="bottom"><div class="tippy-content" data-state="visible" style="transition-duration:300ms"><div>Today ⌃T</div></div><div class="tippy-arrow" style="position:absolute;left:0;transform:translate3d(0px, 0px, 0px)"></div></div>',
		);
	});

	it("omits the shortcut suffix when there is none", () =>
	{
		expect(
			renderToStaticMarkup(
				createElement(
					TooltipBox,
					{
						content: "Present",
						state: "hidden",
					},
				),
			),
		).toBe(
			'<div class="tippy-box wf-helper tooltip text-xs shadow-md undefined" data-state="hidden" tabindex="-1" data-animation="fade" role="tooltip" style="max-width:350px;transition-duration:300ms" data-placement="bottom"><div class="tippy-content" data-state="hidden" style="transition-duration:300ms"><div>Present</div></div><div class="tippy-arrow" style="position:absolute;left:0;transform:translate3d(0px, 0px, 0px)"></div></div>',
		);
	});
});

function tooltipHarness(canShow = true)
{
	let now = 0;
	let timers:
	{
		id: number;
		at: number;
		fn: () => void;
	}[] = [];
	let nextId = 1;
	const shown: boolean[] = [];
	const controller = createTooltipController(
		{
			delay: 300,
			setTimeout: (fn, ms) =>
			{
				const id = nextId++;
				timers.push(
					{
						id,
						at: now + ms,
						fn,
					},
				);
				return id;
			},
			clearTimeout: (id) =>
			{
				timers = timers.filter((timer) => timer.id !== id);
			},
			onChange: (visible) =>
			{
				shown.push(visible);
			},
		},
	);
	return {
		enter: () =>
		{
			controller.enter(canShow);
		},
		leave: () =>
		{
			controller.leave();
		},
		shown,
		advance(ms: number)
		{
			now += ms;
			const due = timers.filter((timer) => timer.at <= now);
			timers = timers.filter((timer) => timer.at > now);
			for (const timer of due)
			{
				timer.fn();
			}
		},
	};
}

describe("createTooltipController (IconButton hover)", () =>
{
	it("shows the tippy box 300ms after hover, not before, and hides on leave", () =>
	{
		const h = tooltipHarness();
		h.enter();
		h.advance(299);
		const before = [...h.shown];
		h.advance(1);
		const after = [...h.shown];
		h.leave();
		expect(
			{
				before,
				after,
				left: h.shown,
			},
		).toStrictEqual(
			{
				before: [],
				after: [true],
				left: [true, false],
			},
		);
	});

	it("never shows when leaving before the delay", () =>
	{
		const h = tooltipHarness();
		h.enter();
		h.advance(200);
		h.leave();
		h.advance(500);
		expect(h.shown).toStrictEqual([false]);
	});

	it("never shows when disabled or without a fine hover pointer", () =>
	{
		const h = tooltipHarness(false);
		h.enter();
		h.advance(1000);
		expect(h.shown).toStrictEqual([]);
	});
});

describe("tooltipPosition", () =>
{
	it("centers the box 10px below the trigger", () =>
	{
		expect(
			tooltipPosition(
				{
					left: 971,
					width: 36,
					bottom: 42,
				},
				60,
				1272,
			),
		).toStrictEqual(
			{
				top: 52,
				left: 989,
			},
		);
	});

	it("clamps to the left viewport edge", () =>
	{
		expect(
			tooltipPosition(
				{
					left: 0,
					width: 36,
					bottom: 42,
				},
				100,
				1272,
			),
		).toStrictEqual(
			{
				top: 52,
				left: 58,
			},
		);
	});

	it("clamps to the right viewport edge", () =>
	{
		expect(
			tooltipPosition(
				{
					left: 1250,
					width: 20,
					bottom: 42,
				},
				100,
				1272,
			),
		).toStrictEqual(
			{
				top: 52,
				left: 1214,
			},
		);
	});
});

describe("tooltip CSS", () =>
{
	it("uses upstream's .tooltip rule verbatim", () =>
	{
		expect(cssBlock(styles, ".tooltip")).toStrictEqual(
			{
				padding: "var(--wf-space-s) var(--wf-space-m)",
				"border-radius": "var(--wf-radius-s)",
				background: "var(--wf-background-primary)",
			},
		);
	});

	it("defines local tippy basics", () =>
	{
		expect(cssBlock(styles, ".tippy-box")).toStrictEqual(
			{
				position: "relative",
				color: "var(--wf-text-primary)",
				"white-space": "nowrap",
				"transition-property": "opacity",
			},
		);
		expect(cssBlock(styles, '.tippy-box[data-state="hidden"]')).toStrictEqual(
			{
				opacity: "0",
			},
		);
	});

	it("drops the old arrow, shortcut, content, and trigger rules", () =>
	{
		expect(hasSelector(styles, /\.tooltip-(arrow|shortcut|content|trigger)\b/u)).toBe(false);
	});
});
