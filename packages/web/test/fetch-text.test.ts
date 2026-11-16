import {describe, expect, it} from "vite-plus/test";
import {fetchText} from "../src/client/fetch-text.js";

/** A fetch that answers with one scripted response or error, recording the URLs it saw. */
function scripted(step: Response | Error):
{
	fetch: (url: string) => Promise<Response>;
	urls: string[];
}
{
	const urls: string[] = [];
	const fetchStub = async (input: string): Promise<Response> =>
	{
		urls.push(input);
		if (step instanceof Error)
		{
			throw step;
		}
		return Promise.resolve(step);
	};
	return {
		fetch: fetchStub,
		urls,
	};
}

describe("fetchText", () =>
{
	it("returns the body of a successful answer", async () =>
	{
		const {fetch, urls} = scripted(
			Response.json(
				{
					ok: true,
				},
			),
		);
		const result = await fetchText("/api/v1/decisions/x", {}, fetch);
		expect(
			{
				result,
				urls,
			},
		).toStrictEqual(
			{
				result:
				{
					status: 200,
					ok: true,
					text: '{"ok":true}',
				},
				urls: ["/api/v1/decisions/x"],
			},
		);
	});

	it("returns a 4xx with its body for the caller to show", async () =>
	{
		const {fetch, urls} = scripted(
			new Response(
				'{"error":"bad choice"}',
				{
					status: 400,
				},
			),
		);
		const result = await fetchText(
			"/x",
			{
				method: "PUT",
			},
			fetch,
		);
		expect(
			{
				result,
				calls: urls.length,
			},
		).toStrictEqual(
			{
				result:
				{
					status: 400,
					ok: false,
					text: '{"error":"bad choice"}',
				},
				calls: 1,
			},
		);
	});

	it("makes one attempt and names an empty answer instead of retrying it", async () =>
	{
		const {fetch, urls} = scripted(
			new Response(
				"",
				{
					status: 502,
				},
			),
		);
		await expect(fetchText("/x", {}, fetch)).rejects.toThrow(
			"The server answered HTTP 502 with an empty body; the API may be restarting. Reload to try again.",
		);
		expect(urls).toHaveLength(1);
	});

	it("makes one attempt and names an empty 200 instead of failing to parse it", async () =>
	{
		const {fetch, urls} = scripted(
			new Response(
				"",
				{
					status: 200,
				},
			),
		);
		await expect(fetchText("/x", {}, fetch)).rejects.toThrow(
			"The server answered HTTP 200 with an empty body; the API may be restarting. Reload to try again.",
		);
		expect(urls).toHaveLength(1);
	});

	it("makes one attempt and surfaces a dropped connection", async () =>
	{
		const {fetch, urls} = scripted(new TypeError("Failed to fetch"));
		await expect(fetchText("/x", {}, fetch)).rejects.toThrow(
			"Could not reach the server (Failed to fetch); the API may be restarting. Reload to try again.",
		);
		expect(urls).toHaveLength(1);
	});
});
