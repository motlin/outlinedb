/** The row the pointer is on, or probing sideways from the page gutter (upstream's `item.hover` controller). */
let hoveredRowId: string | null = null;
const listeners = new Set<() => void>();

export function getHoveredRowId(): string | null
{
	return hoveredRowId;
}

export function setHoveredRowId(id: string | null): void
{
	if (id === hoveredRowId)
	{
		return;
	}
	hoveredRowId = id;
	for (const listener of listeners)
	{
		listener();
	}
}

export function subscribeHoveredRow(listener: () => void): () => void
{
	listeners.add(listener);
	return () =>
	{
		listeners.delete(listener);
	};
}
