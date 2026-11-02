import {describe, expect, it} from "vite-plus/test";
import {Hono} from "hono";
import {gunzipSync} from "node:zlib";
import {apiCompression} from "../src/server/compression.js";

const IDS = Array.from(
	{
		length: 200,
	},
	(_, index) => `1a2b3c4d-0000-4000-8000-${String(index).padStart(12, "0")}`,
);

function setup()
{
	const app = new Hono();
	app.use("/api/*", apiCompression());
	app.get("/api/v1/expansion", (c) =>
		c.json(
			{
				expandedIds: IDS,
			},
		),
	);
	app.get("/api/v1/ladder/events", (c) =>
		c.json(
			{
				expandedIds: IDS,
			},
		),
	);
	return async (path: string, acceptEncoding?: string) =>
	{
		const res = await app.fetch(
			new Request(
				`http://x${path}`,
				{
					headers:
						acceptEncoding === undefined
							? {}
							:
								{
									"accept-encoding": acceptEncoding,
								},
				},
			),
		);
		const bytes = Buffer.from(await res.arrayBuffer());
		const encoding = res.headers.get("content-encoding");
		return {
			encoding,
			body: JSON.parse((encoding === "gzip" ? gunzipSync(bytes) : bytes).toString("utf8")) as unknown,
		};
	};
}

describe("apiCompression", () =>
{
	it("gzips a JSON API response when the client accepts gzip", async () =>
	{
		const get = setup();

		await expect(get("/api/v1/expansion", "gzip, deflate, br")).resolves.toStrictEqual(
			{
				encoding: "gzip",
				body:
				{
					expandedIds: IDS,
				},
			},
		);
	});

	it("sends the response as-is when the client does not ask for compression", async () =>
	{
		const get = setup();

		await expect(get("/api/v1/expansion")).resolves.toStrictEqual(
			{
				encoding: null,
				body:
				{
					expandedIds: IDS,
				},
			},
		);
	});

	it("leaves the ladder WebSocket route alone", async () =>
	{
		const get = setup();

		await expect(get("/api/v1/ladder/events", "gzip")).resolves.toStrictEqual(
			{
				encoding: null,
				body:
				{
					expandedIds: IDS,
				},
			},
		);
	});
});
