import {TAG_COLORS} from "./tag-colors.js";
import type {TagColorName} from "./tag-colors.js";

export type ColorName = TagColorName;

/** Upstream's popup display order: red, orange, yellow, green, teal, sky, blue, purple, pink, gray. */
export const COLOR_ORDER = TAG_COLORS;

/** Upstream's numeric color values (`Xn`), as stored in the account's `latestColor`. */
export const COLOR_VALUE: Readonly<Record<ColorName, number>> =
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

/** Upstream's `_y4`: the 2 (light background), 4 (dark text), 6 (light text) and 8 (dark background) shades per color. */
const PALETTE_HEX: Readonly<Record<ColorName, Readonly<Record<2 | 4 | 6 | 8, string>>>> =
{
	red:
	{
		2: "#FBD5D5",
		4: "#F98080",
		6: "#E02424",
		8: "#773B3B",
	},
	orange:
	{
		2: "#FCD9BD",
		4: "#FF8A4C",
		6: "#D03801",
		8: "#784C3C",
	},
	yellow:
	{
		2: "#FCE96A",
		4: "#E3A008",
		6: "#9F580A",
		8: "#8C7146",
	},
	green:
	{
		2: "#BCF0DA",
		4: "#31C48D",
		6: "#057A55",
		8: "#40806B",
	},
	teal:
	{
		2: "#BCF0F0",
		4: "#2DD4BF",
		6: "#108190",
		8: "#397886",
	},
	sky:
	{
		2: "#BAE6FD",
		4: "#38BDF8",
		6: "#007AB8",
		8: "#496B92",
	},
	blue:
	{
		2: "#C3DDFD",
		4: "#76A9FA",
		6: "#1C64F2",
		8: "#405580",
	},
	purple:
	{
		2: "#DCD7FE",
		4: "#AC94FA",
		6: "#7E3AF2",
		8: "#584080",
	},
	pink:
	{
		2: "#FBD7FE",
		4: "#F472B6",
		6: "#D60BC1",
		8: "#7F4080",
	},
	gray:
	{
		2: "#E2E8F0",
		4: "#97A6BA",
		6: "#64748B",
		8: "#475569",
	},
};

const BY_HEX = new Map<string, ColorName>(
	COLOR_ORDER.flatMap((color) => Object.values(PALETTE_HEX[color]).map((hex) => [hex.toLowerCase(), color] as const)),
);

function toHex(value: string): string | undefined
{
	const text = value.trim().toLowerCase();
	if (/^#[0-9a-f]{6}$/u.test(text))
	{
		return text;
	}
	const rgb = /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/u.exec(text);
	if (rgb === null)
	{
		return undefined;
	}
	const channels = rgb.slice(1, 4).map(Number);
	if (channels.some((channel) => channel > 255))
	{
		return undefined;
	}
	return `#${channels.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

/** The palette color whose exact shade `rgb(r, g, b)` or `#rrggbb` is, case-insensitively. */
export function colorFromCss(value: string): ColorName | undefined
{
	const hex = toHex(value);
	return hex === undefined ? undefined : BY_HEX.get(hex);
}

/** Whether `value` is one of the ten palette color names. */
export function isColorName(value: unknown): value is ColorName
{
	return COLOR_ORDER.some((color) => color === value);
}
