import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {describe, expect, it} from "vite-plus/test";
import {layoutAppliedMessage, layoutPreviewMessage, layoutWarningLevels} from "../src/client/calendar-layout-model.js";
import type {CalendarLayout} from "../src/node-types.js";
import {CalendarLayoutView} from "../src/client/components/calendar-layout-view.js";

function render(layout: CalendarLayout): string
{
	return renderToStaticMarkup(
		createElement(
			CalendarLayoutView,
			{
				layout,
				onCancel: () =>
				{
				},
				onUpdate: () =>
				{
				},
			},
		),
	);
}

/** Each checkbox's label and whether it shows checked. */
function checkboxes(html: string): [string, boolean][]
{
	return [
		...html.matchAll(
			/<div class="flex gap-m"><span class="inline-flex relative w-l h-l"><svg[^>]*data-prefix="(fad|fal)"[^>]*>.*?<\/svg><input type="checkbox" class="sr-only peer" name="calendar-layout-[a-z]+"( checked="")?\/><\/span>([^<]*)<\/div>/gu,
		),
	].map((m) => [m[3], m[1] === "fad" && Boolean(m[2])]);
}

describe("CalendarLayoutView (upstream P10)", () =>
{
	it("renders the header, the two notes, a checkbox per level above day, and Cancel / Update Layout", () =>
	{
		const html = render(
			{
				levels:
				{
					year: true,
					month: true,
					day: true,
				},
				customLevels: [],
				needsConfirm: false,
				applyEnabled: true,
			},
		);
		expect(
			{
				shell: html.startsWith(
					'<div class="flex flex-col gap-xs p-ml text-primary desktop:w-[220px]" data-calendar-layout="true">',
				),
				title: /<header class="flex justify-between gap-l items-center"><h1 class="font-medium">([^<]*)<\/h1>/u.exec(
					html,
				)?.[1],
				dateFormatIcon: html.includes('data-icon="calendar-lines-pen"'),
				notes: [...html.matchAll(/<p class="text-tertiary text-s leading-xs (mb-xs|mb-m)">([^<]*)<\/p>/gu)].map(
					(m) => [m[1], m[2]],
				),
				checkboxes: checkboxes(html),
				warning: html.includes("border-warning"),
				buttons: [
					...html.matchAll(/<button tabindex="0" class="([^"]*)"><span class="">([^<]*)<\/span><\/button>/gu),
				].map((m) => [m[1], m[2]]),
			},
		).toStrictEqual(
			{
				shell: true,
				title: "Calendar Layout",
				dateFormatIcon: true,
				notes: [
					["mb-xs", "Choose which calendar levels are shown."],
					["mb-m", "Note: Bullets with date tags will be automatically organized."],
				],
				checkboxes: [
					["Year", true],
					["Month", true],
					["Week", false],
				],
				warning: false,
				buttons: [
					[" hover:no-underline button secondary", "Cancel"],
					[" hover:no-underline button primary", "Update Layout"],
				],
			},
		);
	});

	it("warns that the custom text of an unchecked level will be deleted", () =>
	{
		const html = render(
			{
				levels:
				{
					year: true,
					day: true,
				},
				customLevels: ["year", "month"],
				needsConfirm: false,
				applyEnabled: true,
			},
		);
		expect(
			/<span class="mt-s flex gap-m text-s px-m py-s border-2 border-solid border-warning rounded-s leading-s"><svg[^>]*data-icon="triangle-exclamation"[^>]*>.*?<\/svg><p>(.*?)<\/p><\/span>/u.exec(
				html,
			)?.[1],
		).toBe("Some <strong>Month</strong> nodes include custom text or notes that will be deleted if turned off.");
	});

	it("lists the custom levels that are turned off, in level order", () =>
	{
		expect([
			layoutWarningLevels(
				["year", "month"],
				{
					year: false,
					month: false,
				},
			),
			layoutWarningLevels(
				["month"],
				{
					year: false,
					month: true,
				},
			),
		]).toStrictEqual([["year", "month"], []]);
	});

	it("summarizes a preview's steps for the not-yet-enabled Update Layout", () =>
	{
		expect([
			layoutPreviewMessage([
				{
					op: "set-calendar",
				},
				{
					op: "set-levels",
				},
				{
					op: "create",
				},
				{
					op: "move",
				},
				{
					op: "move",
				},
				{
					op: "delete",
				},
			]),
			layoutPreviewMessage([
				{
					op: "set-levels",
				},
			]),
		]).toStrictEqual([
			"Calendar Layout would move 2 nodes, create 1, delete 1 and retag 1. Applying layouts is not enabled yet.",
			"Calendar Layout would move 0 nodes, create 0, delete 0 and retag 0. Applying layouts is not enabled yet.",
		]);
	});

	it("reports an applied layout, or that it was already in place", () =>
	{
		expect([layoutAppliedMessage(5), layoutAppliedMessage(1), layoutAppliedMessage(0)]).toStrictEqual([
			"Calendar layout updated (5 changes).",
			"Calendar layout updated (1 change).",
			"Calendar layout already up to date.",
		]);
	});
});
