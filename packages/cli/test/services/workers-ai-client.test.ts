import fs from "node:fs";
import {describe, expect, it, vi} from "vite-plus/test";
import type {ChoiceQuestion, ClefRequest, NoulQuestion} from "../../src/services/clef-requests.js";
import {WorkersAiClefClient} from "../../src/services/workers-ai-client.js";

/** A real Workers AI exchange captured on 2026-11-05 with placeholder labels. */
interface Fixture
{
	readonly request: ClefRequest<ChoiceQuestion | NoulQuestion>;
	readonly status: number;
	readonly body:
	{
		readonly result: unknown;
	};
}

function fixture(name: string): Fixture
{
	return JSON.parse(fs.readFileSync(new URL(`fixtures/workers-ai/${name}.json`, import.meta.url), "utf8")) as Fixture;
}

const PASS1 = fixture("pass1-shortlist");
const PASS2 = fixture("pass2-verify");
const BAD_REQUEST = fixture("bad-request");
const BAD_TOKEN = fixture("bad-token");

function replay(...responses: (Fixture | Response)[])
{
	return vi.fn<typeof fetch>(async () =>
	{
		const next = responses.shift();
		if (next === undefined)
		{
			throw new Error("no more stubbed responses");
		}
		return Promise.resolve(
			next instanceof Response
				? next
				: Response.json(
						next.body,
						{
							status: next.status,
						},
					),
		);
	});
}

function client(fetchStub: typeof fetch, sleep = vi.fn<(ms: number) => Promise<void>>(async () => Promise.resolve()))
{
	return {
		client: new WorkersAiClefClient("acct", "token", fetchStub, sleep),
		sleep,
	};
}

describe("WorkersAiClefClient", () =>
{
	it("posts a pass 2 request to the model's run endpoint and unwraps the envelope", async () =>
	{
		const fetchStub = replay(PASS2);

		const result = await client(fetchStub).client.run(PASS2.request);

		expect(
			{
				result,
				calls: fetchStub.mock.calls.map(([url, init]) => (
				{
					url,
					method: init?.method,
					headers: init?.headers,
					body: JSON.parse(typeof init?.body === "string" ? init.body : ""),
				})),
			},
		).toStrictEqual(
			{
				result:
				{
					model: "clef-flash",
					answers:
					{
						"p.AliceBrown":
						{
							type: "noul",
							noul: 0.1329,
						},
						"p.AliceChen":
						{
							type: "noul",
							noul: 0.1798,
						},
						"t.pickleball":
						{
							type: "noul",
							noul: 0.9526,
						},
					},
					usage:
					{
						input_tokens: 386,
						output_tokens: 0,
					},
				},
				calls: [
					{
						url: "https://api.cloudflare.com/client/v4/accounts/acct/ai/run/@cf/cloudflare/clef-flash",
						method: "POST",
						headers:
						{
							Authorization: "Bearer token",
							"Content-Type": "application/json",
						},
						body: PASS2.request,
					},
				],
			},
		);
	});

	it("unwraps a pass 1 choice response", async () =>
	{
		const result = await client(replay(PASS1)).client.run(PASS1.request);

		expect(result).toStrictEqual(
			{
				model: "clef-flash",
				answers:
				{
					"people.1":
					{
						type: "choice",
						choice: "p.AliceChen",
						probabilities:
						{
							"p.AliceBrown": 0.2739,
							"p.AliceChen": 0.6316,
							"p.Bob": 0.0074,
							none: 0.0871,
						},
						confidence: 0.3087,
					},
					"tags.1":
					{
						type: "choice",
						choice: "t.pickleball",
						probabilities:
						{
							"t.pickleball": 0.9592,
							"t.cooking": 0.0032,
							"t.reading": 0.0028,
							none: 0.0348,
						},
						confidence: 0.895,
					},
				},
				usage:
				{
					input_tokens: 351,
					output_tokens: 0,
				},
			},
		);
	});

	it("throws the Workers AI error on a 400 without retrying", async () =>
	{
		const {client: clef, sleep} = client(replay(BAD_REQUEST));

		await expect(clef.run(BAD_REQUEST.request)).rejects.toThrow(
			"Workers AI clef-flash request failed (400): AiError: Bad input: Error: required properties at '/' are 'model,state,questions' (d5394f7b-41fc-4782-bb5d-5bdcd611e63e)",
		);
		expect(sleep.mock.calls).toStrictEqual([]);
	});

	it("throws the Workers AI error on a 401 without retrying", async () =>
	{
		const {client: clef, sleep} = client(replay(BAD_TOKEN));

		await expect(clef.run(BAD_TOKEN.request)).rejects.toThrow(
			"Workers AI clef-flash request failed (401): Authentication error",
		);
		expect(sleep.mock.calls).toStrictEqual([]);
	});

	it("retries 429 and 5xx with exponential backoff, then returns the result", async () =>
	{
		const fetchStub = replay(
			Response.json(
				{
					result: null,
					success: false,
					errors: [
						{
							message: "Rate limited",
						},
					],
				},
				{
					status: 429,
				},
			),
			new Response(
				"<html>Bad gateway</html>",
				{
					status: 502,
				},
			),
			Response.json(
				{
					result: null,
					success: false,
					errors: [
						{
							message: "Internal error",
						},
					],
				},
				{
					status: 500,
				},
			),
			PASS2,
		);
		const {client: clef, sleep} = client(fetchStub);

		const result = await clef.run(PASS2.request);

		expect(
			{
				calls: fetchStub.mock.calls.length,
				sleeps: sleep.mock.calls,
				model: result.model,
			},
		).toStrictEqual(
			{
				calls: 4,
				sleeps: [[500], [1000], [2000]],
				model: "clef-flash",
			},
		);
	});

	it("gives up after four attempts and reports the last failure", async () =>
	{
		const busy = () =>
			new Response(
				"<html>Service unavailable</html>",
				{
					status: 503,
				},
			);
		const fetchStub = replay(busy(), busy(), busy(), busy());
		const {client: clef, sleep} = client(fetchStub);

		await expect(clef.run(PASS2.request)).rejects.toThrow(
			"Workers AI clef-flash request failed (503): <html>Service unavailable</html>",
		);
		expect(
			{
				calls: fetchStub.mock.calls.length,
				sleeps: sleep.mock.calls,
			},
		).toStrictEqual(
			{
				calls: 4,
				sleeps: [[500], [1000], [2000]],
			},
		);
	});

	it("throws a schema-mismatch error when a successful result has the wrong shape", async () =>
	{
		const fetchStub = replay(
			Response.json(
				{
					result:
					{
						model: "clef-flash",
						answers:
						{
							"t.pickleball":
							{
								type: "noul",
								noul: "high",
							},
						},
					},
					success: true,
					errors: [],
					messages: [],
				},
			),
		);

		await expect(client(fetchStub).client.run(PASS2.request)).rejects.toThrow(
			/^Workers AI clef-flash response did not match the Clef schema: /u,
		);
	});

	it("throws when an answer's type does not match its question's type", async () =>
	{
		const fetchStub = replay(
			{
				...PASS2,
				body:
				{
					...PASS2.body,
					result:
					{
						model: "clef-flash",
						answers:
						{
							"p.AliceBrown":
							{
								type: "noul",
								noul: 0.1329,
							},
							"p.AliceChen":
							{
								type: "noul",
								noul: 0.1798,
							},
							"t.pickleball":
							{
								type: "choice",
								choice: "yes",
								probabilities:
								{
									yes: 1,
								},
								confidence: 1,
							},
						},
						usage:
						{
							input_tokens: 386,
							output_tokens: 0,
						},
					},
				},
			},
		);

		await expect(client(fetchStub).client.run(PASS2.request)).rejects.toThrow(
			"Workers AI clef-flash response did not match the Clef schema: t.pickleball: expected a noul answer, got choice",
		);
	});

	it("throws when a question has no answer", async () =>
	{
		const fetchStub = replay(
			{
				...PASS2,
				body:
				{
					...PASS2.body,
					result:
					{
						model: "clef-flash",
						answers:
						{
							"p.AliceBrown":
							{
								type: "noul",
								noul: 0.1329,
							},
						},
						usage:
						{
							input_tokens: 386,
							output_tokens: 0,
						},
					},
				},
			},
		);

		await expect(client(fetchStub).client.run(PASS2.request)).rejects.toThrow(
			"Workers AI clef-flash response did not match the Clef schema: p.AliceChen: missing answer; t.pickleball: missing answer",
		);
	});
});
