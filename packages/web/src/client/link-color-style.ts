/** Upstream's injected `.contentLink` color sheet (`kn4`), rebuilt from the `same_color_for_links` account setting. */

const INTERNAL_PREFIXES = [
	"https://workflowy.com",
	"https://dev.workflowy.com",
	"https://beta.workflowy.com",
	"http://workflowy.com",
	"http://dev.workflowy.com",
	"http://beta.workflowy.com",
	"http://localhost",
] as const;

/** Gray (`sameColor`): every link tertiary. Blue: tint, internal links tertiary, search matches sky. */
export function linkColorCss(sameColor: boolean): string
{
	if (sameColor)
	{
		return ".contentLink { color: var(--wf-text-tertiary); }";
	}
	const internal = INTERNAL_PREFIXES.map((prefix) => `.contentLink[href^='${prefix}']`).join(",");
	return [
		".contentLink { color: var(--wf-text-tint); }",
		`${internal} { color: var(--wf-text-tertiary); }`,
		".fullMatch .contentLink, .project.metaMatches .contentLink { color: var(--wf-text-sky); }",
	].join("\n");
}
