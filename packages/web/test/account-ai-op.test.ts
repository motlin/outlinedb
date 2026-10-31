import {describe, expect, it} from "vite-plus/test";
import type {WorkflowyInternalAdapter} from "@workflowy/shared/internal";
import {createHttpApp} from "../src/server/http/app.js";
import {inProcessStore} from "../src/server/store.js";
import {INTERNAL_API_NOT_CONFIGURED} from "../src/server/internal-api-error.js";
import type {ServerContext} from "../src/server/context.js";

function contextWith(adapter: Partial<WorkflowyInternalAdapter> | undefined): ServerContext {
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a partial context is all the op reads
	return {internalAdapter: () => adapter, config: {accountEmail: ""}} as unknown as ServerContext;
}

function adapterWith(ai: unknown, rootMeta: Record<string, unknown>): Partial<WorkflowyInternalAdapter> {
	return {
		getSetting: async (name: string) => Promise.resolve(name === "ai" ? ai : undefined),
		getRootMeta: async (path: string[]) => Promise.resolve(rootMeta[path.join(".")]),
	};
}

const AI_SETTINGS = {
	assistants: [
		{id: "assistant_a", name: "Assistant A", model: "vendor/model-a", system_user_id: -5},
		{id: "assistant_b", name: "Assistant B", model: "vendor/model-b", system_user_id: -6},
	],
	default_agent_id: "assistant_b",
	prompt_buttons: {reply: [{id: "summarise_key_info", name: "Summarize", icon: "align-left"}]},
	context_limit: 1000,
};

describe("account.ai op", () => {
	it("answers settings ai.* and root metadata ai.mailboxId", async () => {
		const adapter = adapterWith(AI_SETTINGS, {"ai.mailboxId": "mailbox-id"});

		await expect(inProcessStore(contextWith(adapter)).call("account.ai", {})).resolves.toStrictEqual({
			ok: true,
			value: {
				assistants: [
					{id: "assistant_a", name: "Assistant A", model: "vendor/model-a", systemUserId: -5},
					{id: "assistant_b", name: "Assistant B", model: "vendor/model-b", systemUserId: -6},
				],
				defaultAgentId: "assistant_b",
				promptButtons: {
					draft: [],
					reply: [{id: "summarise_key_info", name: "Summarize", icon: "align-left"}],
				},
				contextLimit: 1000,
				mailboxId: "mailbox-id",
			},
		});
	});

	it("falls back to upstream's defaults: no assistants or buttons, a context limit of 500, no mailbox", async () => {
		await expect(
			inProcessStore(contextWith(adapterWith(undefined, {}))).call("account.ai", {}),
		).resolves.toStrictEqual({
			ok: true,
			value: {
				assistants: [],
				defaultAgentId: null,
				promptButtons: {draft: [], reply: []},
				contextLimit: 500,
				mailboxId: null,
			},
		});
	});

	it("fails with 503 when the internal API is not configured", async () => {
		await expect(inProcessStore(contextWith(undefined)).call("account.ai", {})).resolves.toStrictEqual({
			ok: false,
			status: 503,
			body: {error: INTERNAL_API_NOT_CONFIGURED},
		});
	});
});

describe("GET /api/v1/account/ai", () => {
	it("serves the op's result", async () => {
		const app = createHttpApp({
			resolveStore: () => inProcessStore(contextWith(adapterWith(AI_SETTINGS, {}))),
		});

		const response = await app.fetch(new Request("http://x/api/v1/account/ai"));

		expect({status: response.status, body: await response.json()}).toStrictEqual({
			status: 200,
			body: {
				assistants: [
					{id: "assistant_a", name: "Assistant A", model: "vendor/model-a", systemUserId: -5},
					{id: "assistant_b", name: "Assistant B", model: "vendor/model-b", systemUserId: -6},
				],
				defaultAgentId: "assistant_b",
				promptButtons: {
					draft: [],
					reply: [{id: "summarise_key_info", name: "Summarize", icon: "align-left"}],
				},
				contextLimit: 1000,
				mailboxId: null,
			},
		});
	});
});
