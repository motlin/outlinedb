import {describe, expect, it, vi} from "vite-plus/test";
import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {IconButton, iconButtonKeyDown} from "../src/client/components/icon-button.js";
import {cssBlock, hasSelector} from "./helpers/css-block.js";

const styles = readFileSync(fileURLToPath(new URL("../src/client/styles.css", import.meta.url)), "utf8");

function fakeEvent(key: string)
{
	return {
		key,
		preventDefault: vi.fn<() => void>(),
		stopPropagation: vi.fn<() => void>(),
		currentTarget:
		{
			click: vi.fn<() => void>(),
		},
	};
}

function callCounts(event: ReturnType<typeof fakeEvent>)
{
	return {
		click: event.currentTarget.click.mock.calls.length,
		preventDefault: event.preventDefault.mock.calls.length,
		stopPropagation: event.stopPropagation.mock.calls.length,
	};
}

describe("IconButton markup", () =>
{
	it("renders upstream's default lg circle div button", () =>
	{
		expect(renderToStaticMarkup(createElement(IconButton, {}, "x"))).toBe(
			'<div role="button" tabindex="0" class="iconButton lg shape-circle">x</div>',
		);
	});

	it("renders disabled state without a tooltip and passes rest props before className", () =>
	{
		expect(
			renderToStaticMarkup(
				createElement(
					IconButton,
					{
						disabled: true,
						tooltip: "Back",
						"data-handbook": "nav.back",
					},
					"x",
				),
			),
		).toBe(
			'<div role="button" tabindex="-1" aria-disabled="true" data-handbook="nav.back" class="iconButton lg shape-circle disabled">x</div>',
		);
	});

	it("prepends a custom className", () =>
	{
		expect(
			renderToStaticMarkup(
				createElement(
					IconButton,
					{
						className: "starring-star",
					},
					"x",
				),
			).match(/class="([^"]*)"/u)?.[1],
		).toBe("starring-star iconButton lg shape-circle");
	});
});

describe("iconButtonKeyDown", () =>
{
	it.each(["Enter", " "])("activates on %j", (key) =>
	{
		const event = fakeEvent(key);
		iconButtonKeyDown(event, false);
		expect(callCounts(event)).toStrictEqual(
			{
				click: 1,
				preventDefault: 1,
				stopPropagation: 1,
			},
		);
	});

	it("ignores other keys", () =>
	{
		const event = fakeEvent("a");
		iconButtonKeyDown(event, false);
		expect(callCounts(event)).toStrictEqual(
			{
				click: 0,
				preventDefault: 0,
				stopPropagation: 0,
			},
		);
	});

	it("ignores Enter when disabled", () =>
	{
		const event = fakeEvent("Enter");
		iconButtonKeyDown(event, true);
		expect(callCounts(event)).toStrictEqual(
			{
				click: 0,
				preventDefault: 0,
				stopPropagation: 0,
			},
		);
	});
});

describe("iconButton CSS", () =>
{
	it("uses upstream's base .iconButton rule verbatim", () =>
	{
		expect(cssBlock(styles, ".iconButton")).toStrictEqual(
			{
				"border-radius": "var(--wf-radius-circle)",
				display: "flex",
				"align-items": "center",
				"justify-content": "center",
				color: "var(--wf-text-tertiary)",
				"pointer-events": "auto",
				"flex-shrink": "0",
				cursor: "pointer",
			},
		);
	});

	it("uses upstream's disabled rule", () =>
	{
		expect(cssBlock(styles, ".iconButton.disabled")).toStrictEqual(
			{
				"pointer-events": "none",
				opacity: "0.7",
			},
		);
	});

	it.each([
		["sm", "18px"],
		["ms", "20px"],
		["md", "24px"],
		["ml", "30px"],
		["lg", "36px"],
		["xl", "42px"],
	])("sizes .iconButton.%s to %s square", (size, px) =>
	{
		expect(cssBlock(styles, `.iconButton.${size}`)).toStrictEqual(
			{
				width: px,
				height: px,
			},
		);
	});

	it("drops the old local hover rule", () =>
	{
		expect(hasSelector(styles, /\.iconButton:hover:not\(:disabled\)/u)).toBe(false);
	});
});
