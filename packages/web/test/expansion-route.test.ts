import {afterEach, beforeEach, describe, expect, it, vi} from "vite-plus/test";
import type {WorkflowyInternalAdapter} from "@outlinedb/shared/internal";
import type {ServerContext} from "../src/server/context.js";
import {standaloneContext} from "./helpers/local-context.js";
import {httpAppFor} from "./http-app-for.js";

const ALPHA = "1a2b3c4d-0000-4000-8000-000000000001";
const BRAVO = "5e6f7a8b-0000-4000-8000-000000000002";
const CURRENT = "aaaaaaaaaaaaaaaa";
const OLDER = "bbbbbbbbbbbbbbbb";

function requester(ctx: ServerContext)
{
	const app = httpAppFor(ctx);
	return async (method: string, body?: unknown, query = "", path = "", headers: Record<string, string> = {}) =>
	{
		const res = await app.fetch(
			new Request(
				`http://x/api/v1/expansion${path}${query}`,
				{
					method,
					headers:
					{
						"content-type": "application/json",
						...headers,
					},
					...(body === undefined
						? {}
						:
							{
								body: JSON.stringify(body),
							}),
				},
			),
		);
		const text = await res.text();
		return {
			status: res.status,
			body: text === "" ? null : (JSON.parse(text) as unknown),
			etag: res.headers.get("etag"),
		};
	};
}

function setup()
{
	const adapter =
	{
		getExpansionChanges: vi.fn<WorkflowyInternalAdapter["getExpansionChanges"]>(() => (
		{
			version: CURRENT,
			expandedIds: [ALPHA],
		})),
		setExpanded: vi.fn<WorkflowyInternalAdapter["setExpanded"]>(async () => Promise.resolve()),
		getLeftBarExpansionKeys: vi.fn<WorkflowyInternalAdapter["getLeftBarExpansionKeys"]>(() => [
			"leftbar__home__None/x/__abcdefgh",
		]),
		setRawExpansionKeys: vi.fn<WorkflowyInternalAdapter["setRawExpansionKeys"]>(async () => Promise.resolve()),
	};
	const ctx =
	{
		internalAuth: {},
		internalAdapter: () => adapter as unknown as WorkflowyInternalAdapter,
	} as unknown as ServerContext;
	return {
		adapter,
		request: requester(ctx),
	};
}

/** A standalone context whose cache holds ALPHA and BRAVO at Home. */
function standaloneSetup()
{
	const ctx = standaloneContext();
	for (const id of [ALPHA, BRAVO])
	{
		ctx.cacheService.insertNode(
			{
				id,
				name: id,
				note: null,
				parent_id: null,
				priority: 0,
				createdAt: 100,
				modifiedAt: 200,
			},
			null,
		);
	}
	const expansionWritten = vi.fn<() => void>();
	ctx.expansionWritten = expansionWritten;
	return {
		expansionWritten,
		request: requester(ctx),
	};
}

beforeEach(() =>
{
	vi.useFakeTimers();
});

afterEach(() =>
{
	vi.useRealTimers();
});

describe("GET /api/v1/expansion", () =>
{
	it("returns the stored keys' version and the expanded ids", async () =>
	{
		const {adapter, request} = setup();

		const res = await request("GET");

		expect(
			{
				res,
				calls: adapter.getExpansionChanges.mock.calls,
			},
		).toStrictEqual(
			{
				res:
				{
					status: 200,
					body:
					{
						version: CURRENT,
						expandedIds: [ALPHA],
					},
					etag: null,
				},
				calls: [[undefined]],
			},
		);
	});

	it("asks the change feed whether the keys differ from ?version=<version>, answering null ids when not", async () =>
	{
		const {adapter, request} = setup();
		adapter.getExpansionChanges.mockReturnValueOnce(
			{
				version: CURRENT,
				expandedIds: null,
			},
		);

		const unchanged = await request("GET", undefined, `?version=${CURRENT}`);
		const changed = await request("GET", undefined, `?version=${OLDER}`);

		expect(
			{
				unchanged,
				changed,
				calls: adapter.getExpansionChanges.mock.calls,
			},
		).toStrictEqual(
			{
				unchanged:
				{
					status: 200,
					body:
					{
						version: CURRENT,
						expandedIds: null,
					},
					etag: null,
				},
				changed:
				{
					status: 200,
					body:
					{
						version: CURRENT,
						expandedIds: [ALPHA],
					},
					etag: null,
				},
				calls: [[CURRENT], [OLDER]],
			},
		);
	});

	it("answers 400 for a version that is not one", async () =>
	{
		const {adapter, request} = setup();

		const res = await request("GET", undefined, "?version=yesterday");

		expect(
			{
				status: res.status,
				calls: adapter.getExpansionChanges.mock.calls,
			},
		).toStrictEqual(
			{
				status: 400,
				calls: [],
			},
		);
	});
});

describe("PATCH /api/v1/expansion", () =>
{
	it("debounces PATCHes into one push 500ms after the last, the latest value per id winning", async () =>
	{
		const {adapter, request} = setup();

		const first = await request(
			"PATCH",
			{
				changes:
				{
					[ALPHA]: false,
					[BRAVO]: false,
				},
			},
		);
		await vi.advanceTimersByTimeAsync(200);
		const second = await request(
			"PATCH",
			{
				changes:
				{
					[ALPHA]: true,
				},
			},
		);
		await vi.advanceTimersByTimeAsync(499);
		const callsBeforeFlush = adapter.setExpanded.mock.calls.length;
		await vi.advanceTimersByTimeAsync(1);

		expect(
			{
				first,
				second,
				callsBeforeFlush,
				calls: adapter.setExpanded.mock.calls,
			},
		).toStrictEqual(
			{
				first:
				{
					status: 204,
					body: null,
					etag: null,
				},
				second:
				{
					status: 204,
					body: null,
					etag: null,
				},
				callsBeforeFlush: 0,
				calls: [
					[
						{
							[ALPHA]: true,
							[BRAVO]: false,
						},
					],
				],
			},
		);
	});

	it("starts a new batch after a flush", async () =>
	{
		const {adapter, request} = setup();

		await request(
			"PATCH",
			{
				changes:
				{
					[ALPHA]: true,
				},
			},
		);
		await vi.advanceTimersByTimeAsync(500);
		await request(
			"PATCH",
			{
				changes:
				{
					[BRAVO]: false,
				},
			},
		);
		await vi.advanceTimersByTimeAsync(500);

		expect(adapter.setExpanded.mock.calls).toStrictEqual([
			[
				{
					[ALPHA]: true,
				},
			],
			[
				{
					[BRAVO]: false,
				},
			],
		]);
	});

	it.each([
		[{}],
		[
			{
				changes:
				{
					[ALPHA]: "yes",
				},
			},
		],
		[
			{
				changes: [ALPHA],
			},
		],
	])("rejects %j", async (body) =>
	{
		const {adapter, request} = setup();

		const res = await request("PATCH", body);
		await vi.advanceTimersByTimeAsync(500);

		expect(
			{
				res,
				calls: adapter.setExpanded.mock.calls,
			},
		).toStrictEqual(
			{
				res:
				{
					status: 400,
					body:
					{
						error: "body must be {changes: {[nodeId]: boolean}}",
					},
					etag: null,
				},
				calls: [],
			},
		);
	});

	it("retries a failed push with the failed changes merged under newer PATCHes", async () =>
	{
		const {adapter, request} = setup();
		adapter.setExpanded.mockRejectedValueOnce(new Error("push failed"));
		vi.spyOn(console, "error").mockImplementation(() => {});

		await request(
			"PATCH",
			{
				changes:
				{
					[ALPHA]: true,
				},
			},
		);
		await vi.advanceTimersByTimeAsync(500);
		await request(
			"PATCH",
			{
				changes:
				{
					[BRAVO]: false,
				},
			},
		);
		await vi.advanceTimersByTimeAsync(1000);

		expect(adapter.setExpanded.mock.calls).toStrictEqual([
			[
				{
					[ALPHA]: true,
				},
			],
			[
				{
					[ALPHA]: true,
					[BRAVO]: false,
				},
			],
		]);
	});

	it("retries with the newer value when a later PATCH overrides a failed change", async () =>
	{
		const {adapter, request} = setup();
		adapter.setExpanded.mockRejectedValueOnce(new Error("push failed"));
		vi.spyOn(console, "error").mockImplementation(() => {});

		await request(
			"PATCH",
			{
				changes:
				{
					[ALPHA]: true,
				},
			},
		);
		await vi.advanceTimersByTimeAsync(500);
		await request(
			"PATCH",
			{
				changes:
				{
					[ALPHA]: false,
				},
			},
		);
		await vi.advanceTimersByTimeAsync(1000);

		expect(adapter.setExpanded.mock.calls).toStrictEqual([
			[
				{
					[ALPHA]: true,
				},
			],
			[
				{
					[ALPHA]: false,
				},
			],
		]);
	});

	it("retries on a 1s/2s/4s/8s backoff, gives up after 4 retries and logs", async () =>
	{
		const {adapter, request} = setup();
		adapter.setExpanded.mockRejectedValue(new Error("push failed"));
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});

		await request(
			"PATCH",
			{
				changes:
				{
					[ALPHA]: true,
				},
			},
		);
		await vi.advanceTimersByTimeAsync(500);
		const attemptTimes: number[] = [];
		let elapsed = 0;
		for (const step of [999, 1, 1999, 1, 3999, 1, 7999, 1, 30_000])
		{
			// oxlint-disable-next-line no-await-in-loop -- the clock advances sequentially by design.
			await vi.advanceTimersByTimeAsync(step);
			elapsed += step;
			attemptTimes.push(adapter.setExpanded.mock.calls.length);
		}

		expect(
			{
				attemptTimes,
				elapsed,
				logged: errors.mock.calls.length > 0,
			},
		).toStrictEqual(
			{
				attemptTimes: [1, 2, 2, 3, 3, 4, 4, 5, 5],
				elapsed: 45_000,
				logged: true,
			},
		);
	});
});

describe("/api/v1/expansion/left-bar", () =>
{
	it("lists the adapter's left-bar keys", async () =>
	{
		const {request} = setup();

		await expect(request("GET", undefined, "", "/left-bar")).resolves.toStrictEqual(
			{
				status: 200,
				body:
				{
					keys: ["leftbar__home__None/x/__abcdefgh"],
				},
				etag: null,
			},
		);
	});

	it("pushes raw keys once, 500ms after the last PATCH", async () =>
	{
		const {adapter, request} = setup();

		const first = await request(
			"PATCH",
			{
				changes:
				{
					"leftbar__home__None/x/__abcdefgh": true,
				},
			},
			"",
			"/left-bar",
		);
		await vi.advanceTimersByTimeAsync(499);
		const before = adapter.setRawExpansionKeys.mock.calls.length;
		await vi.advanceTimersByTimeAsync(1);

		expect(
			{
				first,
				before,
				calls: adapter.setRawExpansionKeys.mock.calls,
			},
		).toStrictEqual(
			{
				first:
				{
					status: 204,
					body: null,
					etag: null,
				},
				before: 0,
				calls: [
					[
						{
							"leftbar__home__None/x/__abcdefgh": true,
						},
					],
				],
			},
		);
	});

	it("rejects keys that are not left-bar keys", async () =>
	{
		const {adapter, request} = setup();

		const res = await request(
			"PATCH",
			{
				changes:
				{
					main__abc: true,
				},
			},
			"",
			"/left-bar",
		);
		await vi.advanceTimersByTimeAsync(1000);

		expect(
			{
				status: res.status,
				calls: adapter.setRawExpansionKeys.mock.calls,
			},
		).toStrictEqual(
			{
				status: 400,
				calls: [],
			},
		);
	});
});

describe("expansion in a standalone context", () =>
{
	it("applies each PATCH at once to the local store and reads it back, with no internal API", async () =>
	{
		const {expansionWritten, request} = standaloneSetup();

		const before = await request("GET");
		const patched = await request(
			"PATCH",
			{
				changes:
				{
					[ALPHA]: true,
					[BRAVO]: true,
				},
			},
		);
		vi.advanceTimersByTime(1000);
		await request(
			"PATCH",
			{
				changes:
				{
					[BRAVO]: false,
				},
			},
		);
		const after = await request("GET");
		const unchanged = await request(
			"GET",
			undefined,
			`?version=${
				(
					after.body as
					{
						version: string;
					}
				).version
			}`,
		);

		expect(
			{
				before: before.body,
				patched,
				expandedIds: (
					after.body as
					{
						expandedIds: unknown;
					}
				).expandedIds,
				unchanged: (
					unchanged.body as
					{
						expandedIds: unknown;
					}
				).expandedIds,
				announced: expansionWritten.mock.calls.length,
			},
		).toStrictEqual(
			{
				before:
				{
					version: expect.stringMatching(/^[0-9a-f]{16}$/u),
					expandedIds: [],
				},
				patched:
				{
					status: 204,
					body: null,
					etag: null,
				},
				expandedIds: [ALPHA],
				unchanged: null,
				announced: 2,
			},
		);
	});

	it("stores raw left-bar keys and lists them back", async () =>
	{
		const {request} = standaloneSetup();

		await request(
			"PATCH",
			{
				changes:
				{
					"leftbar__starred__None/x/__abcdefgh": true,
				},
			},
			"",
			"/left-bar",
		);

		await expect(request("GET", undefined, "", "/left-bar")).resolves.toStrictEqual(
			{
				status: 200,
				body:
				{
					keys: ["leftbar__starred__None/x/__abcdefgh"],
				},
				etag: null,
			},
		);
	});
});
