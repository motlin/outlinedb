// Upstream's recent move/create destinations: sessionStorage["recentlySavedLocations"]
// holds JSON Map entries [id, timestamp], capped at 10 with the oldest evicted.
// Only create-and-move and the [[ / (( create paths add to it.

export const RECENT_LOCATIONS_KEY = "recentlySavedLocations";

export interface RecentLocations
{
	add(id: string): void;
	ids(): string[];
	recentLocationId(defaultId: string): string;
}

type Entries = Map<string, number>;

function isEntry(value: unknown): value is [string, number]
{
	return Array.isArray(value) && typeof value[0] === "string" && typeof value[1] === "number";
}

export function createRecentLocations(
	storage: Pick<Storage, "getItem" | "setItem">,
	now: () => number,
	max = 10,
): RecentLocations
{
	function read(): Entries
	{
		try
		{
			const parsed: unknown = JSON.parse(storage.getItem(RECENT_LOCATIONS_KEY) ?? "[]");
			return new Map(Array.isArray(parsed) ? parsed.filter(isEntry) : []);
		}
		catch
		{
			return new Map();
		}
	}

	function ids(): string[]
	{
		return [...read().entries()].toSorted((a, b) => b[1] - a[1]).map(([id]) => id);
	}

	return {
		add(id)
		{
			const entries = read();
			entries.delete(id);
			entries.set(id, now());
			while (entries.size > max)
			{
				const oldest = [...entries.entries()].reduce((a, b) => (b[1] < a[1] ? b : a));
				entries.delete(oldest[0]);
			}
			try
			{
				storage.setItem(RECENT_LOCATIONS_KEY, JSON.stringify([...entries.entries()]));
			}
			catch
			{
				// Storage can be unavailable (private mode, quota); recents are best-effort.
			}
		},
		ids,
		recentLocationId(defaultId)
		{
			return ids()[0] ?? defaultId;
		},
	};
}
