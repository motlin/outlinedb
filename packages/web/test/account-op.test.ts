import {describe, expect, it, vi} from "vite-plus/test";
import type {WorkflowyInternalAdapter} from "@outlinedb/shared/internal";
import {createHttpApp} from "../src/server/http/app.js";
import {inProcessStore} from "../src/server/store.js";
import {INTERNAL_API_NOT_CONFIGURED} from "../src/server/internal-api-error.js";
import type {ServerContext} from "../src/server/context.js";

function contextWith(adapter: Partial<WorkflowyInternalAdapter> | undefined): ServerContext {
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a partial context is all the op reads
	return {
		internalAdapter: () => adapter,
		config: {accountEmail: "user@example.com"},
	} as unknown as ServerContext;
}

const adapter = {
	getAccount: vi.fn<WorkflowyInternalAdapter["getAccount"]>(async () =>
		Promise.resolve({userId: "7", joinedAt: new Date("2020-01-02T00:00:00Z"), fullName: "Alice Smith"}),
	),
};

describe("account.get op", () => {
	it("answers the user id, ISO join date, full name and email", async () => {
		await expect(inProcessStore(contextWith(adapter)).call("account.get", {})).resolves.toStrictEqual({
			ok: true,
			value: {
				userId: "7",
				joinedAt: "2020-01-02T00:00:00.000Z",
				fullName: "Alice Smith",
				email: "user@example.com",
			},
		});
	});

	it("fails with 503 when the internal API is not configured", async () => {
		await expect(inProcessStore(contextWith(undefined)).call("account.get", {})).resolves.toStrictEqual({
			ok: false,
			status: 503,
			body: {error: INTERNAL_API_NOT_CONFIGURED},
		});
	});
});

describe("GET /api/v1/account through the HTTP layer", () => {
	it("builds the response from the store's result", async () => {
		const app = createHttpApp({resolveStore: () => inProcessStore(contextWith(adapter))});

		const response = await app.fetch(new Request("http://x/api/v1/account"));

		expect({status: response.status, body: await response.json()}).toStrictEqual({
			status: 200,
			body: {
				userId: "7",
				joinedAt: "2020-01-02T00:00:00.000Z",
				fullName: "Alice Smith",
				email: "user@example.com",
			},
		});
	});

	it("passes the 503 through", async () => {
		const app = createHttpApp({resolveStore: () => inProcessStore(contextWith(undefined))});

		const response = await app.fetch(new Request("http://x/api/v1/account"));

		expect({status: response.status, body: await response.json()}).toStrictEqual({
			status: 503,
			body: {error: INTERNAL_API_NOT_CONFIGURED},
		});
	});
});
