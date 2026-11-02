import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {describe, expect, it} from "vite-plus/test";
import {cssBlock} from "./helpers/css-block.js";

const styles = readFileSync(fileURLToPath(new URL("../src/client/styles.css", import.meta.url)), "utf8");

describe("is-mobile rules ported from upstream wf-base.css", () =>
{
	it("pads and nests rows like upstream", () =>
	{
		expect(
			{
				project: cssBlock(styles, ".is-mobile .project"),
				nested: cssBlock(styles, ".is-mobile .children .children .project"),
				name: cssBlock(styles, ".is-mobile .name"),
				main: cssBlock(styles, ".is-mobile .name.name--main"),
				content: cssBlock(styles, ".is-mobile .name > .content"),
				mainContent: cssBlock(styles, ".is-mobile .name.name--main > .content"),
			},
		).toStrictEqual(
			{
				project:
				{
					"padding-top": "2px",
					"padding-bottom": "2px",
				},
				nested:
				{
					"margin-left": "14px",
				},
				name:
				{
					"padding-left": "var(--name-padding-left)",
					"font-size": "var(--name-font-size, inherit)",
					"--line-height": "1.3em",
				},
				main:
				{
					"margin-left": "0",
					"padding-left": "6px",
				},
				content:
				{
					"padding-right": "8px",
				},
				mainContent:
				{
					"padding-right": "0",
				},
			},
		);
	});

	it("sizes notes and content padding like upstream", () =>
	{
		expect(
			{
				notes: cssBlock(styles, ".is-mobile .notes"),
				notesContent: cssBlock(styles, ".is-mobile .notes > .content"),
				mainNotes: cssBlock(styles, ".is-mobile .children .notes.notes--main"),
				childNotes: cssBlock(styles, ".is-mobile .children .notes:not(.notes--main)"),
				children: cssBlock(styles, ".is-mobile .children, .is-mobile .draggableNameClone"),
				body: cssBlock(styles, "body.is-mobile"),
				tapped: cssBlock(styles, ".is-mobile .content.tapped"),
			},
		).toStrictEqual(
			{
				notes:
				{
					"margin-top": "10px",
					"padding-left": "6px",
				},
				notesContent:
				{
					"font-size": "var(--notes-font-size)",
					height: "var(--notes-line-height)",
					"line-height": "var(--notes-line-height)",
				},
				mainNotes:
				{
					"margin-left": "0",
					"padding-left": "0",
				},
				childNotes:
				{
					"margin-left": "32px",
					"padding-left": "0",
				},
				children:
				{
					"--wf-content-padding-top": "4px",
					"--wf-content-padding-bottom": "4px",
				},
				body:
				{
					"--wf-content-padding-bottom": "12px",
				},
				tapped:
				{
					background: "#eee",
				},
			},
		);
	});

	it("keeps the hover bullets visible and the header rows spaced", () =>
	{
		expect(
			{
				hoverBullet: cssBlock(styles, ".is-mobile :is(.project--bullet-on-hover > .name:hover > .bullet)"),
				codeBullet: cssBlock(styles, ".is-mobile .code-block > .name:hover > .bullet"),
				quoteBullet: cssBlock(styles, ".is-mobile .quote-block > .name:hover > .bullet"),
				headerRows: cssBlock(
					styles,
					".is-mobile .header1:not(.root) > .name, .is-mobile .header2:not(.root) > .name, .is-mobile .header3:not(.root) > .name",
				),
			},
		).toStrictEqual(
			{
				hoverBullet:
				{
					opacity: "0.5 !important",
				},
				codeBullet:
				{
					opacity: "0.5 !important",
				},
				quoteBullet:
				{
					opacity: "0.5 !important",
				},
				headerRows:
				{
					"margin-top": "var(--wf-space-s)",
					"margin-bottom": "var(--wf-space-s)",
				},
			},
		);
	});

	it("removes the desktop name overhang, which a phone row replaces with --name-padding-left", () =>
	{
		expect(cssBlock(styles, "html body.is-mobile")).toStrictEqual(
			{
				"--name-left-overhang": "0px",
				"--name-padding-left": "30px",
			},
		);
	});
});
