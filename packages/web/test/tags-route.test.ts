import {afterEach, describe, expect, it, vi} from "vite-plus/test";
import type {ServerContext} from "../src/server/context.js";
import {standaloneContext} from "./helpers/local-context.js";
import {mirrorAccountContext} from "./helpers/mirror-account.js";
import {httpAppFor} from "./http-app-for.js";

function requester(ctx: ServerContext)
{
	const app = httpAppFor(ctx);
	return async (method: string, path: string, body?: unknown) =>
	{
		const res = await app.fetch(
			new Request(
				`http://x/api/v1/tags${path}`,
				{
					method,
					headers:
					{
						"content-type": "application/json",
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
		return {
			status: res.status,
			body: (await res.json()) as unknown,
		};
	};
}

/** A mirror whose root metadata holds `tagMeta` as `color.tags`, with workflowy.com down. */
function setup(tagMeta: Record<string, unknown>)
{
	const {ctx, local} = mirrorAccountContext(
		{
			color:
			{
				tags: tagMeta,
			},
		},
	);
	return {
		local,
		request: requester(ctx),
	};
}

describe("GET /api/v1/tags", () =>
{
	it("maps root metadata color.tags indexes to color names, skipping unknown indexes", async () =>
	{
		const {request} = setup(
			{
				"@alice": 0,
				"#home": 7,
				"#errand": 9,
				"#work": 6,
				"#cleared": -1,
				"#bogus": 42,
				"#text": "red",
			},
		);

		await expect(request("GET", "")).resolves.toStrictEqual(
			{
				status: 200,
				body:
				{
					colors:
					{
						"@alice": "red",
						"#home": "teal",
						"#errand": "pink",
						"#work": "gray",
					},
				},
			},
		);
	});

	it("answers an empty map when none are stored", async () =>
	{
		const {request} = setup({});
		await expect(request("GET", "")).resolves.toStrictEqual(
			{
				status: 200,
				body:
				{
					colors: {},
				},
			},
		);
	});
});

describe("tag colors in a standalone context", () =>
{
	afterEach(() =>
	{
		vi.useRealTimers();
	});

	it("sets, reads back and clears colors in the local tables with no internal API", async () =>
	{
		vi.useFakeTimers(
			{
				toFake: ["Date"],
				now: 1_700_000_000_000,
			},
		);
		const request = requester(standaloneContext());

		const before = await request("GET", "");
		const set = await request(
			"PUT",
			"/%40Alice",
			{
				color: "red",
			},
		);
		vi.setSystemTime(1_700_000_001_000);
		await request(
			"PUT",
			"/%23Home",
			{
				color: "teal",
			},
		);
		const afterSet = await request("GET", "");
		vi.setSystemTime(1_700_000_002_000);
		const cleared = await request("DELETE", "/%40alice");

		expect(
			{
				before,
				set,
				afterSet,
				cleared,
				afterClear: await request("GET", ""),
			},
		).toStrictEqual(
			{
				before:
				{
					status: 200,
					body:
					{
						colors: {},
					},
				},
				set:
				{
					status: 200,
					body:
					{
						name: "@Alice",
						color: "red",
					},
				},
				afterSet:
				{
					status: 200,
					body:
					{
						colors:
						{
							"@alice": "red",
							"#home": "teal",
						},
					},
				},
				cleared:
				{
					status: 200,
					body:
					{
						name: "@alice",
					},
				},
				afterClear:
				{
					status: 200,
					body:
					{
						colors:
						{
							"#home": "teal",
						},
					},
				},
			},
		);
	});
});

describe("PUT /api/v1/tags/:name", () =>
{
	it("stores the color index under the lowercased tag name", async () =>
	{
		const {local, request} = setup({});

		await expect(
			request(
				"PUT",
				"/%40Alice",
				{
					color: "red",
				},
			),
		).resolves.toStrictEqual(
			{
				status: 200,
				body:
				{
					name: "@Alice",
					color: "red",
				},
			},
		);
		expect(local.pendingRoot()).toStrictEqual([
			{
				path: ["color", "tags", "@alice"],
				value: 0,
			},
		]);
	});

	it("lowercases a mixed-case hashtag before writing", async () =>
	{
		const {local, request} = setup({});

		await request(
			"PUT",
			"/%23TaZebra",
			{
				color: "green",
			},
		);
		const pendingAfterSet = local.pendingRoot();
		await request("DELETE", "/%23TaZebra");
		expect(
			{
				pendingAfterSet,
				pendingAfterClear: local.pendingRoot(),
			},
		).toStrictEqual(
			{
				pendingAfterSet: [
					{
						path: ["color", "tags", "#tazebra"],
						value: 3,
					},
				],
				// The clear coalesces into the same pending row, which now delivers the removal.
				pendingAfterClear: [
					{
						path: ["color", "tags", "#tazebra"],
						value: undefined,
					},
				],
			},
		);
	});

	it("maps every palette color to its upstream index", async () =>
	{
		const {local, request} = setup({});
		const colors = ["red", "orange", "yellow", "green", "blue", "purple", "gray", "teal", "sky", "pink"];
		const indexes: unknown[] = [];
		for (const color of colors)
		{
			await request(
				"PUT",
				"/%23t",
				{
					color,
				},
			);
			indexes.push(local.pendingRoot()[0]?.value);
		}
		expect(indexes).toStrictEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
	});

	it("rejects colors outside the palette without writing", async () =>
	{
		const {local, request} = setup({});

		await expect(
			request(
				"PUT",
				"/%23t",
				{
					color: "mauve",
				},
			),
		).resolves.toStrictEqual(
			{
				status: 400,
				body:
				{
					error: "Invalid color: mauve",
				},
			},
		);
		await expect(request("PUT", "/%23t", {})).resolves.toStrictEqual(
			{
				status: 400,
				body:
				{
					error: "Invalid color: (missing)",
				},
			},
		);
		expect(local.pendingRoot()).toStrictEqual([]);
	});
});

describe("DELETE /api/v1/tags/:name", () =>
{
	it("removes the lowercased key", async () =>
	{
		const {local, request} = setup(
			{
				"@alice": 0,
			},
		);

		await expect(request("DELETE", "/%40Alice")).resolves.toStrictEqual(
			{
				status: 200,
				body:
				{
					name: "@Alice",
				},
			},
		);
		expect(
			{
				pending: local.pendingRoot(),
				tags: local.rootMeta()?.color,
			},
		).toStrictEqual(
			{
				pending: [
					{
						path: ["color", "tags", "@alice"],
						value: undefined,
					},
				],
				tags: undefined,
			},
		);
	});
});
