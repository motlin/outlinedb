/** Upstream's references-root label: `${count} Backlink${count > 1 ? "s" : ""}`. */
export function backlinksLabel(count: number): string
{
	return `${count} Backlink${count > 1 ? "s" : ""}`;
}
