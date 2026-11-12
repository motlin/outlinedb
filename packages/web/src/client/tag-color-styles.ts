/**
 * The generated `<style id="tags-None">` sheet that colors tags, following upstream's
 * `generateStylesString`: one rule set per color, matching `.contentTag[data-val]`
 * (the lowercased tag) so coloring is case-insensitive and needs no per-span classes.
 */

/** Lowercase every tag key, so lookups by `data-val` (or `tag.toLowerCase()`) hit. */
export function normalizeTagColors(colors: Readonly<Record<string, string>>): Record<string, string>
{
	return Object.fromEntries(Object.entries(colors).map(([tag, color]) => [tag.toLowerCase(), color]));
}

function escapeCssString(value: string): string
{
	return value.replaceAll("\\", String.raw`\\`).replaceAll('"', String.raw`\"`);
}

function rule(selectors: string, declarations: readonly string[]): string
{
	return `${selectors} {\n${declarations.map((declaration) => `    ${declaration};\n`).join("")}}`;
}

function tagSelectors(list: readonly string[], suffix: string, prefix = ""): string
{
	return list.map((tag) => `${prefix}.contentTag[data-val="${escapeCssString(tag)}"]${suffix}`).join(",");
}

/** Upstream's color order in the sheet. */
const COLOR_ORDER = ["red", "orange", "yellow", "green", "blue", "purple", "gray", "teal", "sky", "pink"];

/** The stylesheet text for a lowercased tag -> color name map; empty without colors. */
export function buildTagColorCss(colors: Readonly<Record<string, string>>): string
{
	const tags = Object.keys(colors);
	if (tags.length === 0)
	{
		return "";
	}
	const perColor = COLOR_ORDER.flatMap((color) =>
	{
		const members = tags.filter((tag) => colors[tag] === color);
		return members.length === 0
			? []
			: [
					rule(tagSelectors(members, ""), [
						`background-color: var(--wf-background-${color})!important`,
						"color: var(--wf-text-primary)!important",
					]),
				];
	});
	const shared = [
		rule(tagSelectors(tags, " span"), ["background: none"]),
		rule(tagSelectors(tags, ":hover"), ["background-color: inherit", "text-decoration: underline"]),
		rule(tagSelectors(tags, ".contentTag .contentTagText"), ["text-decoration: none"]),
		rule(tagSelectors(tags, "", ".notes "), []),
		rule(tagSelectors(tags, "", ".done "), ["opacity: 0.5"]),
	];
	return [...perColor, ...shared].map((block) => `${block}\n`).join("");
}
