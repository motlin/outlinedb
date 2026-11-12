import {useCustomThemesStore} from "./stores/custom-themes.js";

/** Upstream's theme registry (`WF.map.GuiThemes`); the order is the dropdown order. */

export interface ThemeInfo
{
	readonly name: string;
	readonly prettyName: string;
	/** Metadata only, as upstream: nothing but the ladder palette reads it. */
	readonly dark?: boolean;
}

export const THEMES: readonly ThemeInfo[] = [
	{
		name: "default",
		prettyName: "Light",
	},
	{
		name: "dark",
		prettyName: "Dark",
		dark: true,
	},
	{
		name: "system",
		prettyName: "System",
	},
	{
		name: "vintage",
		prettyName: "Vintage",
	},
	{
		name: "catppuccin",
		prettyName: "Catppuccin",
		dark: true,
	},
	{
		name: "chocolate",
		prettyName: "Chocolate",
	},
	{
		name: "glass",
		prettyName: "Glass",
	},
	{
		name: "hacker",
		prettyName: "Hacker",
		dark: true,
	},
	{
		name: "matcha",
		prettyName: "Matcha",
	},
	{
		name: "moon",
		prettyName: "Moon",
	},
	{
		name: "neo",
		prettyName: "Neo",
		dark: true,
	},
	{
		name: "robot",
		prettyName: "Robot",
		dark: true,
	},
	{
		name: "space",
		prettyName: "Space",
		dark: true,
	},
	{
		name: "steel",
		prettyName: "Steel",
	},
	{
		name: "wood",
		prettyName: "Wood",
	},
	{
		name: "one_dark",
		prettyName: "One Dark",
		dark: true,
	},
];

export type ThemeName = string;

/** The built-in themes, with custom themes appended; a custom theme replaces a built-in one of the same key. */
export function allThemes(
	custom: readonly
	{
		name: string;
		prettyName: string;
	}[] = useCustomThemesStore.getState().themes,
): readonly ThemeInfo[]
{
	const replaced = new Map(custom.map((theme) => [theme.name, theme]));
	const builtIn = THEMES.map((theme) =>
	{
		const override = replaced.get(theme.name);
		replaced.delete(theme.name);
		return override === undefined
			? theme
			:
				{
					...theme,
					prettyName: override.prettyName,
				};
	});
	return [
		...builtIn,
		...Array.from(replaced.values(), (theme): ThemeInfo => (
		{
			name: theme.name,
			prettyName: theme.prettyName,
		})),
	];
}

const DEFAULT_THEME: ThemeName = "default";

/** The selected theme if registered, else the first (`default`). */
export function currentTheme(selected: string | null | undefined): ThemeName
{
	return allThemes().find((theme) => theme.name === selected)?.name ?? DEFAULT_THEME;
}

/** The sheet to apply: `system` resolves from the OS colour scheme. */
export function effectiveTheme(selected: string | null | undefined, prefersDark: boolean): ThemeName
{
	const current = currentTheme(selected);
	if (current === "system")
	{
		return prefersDark ? "dark" : "default";
	}
	return current;
}

export function isDarkTheme(name: string): boolean
{
	return allThemes().find((theme) => theme.name === name)?.dark === true;
}

export function isRegisteredTheme(name: string | null | undefined): name is ThemeName
{
	return allThemes().some((theme) => theme.name === name);
}
