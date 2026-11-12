/**
 * Tag colors stored in upstream's root (Home) metadata, through the internal API when there is one (so they match
 * workflowy.com) and in the local tables otherwise: `color.tags[<lowercased tag incl. #/@>] = <color index>`.
 */

import {z} from "zod";
import {withAccountState} from "../account-state.js";
import {TAG_COLORS} from "../../tag-colors.js";
import type {TagColorName} from "../../tag-colors.js";
import {defineOp, ok} from "./define.js";

/** Upstream's color enum (`red=0 ... pink=9`); `-1` means "no color". */
const COLOR_INDEX: Record<TagColorName, number> =
{
	red: 0,
	orange: 1,
	yellow: 2,
	green: 3,
	blue: 4,
	purple: 5,
	gray: 6,
	teal: 7,
	sky: 8,
	pink: 9,
};

const COLOR_BY_INDEX = new Map<unknown, string>(Object.entries(COLOR_INDEX).map(([color, index]) => [index, color]));

const TAGS_PATH = ["color", "tags"];

function tagPath(name: string): string[]
{
	return [...TAGS_PATH, name.toLowerCase()];
}

/** `{colors: {name: color}}`, skipping indexes outside the palette. */
export const TagColorsResponseSchema = z.strictObject(
	{
		colors: z.record(z.string(), z.string()),
	},
);

export const tagsList = defineOp(
	{
		input: z.object({}),
		output: TagColorsResponseSchema,
		async run(ctx)
		{
			return withAccountState(ctx, async (state) =>
			{
				const stored = await state.getRootMeta(TAGS_PATH);
				const colors: Record<string, string> = {};
				if (typeof stored === "object" && stored !== null)
				{
					for (const [name, index] of Object.entries(stored))
					{
						const color = COLOR_BY_INDEX.get(index);
						if (color)
						{
							colors[name] = color;
						}
					}
				}
				return ok(
					{
						colors,
					},
				);
			});
		},
	},
);

/** Sets one tag's color. */
export const tagsSet = defineOp(
	{
		input: z.object(
			{
				name: z.string(),
				color: z.enum(TAG_COLORS),
			},
		),
		output: z.strictObject(
			{
				name: z.string(),
				color: z.enum(TAG_COLORS),
			},
		),
		async run(ctx, {name, color})
		{
			return withAccountState(ctx, async (state) =>
			{
				await state.setRootMeta(tagPath(name), COLOR_INDEX[color]);
				return ok(
					{
						name,
						color,
					},
				);
			});
		},
	},
);

/** Clears one tag's color. */
export const tagsClear = defineOp(
	{
		input: z.object(
			{
				name: z.string(),
			},
		),
		output: z.strictObject(
			{
				name: z.string(),
			},
		),
		async run(ctx, {name})
		{
			return withAccountState(ctx, async (state) =>
			{
				await state.setRootMeta(tagPath(name), undefined);
				return ok(
					{
						name,
					},
				);
			});
		},
	},
);
