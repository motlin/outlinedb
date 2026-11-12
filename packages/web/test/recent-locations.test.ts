import {describe, expect, it} from "vite-plus/test";
import {createRecentLocations, RECENT_LOCATIONS_KEY} from "../src/client/recent-locations.js";

type Store = Pick<Storage, "getItem" | "setItem">;

function memoryStorage(initial: Record<string, string> = {}): Store &
{
	data: Record<string, string>;
}
{
	const data =
	{
		...initial,
	};
	return {
		data,
		getItem: (key) => data[key] ?? null,
		setItem: (key, value) =>
		{
			data[key] = value;
		},
	};
}

function clock(): () => number
{
	let t = 0;
	return () =>
	{
		t += 1;
		return t;
	};
}

describe("createRecentLocations", () =>
{
	it("re-adding an id moves it to the front without duplicating it", () =>
	{
		const recents = createRecentLocations(memoryStorage(), clock());
		recents.add("a");
		recents.add("b");
		recents.add("a");
		expect(recents.ids()).toStrictEqual(["a", "b"]);
	});

	it("evicts the oldest entry past max", () =>
	{
		const storage = memoryStorage();
		const recents = createRecentLocations(storage, clock(), 2);
		recents.add("a");
		recents.add("b");
		recents.add("c");
		expect(recents.ids()).toStrictEqual(["c", "b"]);
		expect(storage.data).toStrictEqual(
			{
				[RECENT_LOCATIONS_KEY]: '[["b",2],["c",3]]',
			},
		);
	});

	it("defaults max to 10", () =>
	{
		const recents = createRecentLocations(memoryStorage(), clock());
		for (const id of ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10"])
		{
			recents.add(id);
		}
		expect(recents.ids()).toStrictEqual(["10", "9", "8", "7", "6", "5", "4", "3", "2", "1"]);
	});

	it("reads corrupt JSON as empty", () =>
	{
		const recents = createRecentLocations(
			memoryStorage(
				{
					[RECENT_LOCATIONS_KEY]: "{not json",
				},
			),
			clock(),
		);
		expect(recents.ids()).toStrictEqual([]);
	});

	it("reads a non-array value as empty", () =>
	{
		const recents = createRecentLocations(
			memoryStorage(
				{
					[RECENT_LOCATIONS_KEY]: '{"a":1}',
				},
			),
			clock(),
		);
		expect(recents.ids()).toStrictEqual([]);
	});

	it("orders stored entries newest first by timestamp", () =>
	{
		const storage = memoryStorage(
			{
				[RECENT_LOCATIONS_KEY]: '[["old",1],["new",9],["mid",4]]',
			},
		);
		expect(createRecentLocations(storage, clock()).ids()).toStrictEqual(["new", "mid", "old"]);
	});

	it("recentLocationId falls back to the default on empty storage", () =>
	{
		const recents = createRecentLocations(memoryStorage(), clock());
		expect(recents.recentLocationId("notes")).toBe("notes");
	});

	it("recentLocationId returns the newest recent", () =>
	{
		const recents = createRecentLocations(memoryStorage(), clock());
		recents.add("a");
		recents.add("b");
		expect(recents.recentLocationId("notes")).toBe("b");
	});

	it("stores Map entries as JSON", () =>
	{
		const storage = memoryStorage();
		createRecentLocations(storage, () => 5).add("a");
		expect(storage.data).toStrictEqual(
			{
				[RECENT_LOCATIONS_KEY]: '[["a",5]]',
			},
		);
	});

	it("survives storage that throws", () =>
	{
		const throwing: Store =
		{
			getItem: () =>
			{
				throw new Error("denied");
			},
			setItem: () =>
			{
				throw new Error("denied");
			},
		};
		const recents = createRecentLocations(throwing, clock());
		recents.add("a");
		expect([recents.ids(), recents.recentLocationId("notes")]).toStrictEqual([[], "notes"]);
	});
});
