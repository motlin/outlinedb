import {describe, expect, it} from "vite-plus/test";
import {readJson} from "../src/client/read-json.js";

describe("readJson", () =>
{
	it("returns the parsed response body", async () =>
	{
		const response = Response.json(
			{
				nodes: [
					{
						id: "a",
					},
				],
			},
		);

		const body = await readJson<
		{
			nodes:
			{
				id: string;
			}[];
		}>(response);

		expect(body).toStrictEqual(
			{
				nodes: [
					{
						id: "a",
					},
				],
			},
		);
	});

	it("rejects a body that is not JSON", async () =>
	{
		await expect(readJson(new Response("not json"))).rejects.toThrow(SyntaxError);
	});
});
