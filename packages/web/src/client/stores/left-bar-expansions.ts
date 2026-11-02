import {create} from "zustand";
import {z} from "zod";

/**
 * Left-bar row expansion, which upstream keeps in the ACCOUNT's expanded-projects set under keys
 * `leftbar__<section>__<context>__<id8>`. The server reads and pushes them verbatim through
 * `/api/v1/expansion/left-bar`; localStorage only seeds the set until the first GET lands.
 */
const LEFT_BAR_EXPANSION_KEYS_STORAGE_KEY = "stateStorage::leftBarExpansionKeys";

export type LeftBarSectionName = "home" | "starred";

/** Upstream's unique id for a page location: `None/<id>/`, with `None` for Home. */
export function pageUniqueId(id: string | null): string
{
	return `None/${id ?? "None"}/`;
}

/** The account key for row `id` under the top-level row `topUniqueId` of `section`. */
export function leftBarExpansionKey(section: LeftBarSectionName, topUniqueId: string, id: string | null): string
{
	return `leftbar__${section}__${topUniqueId}__${id === null ? "None" : id.slice(0, 8)}`;
}

function readStoredKeys(): ReadonlySet<string>
{
	try
	{
		const raw = localStorage.getItem(LEFT_BAR_EXPANSION_KEYS_STORAGE_KEY);
		const result = z.array(z.string()).safeParse(raw === null ? [] : JSON.parse(raw));
		return new Set(result.success ? result.data : []);
	}
	catch
	{
		return new Set();
	}
}

function storeKeys(keys: ReadonlySet<string>): void
{
	try
	{
		localStorage.setItem(LEFT_BAR_EXPANSION_KEYS_STORAGE_KEY, JSON.stringify([...keys]));
	}
	catch
	{
		// Storage can be unavailable (private mode, blocked site data); state stays in memory.
	}
}

async function patchKeys(changes: Record<string, boolean>): Promise<void>
{
	try
	{
		const response = await fetch(
			"/api/v1/expansion/left-bar",
			{
				method: "PATCH",
				headers:
				{
					"Content-Type": "application/json",
				},
				body: JSON.stringify(
					{
						changes,
					},
				),
			},
		);
		if (!response.ok && response.status !== 503)
		{
			console.error(`Failed to save left-bar expansion: ${response.status}`);
		}
	}
	catch (error)
	{
		console.error("Failed to save left-bar expansion", error);
	}
}

interface LeftBarExpansionStore
{
	keys: ReadonlySet<string>;
	/** Flip `key` optimistically and push the change to the account. */
	toggle: (key: string) => void;
	/** Replace the keys with the account's, unless the user toggled something meanwhile. */
	load: () => Promise<void>;
}

let localChanges = 0;

export const useLeftBarExpansionStore = create<LeftBarExpansionStore>((set, get) => (
{
	keys: readStoredKeys(),
	toggle: (key) =>
	{
		const had = get().keys.has(key);
		const keys = new Set(get().keys);
		if (had)
		{
			keys.delete(key);
		}
		else
		{
			keys.add(key);
		}
		localChanges += 1;
		set(
			{
				keys,
			},
		);
		storeKeys(keys);
		void patchKeys(
			{
				[key]: !had,
			},
		);
	},
	load: async () =>
	{
		const before = localChanges;
		try
		{
			const response = await fetch("/api/v1/expansion/left-bar");
			if (!response.ok)
			{
				return;
			}
			const body = z
				.object(
					{
						keys: z.array(z.string()),
					},
				)
				.parse(await response.json());
			if (localChanges === before)
			{
				const keys = new Set(body.keys);
				set(
					{
						keys,
					},
				);
				storeKeys(keys);
			}
		}
		catch (error)
		{
			console.error("Failed to load left-bar expansion", error);
		}
	},
}));
