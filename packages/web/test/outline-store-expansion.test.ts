import {afterEach, beforeEach, describe, expect, it, vi} from "vite-plus/test";

const fetchMock = vi.fn<typeof fetch>();

function stubGlobals(): void
{
	vi.stubGlobal(
		"localStorage",
		{
			getItem: () => null,
			setItem: () =>
			{
			},
			removeItem: () =>
			{
			},
		},
	);
	vi.stubGlobal("innerWidth", 1272);
	vi.stubGlobal("matchMedia", () => (
	{
		matches: false,
		addEventListener: () =>
		{
		},
	}));
	vi.stubGlobal(
		"document",
		{
			documentElement:
			{
				dataset: {},
			},
			body:
			{
				classList:
				{
					toggle: () => true,
					contains: () => false,
				},
			},
		},
	);
	vi.stubGlobal("addEventListener", () => {});
	vi.stubGlobal("fetch", fetchMock);
}

async function loadModules()
{
	vi.resetModules();
	const {useOutlineStore} = await import("../src/client/stores/outline.js");
	const {loadExpansion} = await import("../src/client/hooks/use-expansion-sync.js");
	return {
		store: useOutlineStore,
		loadExpansion,
	};
}

function calls():
{
	url: unknown;
	method: unknown;
	body: unknown;
}[]
{
	return fetchMock.mock.calls.map(([url, init]) => (
	{
		url,
		method: init?.method,
		body: init?.body,
	}));
}

function patch(changes: Record<string, boolean>)
{
	return {
		url: "/api/v1/expansion",
		method: "PATCH",
		body: JSON.stringify(
			{
				changes,
			},
		),
	};
}

beforeEach(() =>
{
	fetchMock.mockReset();
	fetchMock.mockImplementation(async () =>
		Promise.resolve(
			new Response(
				null,
				{
					status: 204,
				},
			),
		),
	);
	stubGlobals();
});

afterEach(() =>
{
	vi.unstubAllGlobals();
});

describe("expansion deltas", () =>
{
	it("expand then toggleExpand send one delta each", async () =>
	{
		const {store} = await loadModules();
		store.getState().expand("a");
		store.getState().toggleExpand("a");
		expect(
			{
				expandedIds: store.getState().expandedIds,
				calls: calls(),
			},
		).toStrictEqual(
			{
				expandedIds: new Set(),
				calls: [
					patch(
						{
							a: true,
						},
					),
					patch(
						{
							a: false,
						},
					),
				],
			},
		);
	});

	it("replaceExpanded sends the whole delta in one PATCH", async () =>
	{
		const {store} = await loadModules();
		store.getState().replaceExpanded(new Set(["a", "b"]));
		fetchMock.mockClear();
		store.getState().replaceExpanded(new Set(["c"]));
		expect(calls()).toStrictEqual([
			patch(
				{
					c: true,
					a: false,
					b: false,
				},
			),
		]);
	});

	it("sends nothing when the set does not change", async () =>
	{
		const {store} = await loadModules();
		store.getState().expand("a");
		fetchMock.mockClear();
		store.getState().expand("a");
		store.getState().collapse("b");
		expect(calls()).toStrictEqual([]);
	});

	it("stops sending after a 503 PATCH", async () =>
	{
		const {store} = await loadModules();
		fetchMock.mockImplementation(async () =>
			Promise.resolve(
				Response.json(
					{
						error: "not configured",
					},
					{
						status: 503,
					},
				),
			),
		);
		store.getState().expand("a");
		await vi.waitFor(() =>
		{
			expect(fetchMock).toHaveBeenCalledOnce();
		});
		await new Promise((resolve) =>
		{
			setTimeout(resolve, 0);
		});
		store.getState().expand("b");
		expect(
			{
				expandedIds: store.getState().expandedIds,
				calls: calls(),
			},
		).toStrictEqual(
			{
				expandedIds: new Set(["a", "b"]),
				calls: [
					patch(
						{
							a: true,
						},
					),
				],
			},
		);
	});
});

describe("loadExpansion", () =>
{
	it("hydrates expandedIds from GET without sending a PATCH", async () =>
	{
		const {store, loadExpansion} = await loadModules();
		fetchMock.mockImplementation(async () =>
			Promise.resolve(
				Response.json(
					{
						version: "aaaaaaaaaaaaaaaa",
						expandedIds: ["a", "b"],
					},
				),
			),
		);
		await loadExpansion();
		expect(
			{
				expandedIds: store.getState().expandedIds,
				calls: calls(),
			},
		).toStrictEqual(
			{
				expandedIds: new Set(["a", "b"]),
				calls: [
					{
						url: "/api/v1/expansion",
						method: undefined,
						body: undefined,
					},
				],
			},
		);
	});

	it("shares one GET between repeated loads, as StrictMode's double effect does", async () =>
	{
		const {store, loadExpansion} = await loadModules();
		fetchMock.mockImplementation(async () =>
			Promise.resolve(
				Response.json(
					{
						version: "aaaaaaaaaaaaaaaa",
						expandedIds: ["a"],
					},
				),
			),
		);
		await Promise.all([loadExpansion(), loadExpansion()]);
		await loadExpansion();
		expect(
			{
				expandedIds: store.getState().expandedIds,
				calls: calls(),
			},
		).toStrictEqual(
			{
				expandedIds: new Set(["a"]),
				calls: [
					{
						url: "/api/v1/expansion",
						method: undefined,
						body: undefined,
					},
				],
			},
		);
	});

	it("retries a page-load GET through an API restart (502, refused connection) without logging", async () =>
	{
		const {store, loadExpansion} = await loadModules();
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		vi.useFakeTimers();
		fetchMock
			.mockImplementationOnce(async () =>
				Promise.resolve(
					new Response(
						"Bad Gateway",
						{
							status: 502,
						},
					),
				),
			)
			.mockImplementationOnce(async () => Promise.reject(new TypeError("Failed to fetch")))
			.mockImplementationOnce(async () =>
				Promise.resolve(
					Response.json(
						{
							version: "aaaaaaaaaaaaaaaa",
							expandedIds: ["a"],
						},
					),
				),
			);
		const loading = loadExpansion();
		await vi.runAllTimersAsync();
		await loading;
		const logged = [...errors.mock.calls];
		vi.useRealTimers();
		errors.mockRestore();
		expect(
			{
				expandedIds: store.getState().expandedIds,
				calls: calls(),
				errors: logged,
			},
		).toStrictEqual(
			{
				expandedIds: new Set(["a"]),
				calls: [
					{
						url: "/api/v1/expansion",
						method: undefined,
						body: undefined,
					},
					{
						url: "/api/v1/expansion",
						method: undefined,
						body: undefined,
					},
					{
						url: "/api/v1/expansion",
						method: undefined,
						body: undefined,
					},
				],
				errors: [],
			},
		);
	});

	it("leaves an empty set on 503 and keeps later changes in memory", async () =>
	{
		const {store, loadExpansion} = await loadModules();
		fetchMock.mockImplementation(async () =>
			Promise.resolve(
				Response.json(
					{
						error: "not configured",
					},
					{
						status: 503,
					},
				),
			),
		);
		await loadExpansion();
		const afterLoad = new Set(store.getState().expandedIds);
		store.getState().expand("a");
		expect(
			{
				afterLoad,
				expandedIds: store.getState().expandedIds,
				calls: calls(),
			},
		).toStrictEqual(
			{
				afterLoad: new Set(),
				expandedIds: new Set(["a"]),
				calls: [
					{
						url: "/api/v1/expansion",
						method: undefined,
						body: undefined,
					},
				],
			},
		);
	});
});

describe("pollExpansion", () =>
{
	/** Past the grace a poll waits out after a local change. */
	const LOCAL_GRACE_PASSED_MS = 10_000;
	const V100 = "0000000000000100";
	const V200 = "0000000000000200";
	const asked = (version: string) => (
	{
		url: `/api/v1/expansion?version=${version}`,
		method: undefined,
		body: undefined,
	});

	async function loaded(ids: string[], version = V100)
	{
		const modules = await loadModules();
		const {pollExpansion} = await import("../src/client/hooks/use-expansion-sync.js");
		serve(version, ids);
		await modules.loadExpansion();
		fetchMock.mockClear();
		return {
			...modules,
			pollExpansion,
		};
	}

	function serve(version: string, expandedIds: string[] | null): void
	{
		fetchMock.mockImplementation(async () =>
			Promise.resolve(
				Response.json(
					{
						version,
						expandedIds,
					},
				),
			),
		);
	}

	it("asks whether the keys differ from the page load's version and applies them without PATCHing them back", async () =>
	{
		const {store, pollExpansion} = await loaded(["a", "b"]);
		serve(V200, ["b", "c"]);
		await pollExpansion();
		expect(
			{
				expandedIds: store.getState().expandedIds,
				calls: calls(),
			},
		).toStrictEqual(
			{
				expandedIds: new Set(["b", "c"]),
				calls: [asked(V100)],
			},
		);
	});

	it("adopts each answer's version, even one the server stamped earlier", async () =>
	{
		const {pollExpansion} = await loaded(["a"], V200);
		serve(V100, ["a", "b"]);
		await pollExpansion();
		serve(V100, null);
		await pollExpansion();
		expect(calls()).toStrictEqual([asked(V200), asked(V100)]);
	});

	it("keeps the same set instance when the keys still match the version", async () =>
	{
		const {store, pollExpansion} = await loaded(["a"]);
		const before = store.getState().expandedIds;
		serve(V100, null);
		await pollExpansion();
		expect(
			{
				same: store.getState().expandedIds === before,
				calls: calls(),
			},
		).toStrictEqual(
			{
				same: true,
				calls: [asked(V100)],
			},
		);
	});

	it("does not poll before the page load has set a version", async () =>
	{
		await loadModules();
		const {pollExpansion} = await import("../src/client/hooks/use-expansion-sync.js");
		await pollExpansion();
		expect(calls()).toStrictEqual([]);
	});

	it("discards a response, keeping the version, when a local change happened while it was in flight", async () =>
	{
		const {store, pollExpansion} = await loaded(["a"]);
		let resolve: (response: Response) => void = () =>
		{
		};
		fetchMock.mockImplementationOnce(
			async () =>
				new Promise<Response>((r) =>
				{
					resolve = r;
				}),
		);
		const polling = pollExpansion(60_000);
		store.getState().expand("z");
		resolve(
			Response.json(
				{
					version: V200,
					expandedIds: [],
				},
			),
		);
		await polling;
		fetchMock.mockClear();
		serve(V200, null);
		await pollExpansion(Date.now() + LOCAL_GRACE_PASSED_MS);
		expect(
			{
				expandedIds: store.getState().expandedIds,
				calls: calls(),
			},
		).toStrictEqual(
			{
				expandedIds: new Set(["a", "z"]),
				calls: [asked(V100)],
			},
		);
	});

	it("skips the poll shortly after a local change the server may not have pushed yet", async () =>
	{
		vi.spyOn(Date, "now").mockReturnValue(28_000);
		const {store, pollExpansion} = await loaded(["a"]);
		store.getState().expand("z");
		fetchMock.mockClear();
		await pollExpansion(30_000);
		vi.restoreAllMocks();
		expect(
			{
				expandedIds: store.getState().expandedIds,
				calls: calls(),
			},
		).toStrictEqual(
			{
				expandedIds: new Set(["a", "z"]),
				calls: [],
			},
		);
	});

	it("does nothing once expansion persistence is disabled", async () =>
	{
		const {loadExpansion} = await loadModules();
		const {pollExpansion} = await import("../src/client/hooks/use-expansion-sync.js");
		fetchMock.mockImplementation(async () =>
			Promise.resolve(
				Response.json(
					{
						error: "not configured",
					},
					{
						status: 503,
					},
				),
			),
		);
		await loadExpansion();
		fetchMock.mockClear();
		await pollExpansion();
		expect(calls()).toStrictEqual([]);
	});

	it("aborts a poll that has not answered in 30s and keeps the expanded set", async () =>
	{
		const {store, pollExpansion} = await loaded(["a"]);
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		vi.useFakeTimers();
		fetchMock.mockImplementationOnce(
			async (_url, init) =>
				new Promise<Response>((_resolve, reject) =>
				{
					init?.signal?.addEventListener("abort", () =>
					{
						reject(new DOMException("aborted", "AbortError"));
					});
				}),
		);
		let settled = false;
		const polling = pollExpansion(60_000).then(() =>
		{
			settled = true;
			return settled;
		});
		await vi.advanceTimersByTimeAsync(29_999);
		const early = settled;
		await vi.advanceTimersByTimeAsync(1);
		await polling;
		vi.useRealTimers();
		const logged = errors.mock.calls.length;
		errors.mockRestore();
		expect(
			{
				early,
				settled,
				expandedIds: store.getState().expandedIds,
				logged,
			},
		).toStrictEqual(
			{
				early: false,
				settled: true,
				expandedIds: new Set(["a"]),
				logged: 1,
			},
		);
	});
});
