import {describe, expect, it} from "vite-plus/test";
import {fetchMentionAccount} from "../src/client/hooks/use-account.js";

function fetchFrom(routes: Record<string, Response>): typeof fetch {
	return async (input) =>
		Promise.resolve(routes[typeof input === "string" ? input : ""] ?? new Response(null, {status: 404}));
}

const ACCOUNT = {userId: 7, joinedAt: "2020-01-02T00:00:00.000Z", fullName: "Alice Smith", email: ""};

describe("fetchMentionAccount", () => {
	it("adds each AI assistant's name keyed by its system user id", async () => {
		const ai = {
			assistants: [
				{id: "assistant_a", name: "Assistant A", model: null, systemUserId: -5},
				{id: "assistant_b", name: null, model: null, systemUserId: -6},
				{id: "assistant_c", name: "Assistant C", model: null, systemUserId: null},
			],
			defaultAgentId: null,
			promptButtons: {draft: [], reply: []},
			contextLimit: 500,
			mailboxId: null,
		};

		await expect(
			fetchMentionAccount(
				fetchFrom({"/api/v1/account": Response.json(ACCOUNT), "/api/v1/account/ai": Response.json(ai)}),
			),
		).resolves.toStrictEqual({
			userId: 7,
			fullName: "Alice Smith",
			joinedAt: "2020-01-02T00:00:00.000Z",
			assistantNames: {"-5": "Assistant A"},
		});
	});

	it("keeps the account without assistant names when the AI settings fail, and is null when the account fails", async () => {
		await expect(
			Promise.all([
				fetchMentionAccount(fetchFrom({"/api/v1/account": Response.json(ACCOUNT)})),
				fetchMentionAccount(fetchFrom({})),
			]),
		).resolves.toStrictEqual([
			{userId: 7, fullName: "Alice Smith", joinedAt: "2020-01-02T00:00:00.000Z", assistantNames: {}},
			null,
		]);
	});
});
