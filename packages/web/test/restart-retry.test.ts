import {describe, expect, it} from "vite-plus/test";
import {fetchThroughRestarts} from "../src/client/restart-retry.js";

type Step = Response | Error;

/** A fetch that answers each call with the next scripted step, recording the URLs it saw. */
function scripted(steps: Step[]):
{
	fetch: (url: string) => Promise<Response>;
	urls: string[];
}
{
	const urls: string[] = [];
	const fetchStub = async (input: string): Promise<Response> =>
	{
		urls.push(input);
		const step = steps.shift();
		if (step === undefined)
		{
			throw new Error("no more steps");
		}
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

const noSleep = async (): Promise<void> => Promise.resolve();

describe("fetchThroughRestarts", () =>
{
	it("retries an empty 200, a 502 and a dropped connection while the dev API restarts, then returns the real body", async () =>
	{
		const {fetch, urls} = scripted([
			new Response(
				"",
				{
					status: 200,
				},
			),
			new Response(
				"Bad Gateway",
				{
					status: 502,
				},
			),
			new TypeError("Failed to fetch"),
			Response.json(
				{
					ok: true,
				},
			),
		]);
		const result = await fetchThroughRestarts(
			"/api/v1/decisions/x",
			{},
			{
				fetch,
				sleep: noSleep,
			},
		);
		expect(
			{
				status: result.status,
				text: result.text,
				urls,
			},
		).toStrictEqual(
			{
				status: 200,
				text: '{"ok":true}',
				urls: ["/api/v1/decisions/x", "/api/v1/decisions/x", "/api/v1/decisions/x", "/api/v1/decisions/x"],
			},
		);
	});

	it("returns a 4xx at once instead of retrying it", async () =>
	{
		const {fetch, urls} = scripted([
			new Response(
				'{"error":"bad choice"}',
				{
					status: 400,
				},
			),
		]);
		const result = await fetchThroughRestarts(
			"/x",
			{
				method: "PUT",
			},
			{
				fetch,
				sleep: noSleep,
			},
		);
		expect(
			{
				status: result.status,
				text: result.text,
				calls: urls.length,
			},
		).toStrictEqual(
			{
				status: 400,
				text: '{"error":"bad choice"}',
				calls: 1,
			},
		);
	});

	it("gives up after the attempt budget with the last failure", async () =>
	{
		const {fetch, urls} = scripted([
			new Response(
				"",
				{
					status: 503,
				},
			),
			new Response(
				"",
				{
					status: 503,
				},
			),
			new Response(
				"",
				{
					status: 503,
				},
			),
		]);
		await expect(
			fetchThroughRestarts(
				"/x",
				{},
				{
					fetch,
					sleep: noSleep,
					attempts: 3,
				},
			),
		).rejects.toThrow(
			"The server did not answer after 3 attempts (HTTP 503 with an empty body); it may be restarting.",
		);
		expect(urls).toHaveLength(3);
	});

	it("stops retrying once the caller aborts", async () =>
	{
		const controller = new AbortController();
		const {fetch, urls} = scripted([
			new Response(
				"",
				{
					status: 502,
				},
			),
			Response.json(
				{
					ok: true,
				},
			),
		]);
		const sleep = async (): Promise<void> =>
		{
			controller.abort();
			return Promise.resolve();
		};
		await expect(
			fetchThroughRestarts(
				"/x",
				{
					signal: controller.signal,
				},
				{
					fetch,
					sleep,
				},
			),
		).rejects.toThrow("aborted");
		expect(urls).toHaveLength(1);
	});
});
