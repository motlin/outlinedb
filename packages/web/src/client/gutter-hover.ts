/** Upstream's `mm4`: how far sideways the gutter probe looks. */
export function pickHoverProbeOffsets(panesOpen: boolean): number[]
{
	const distance = panesOpen ? 100 : 200;
	return [-distance, distance];
}

function rowOfName(target: Element | null): string | null
{
	if (target === null)
	{
		return null;
	}
	const project = target.closest(".project");
	if (project === null || target.classList.contains("children"))
	{
		return null;
	}
	if (target.closest(".name") === null && target.closest(".file-preview") === null)
	{
		return null;
	}
	return (
		project.getAttribute("projectid") ??
		project.querySelector(":scope > .name [data-item-id]")?.getAttribute("data-item-id") ??
		null
	);
}

/**
 * Upstream's gutter hover (`c62`): the row under the pointer, else, over the page container but off a name,
 * the row found by probing sideways with `pointAt(dx)`.
 */
export function resolveHoveredRow(
	target: EventTarget | null,
	pointAt: (dx: number) => Element | null,
	offsets: readonly number[] = pickHoverProbeOffsets(false),
): string | null
{
	if (!(target instanceof Element))
	{
		return null;
	}
	const direct = rowOfName(target);
	if (direct !== null)
	{
		return direct;
	}
	if (target.closest(".pageContainer") === null)
	{
		return null;
	}
	for (const dx of offsets)
	{
		const id = rowOfName(pointAt(dx));
		if (id !== null)
		{
			return id;
		}
	}
	return null;
}
