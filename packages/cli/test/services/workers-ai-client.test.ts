import {describe, expect, it, vi} from "vite-plus/test";
import {WorkersAiClefClient} from "../../src/services/workers-ai-client.js";

const REQUEST = {
	model: "clef-flash" as const,
	state: {date: "2026-11-03", parent: "📆 Calendar", entry: "Played pickleball"},
	questions: {"t.pickleball": {type: "noul" as const, instructions: "Is this about #pickleball?"}},
};
const RESULT = {
	model: "clef-flash",
	answers: {"t.pickleball": {type: "noul", noul: 0.98}},
	usage: {input_tokens: 40, output_tokens: 0},
};

describe("WorkersAiClefClient", () => {
	it("posts the request to the model's run endpoint and unwraps the envelope", async () => {
		const fetchStub = vi.fn<typeof fetch>(async () =>
			Promise.resolve(Response.json({result: RESULT, success: true, errors: [], messages: []})),
		);

		const result = await new WorkersAiClefClient("acct", "token", fetchStub).run(REQUEST);

		expect({
			result,
			calls: fetchStub.mock.calls.map(([url, init]) => ({
				url,
				method: init?.method,
				headers: init?.headers,
				body: JSON.parse(typeof init?.body === "string" ? init.body : ""),
			})),
		}).toStrictEqual({
			result: RESULT,
			calls: [
				{
					url: "https://api.cloudflare.com/client/v4/accounts/acct/ai/run/@cf/cloudflare/clef-flash",
					method: "POST",
					headers: {Authorization: "Bearer token", "Content-Type": "application/json"},
					body: REQUEST,
				},
			],
		});
	});

	it("throws with the HTTP status and Workers AI errors on failure", async () => {
		const fetchStub = vi.fn<typeof fetch>(async () =>
			Promise.resolve(
				Response.json(
					{
						result: null,
						success: false,
						errors: [{code: 10_000, message: "Authentication error"}],
						messages: [],
					},
					{status: 401},
				),
			),
		);

		await expect(new WorkersAiClefClient("acct", "bad", fetchStub).run(REQUEST)).rejects.toThrow(
			"Workers AI clef-flash request failed (401): Authentication error",
		);
	});
});
