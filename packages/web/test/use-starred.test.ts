import {QueryClient} from "@tanstack/react-query";
import {afterEach, beforeEach, describe, expect, it, vi} from "vite-plus/test";
import type {Star} from "@outlinedb/shared";

vi.mock("../src/client/stores/outline.js", () => (
{
	useOutlineStore: () =>
	{
	},
}));

const {LAST_VIEWED_STORAGE_KEY, fetchStars, moveStar, readLastViewed, recordView, renameStar, starKeys, toggleStar} =
	await import("../src/client/hooks/use-starred.js");

type FetchCall = [string, RequestInit | undefined];

let calls: FetchCall[];
let response: () => Response;

beforeEach(() =>
{
	calls = [];
	response = () =>
		new Response(
			null,
			{
				status: 204,
			},
		);
	vi.stubGlobal(
		"fetch",
		vi.fn<typeof fetch>(async (input, init) =>
		{
			calls.push([input instanceof Request ? input.url : input.toString(), init]);
			return Promise.resolve(response());
		}),
	);
});

afterEach(() =>
{
	vi.unstubAllGlobals();
});

function star(key: string, position: number): Star
{
	const separator = key.indexOf("_");
	return {
		key,
		nodeId: separator === -1 ? key : key.slice(0, separator),
		query: separator === -1 ? null : key.slice(separator + 1),
		name: null,
		position,
	};
}

function seeded(stars: Star[]): QueryClient
{
	const queryClient = new QueryClient();
	queryClient.setQueryData(
		starKeys.all,
		{
			stars,
			unavailable: false,
		},
	);
	return queryClient;
}

function memoryStorage(initial: Record<string, string> = {}): Pick<Storage, "getItem" | "setItem">
{
	const items = new Map(Object.entries(initial));
	return {
		getItem: (key) => items.get(key) ?? null,
		setItem: (key, value) =>
		{
			items.set(key, value);
		},
	};
}

describe("fetchStars", () =>
{
	it("returns the stars from GET /api/v1/stars", async () =>
	{
		response = () =>
			Response.json(
				{
					stars: [star("a", 0)],
				},
			);
		await expect(fetchStars()).resolves.toStrictEqual(
			{
				stars: [star("a", 0)],
				unavailable: false,
			},
		);
		expect(calls).toStrictEqual([["/api/v1/stars", undefined]]);
	});

	it("is an empty, unavailable list when the internal API is not configured (503)", async () =>
	{
		response = () =>
			Response.json(
				{
					error: "not configured",
				},
				{
					status: 503,
				},
			);
		await expect(fetchStars()).resolves.toStrictEqual(
			{
				stars: [],
				unavailable: true,
			},
		);
	});
});

describe("toggleStar", () =>
{
	it("PUTs a Home search under its URL-encoded key and adds it optimistically", async () =>
	{
		const queryClient = seeded([]);
		const events: unknown[] = [];
		const target = new EventTarget();
		target.addEventListener("starring.starred", (event) =>
		{
			events.push((event as CustomEvent).detail);
		});
		vi.stubGlobal("window", target);

		const value = await toggleStar(
			queryClient,
			{
				nodeId: null,
				query: "#todo",
			},
		);

		expect(value).toBe(true);
		expect(calls).toStrictEqual([
			[
				"/api/v1/stars/None_%23todo",
				{
					method: "PUT",
					headers:
					{
						"Content-Type": "application/json",
					},
					body: '{"nodeId":null,"query":"#todo"}',
				},
			],
		]);
		expect(queryClient.getQueryData(starKeys.all)).toStrictEqual(
			{
				stars: [
					{
						key: "None_#todo",
						nodeId: null,
						query: "#todo",
						name: null,
						position: 0,
					},
				],
				unavailable: false,
			},
		);
		expect(events).toStrictEqual([
			{
				location:
				{
					nodeId: null,
					query: "#todo",
				},
				value: true,
			},
		]);
	});

	it("DELETEs a starred page and removes it optimistically", async () =>
	{
		const queryClient = seeded([star("a", 0), star("b", 1)]);

		const value = await toggleStar(
			queryClient,
			{
				nodeId: "a",
				query: null,
			},
		);

		expect(value).toBe(false);
		expect(calls).toStrictEqual([
			[
				"/api/v1/stars/a",
				{
					method: "DELETE",
				},
			],
		]);
		expect(queryClient.getQueryData(starKeys.all)).toStrictEqual(
			{
				stars: [star("b", 1)],
				unavailable: false,
			},
		);
	});

	it("does nothing when force matches the current state", async () =>
	{
		const queryClient = seeded([star("a", 0)]);

		await expect(
			toggleStar(
				queryClient,
				{
					nodeId: "a",
					query: null,
				},
				true,
			),
		).resolves.toBe(true);
		expect(calls).toStrictEqual([]);
	});

	it("rolls the cache back when the request fails", async () =>
	{
		const queryClient = seeded([star("a", 0)]);
		response = () =>
			Response.json(
				{
					error: "boom",
				},
				{
					status: 500,
				},
			);

		await expect(
			toggleStar(
				queryClient,
				{
					nodeId: "b",
					query: null,
				},
			),
		).rejects.toThrow("Failed to star location: 500");
		expect(queryClient.getQueryData(starKeys.all)).toStrictEqual(
			{
				stars: [star("a", 0)],
				unavailable: false,
			},
		);
	});
});

describe("moveStar", () =>
{
	it("PUTs the moved key order and reorders the cache", async () =>
	{
		const queryClient = seeded([star("a", 0), star("b", 1), star("c", 2)]);

		await moveStar(queryClient, "a", "c", true);

		expect(calls).toStrictEqual([
			[
				"/api/v1/stars/order",
				{
					method: "PUT",
					headers:
					{
						"Content-Type": "application/json",
					},
					body: '{"keys":["b","c","a"]}',
				},
			],
		]);
		expect(queryClient.getQueryData(starKeys.all)).toStrictEqual(
			{
				stars: [star("b", 0), star("c", 1), star("a", 2)],
				unavailable: false,
			},
		);
	});
});

describe("renameStar", () =>
{
	it("PATCHes the name and updates the cache", async () =>
	{
		const queryClient = seeded([star("a_#x", 0)]);

		await renameStar(queryClient, "a_#x", "Alice");

		expect(calls).toStrictEqual([
			[
				"/api/v1/stars/a_%23x",
				{
					method: "PATCH",
					headers:
					{
						"Content-Type": "application/json",
					},
					body: '{"name":"Alice"}',
				},
			],
		]);
		expect(queryClient.getQueryData(starKeys.all)).toStrictEqual(
			{
				stars: [
					{
						...star("a_#x", 0),
						name: "Alice",
					},
				],
				unavailable: false,
			},
		);
	});
});

describe("recordView", () =>
{
	it("stamps a starred location's uniqueId and ignores unstarred ones", () =>
	{
		const storage = memoryStorage(
			{
				[LAST_VIEWED_STORAGE_KEY]: '{"None/b/":5}',
			},
		);

		recordView(
			storage,
			[star("a", 0)],
			{
				nodeId: "a",
				query: null,
			},
			10,
		);
		recordView(
			storage,
			[star("a", 0)],
			{
				nodeId: "c",
				query: null,
			},
			20,
		);

		expect(readLastViewed(storage)).toStrictEqual(
			{
				"None/b/": 5,
				"None/a/": 10,
			},
		);
	});

	it("reads corrupt storage as no views", () =>
	{
		expect(
			readLastViewed(
				memoryStorage(
					{
						[LAST_VIEWED_STORAGE_KEY]: "{",
					},
				),
			),
		).toStrictEqual({});
	});
});
