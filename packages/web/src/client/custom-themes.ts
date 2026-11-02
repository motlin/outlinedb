/**
 * Upstream's themes grammar (`C70`): `Themes > [theme] > [surface] > [property] > [hex]` nodes become themes listed in
 * Settings, each compiled into one constructable stylesheet of `._theme-<key>` custom-property rules.
 */

import type {CustomNode} from "./keys/custom-hotkeys.js";

const SUFFIXES = [
	"primary",
	"secondary",
	"tertiary",
	"quaternary",
	"quinary",
	"on-color",
	"tint",
	"danger",
	"warning",
	"success",
	"info",
	"spark",
	"selected",
	"shared",
	"found",
	"ambient",
	"mentioned",
	"added",
	"moved",
	"completed",
	"edited",
	"red",
	"orange",
	"yellow",
	"green",
	"blue",
	"purple",
	"gray",
	"teal",
	"sky",
	"pink",
];

/** The 124 property names a theme node may set. */
export const THEME_PROPS: ReadonlySet<string> = new Set(
	["background", "text", "border", "image"].flatMap((prefix) => SUFFIXES.map((suffix) => `${prefix}-${suffix}`)),
);

const THEME_SURFACES = ["main", "menu", "header", "left-bar", "dialog"] as const;
const SURFACE_NAMES: ReadonlySet<string> = new Set(THEME_SURFACES);

export interface CustomTheme
{
	name: string;
	prettyName: string;
	free: true;
}

export function isValidThemeName(name: string): boolean
{
	return /^[\w -]{1,100}$/u.test(name);
}

export function isValidHex(value: string): boolean
{
	return /^#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/iu.test(value);
}

type Props = Map<string, string>;

function surfaceProps(surface: CustomNode): Props
{
	const props: Props = new Map();
	for (const property of surface.children)
	{
		const [value] = property.children;
		if (property.completed || !THEME_PROPS.has(property.name) || value === undefined || !isValidHex(value.name))
		{
			continue;
		}
		props.set(property.name, value.name);
	}
	return props;
}

function block(selector: string, props: Props): string
{
	return `${selector} {\n${[...props].map(([prop, hex]) => `  --wf-${prop}: ${hex};\n`).join("")}}\n`;
}

/** Upstream's `x70`: the stylesheet text of one theme. */
function themeCss(cls: string, main: Props, surfaces: ReadonlyMap<string, Props>): string
{
	let css = block(`._theme-${cls}`, main);
	for (const surface of THEME_SURFACES)
	{
		const props = surfaces.get(surface);
		if (surface !== "main" && props !== undefined && props.size > 0)
		{
			css += block(`._theme-${cls} .wf-${surface}`, props);
		}
	}
	return css;
}

export function parseCustomThemes(themesNodes: readonly CustomNode[]):
{
	themes: Record<string, CustomTheme>;
	css: Record<string, string>;
}
{
	const themes: Record<string, CustomTheme> = {};
	const css: Record<string, string> = {};
	for (const themesNode of themesNodes)
	{
		for (const theme of themesNode.children)
		{
			const prettyName = theme.name.trim();
			if (theme.completed || !isValidThemeName(prettyName))
			{
				continue;
			}
			const surfaces = new Map<string, Props>();
			for (const surface of theme.children)
			{
				if (!surface.completed && (THEME_SURFACES as readonly string[]).includes(surface.name))
				{
					surfaces.set(surface.name, surfaceProps(surface));
				}
			}
			const main = surfaces.get("main");
			if (main === undefined || main.size === 0)
			{
				continue;
			}
			const key = theme.name.replaceAll(/\s/gu, "_");
			themes[key] =
			{
				name: key,
				prettyName,
				free: true,
			};
			css[key] = themeCss(key, main, surfaces);
		}
	}
	return {
		themes,
		css,
	};
}

const sheets = new Map<
	string,
	{
		sheet: CSSStyleSheet;
		text: string;
	}
>();

/** Keeps one adopted sheet per theme key: replaced only when its text changed, emptied when the theme is removed. */
export function applyThemeSheets(css: Readonly<Record<string, string>>): void
{
	if (typeof CSSStyleSheet === "undefined" || !("adoptedStyleSheets" in document))
	{
		return;
	}
	const texts = new Map<string, string>(Object.entries(css));
	for (const key of sheets.keys())
	{
		if (!texts.has(key))
		{
			texts.set(key, "");
		}
	}
	for (const [key, text] of texts)
	{
		let entry = sheets.get(key);
		if (entry === undefined)
		{
			entry =
			{
				sheet: new CSSStyleSheet(),
				text: "",
			};
			sheets.set(key, entry);
			document.adoptedStyleSheets = [...document.adoptedStyleSheets, entry.sheet];
		}
		if (entry.text !== text)
		{
			entry.sheet.replaceSync(text);
			entry.text = text;
		}
	}
}
