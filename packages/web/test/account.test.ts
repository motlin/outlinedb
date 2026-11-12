import {describe, expect, it, vi} from "vite-plus/test";
import type {WorkflowyInternalAdapter} from "@outlinedb/shared/internal";
import {createHttpApp} from "../src/server/http/app.js";
import {inProcessStore} from "../src/server/store.js";
import {INTERNAL_API_NOT_CONFIGURED} from "../src/server/internal-api-error.js";
import type {ServerContext} from "../src/server/context.js";
import {httpAppFor} from "./http-app-for.js";
import {mirrorWithoutInternalApi, standaloneContext} from "./helpers/local-context.js";

describe("account ai op", () =>
{
	function contextWith(adapter: Partial<WorkflowyInternalAdapter> | undefined): ServerContext
	{
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a partial context is all the op reads
		return {
			internalAdapter: () => adapter,
			config:
			{
				accountEmail: "",
			},
		} as unknown as ServerContext;
	}

	function adapterWith(ai: unknown, rootMeta: Record<string, unknown>): Partial<WorkflowyInternalAdapter>
	{
		return {
			getSetting: async (name: string) => Promise.resolve(name === "ai" ? ai : undefined),
			getRootMeta: async (path: string[]) => Promise.resolve(rootMeta[path.join(".")]),
		};
	}

	const AI_SETTINGS =
	{
		assistants: [
			{
				id: "assistant_a",
				name: "Assistant A",
				model: "vendor/model-a",
				system_user_id: -5,
			},
			{
				id: "assistant_b",
				name: "Assistant B",
				model: "vendor/model-b",
				system_user_id: -6,
			},
		],
		default_agent_id: "assistant_b",
		prompt_buttons:
		{
			reply: [
				{
					id: "summarise_key_info",
					name: "Summarize",
					icon: "align-left",
				},
			],
		},
		context_limit: 1000,
	};

	describe("account.ai op", () =>
	{
		it("answers settings ai.* and root metadata ai.mailboxId", async () =>
		{
			const adapter = adapterWith(
				AI_SETTINGS,
				{
					"ai.mailboxId": "mailbox-id",
				},
			);

			await expect(inProcessStore(contextWith(adapter)).call("account.ai", {})).resolves.toStrictEqual(
				{
					ok: true,
					value:
					{
						assistants: [
							{
								id: "assistant_a",
								name: "Assistant A",
								model: "vendor/model-a",
								systemUserId: -5,
							},
							{
								id: "assistant_b",
								name: "Assistant B",
								model: "vendor/model-b",
								systemUserId: -6,
							},
						],
						defaultAgentId: "assistant_b",
						promptButtons:
						{
							draft: [],
							reply: [
								{
									id: "summarise_key_info",
									name: "Summarize",
									icon: "align-left",
								},
							],
						},
						contextLimit: 1000,
						mailboxId: "mailbox-id",
					},
				},
			);
		});

		it("falls back to upstream's defaults: no assistants or buttons, a context limit of 500, no mailbox", async () =>
		{
			await expect(
				inProcessStore(contextWith(adapterWith(undefined, {}))).call("account.ai", {}),
			).resolves.toStrictEqual(
				{
					ok: true,
					value:
					{
						assistants: [],
						defaultAgentId: null,
						promptButtons:
						{
							draft: [],
							reply: [],
						},
						contextLimit: 500,
						mailboxId: null,
					},
				},
			);
		});

		it("fails with 503 when the internal API is not configured", async () =>
		{
			await expect(inProcessStore(contextWith(undefined)).call("account.ai", {})).resolves.toStrictEqual(
				{
					ok: false,
					status: 503,
					body:
					{
						error: INTERNAL_API_NOT_CONFIGURED,
					},
				},
			);
		});
	});

	describe("GET /api/v1/account/ai", () =>
	{
		it("serves the op's result", async () =>
		{
			const app = createHttpApp(
				{
					resolveStore: () => inProcessStore(contextWith(adapterWith(AI_SETTINGS, {}))),
				},
			);

			const response = await app.fetch(new Request("http://x/api/v1/account/ai"));

			expect(
				{
					status: response.status,
					body: await response.json(),
				},
			).toStrictEqual(
				{
					status: 200,
					body:
					{
						assistants: [
							{
								id: "assistant_a",
								name: "Assistant A",
								model: "vendor/model-a",
								systemUserId: -5,
							},
							{
								id: "assistant_b",
								name: "Assistant B",
								model: "vendor/model-b",
								systemUserId: -6,
							},
						],
						defaultAgentId: "assistant_b",
						promptButtons:
						{
							draft: [],
							reply: [
								{
									id: "summarise_key_info",
									name: "Summarize",
									icon: "align-left",
								},
							],
						},
						contextLimit: 1000,
						mailboxId: null,
					},
				},
			);
		});
	});
});

describe("account op", () =>
{
	function contextWith(adapter: Partial<WorkflowyInternalAdapter> | undefined): ServerContext
	{
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a partial context is all the op reads
		return {
			internalAdapter: () => adapter,
			config:
			{
				accountEmail: "user@example.com",
			},
		} as unknown as ServerContext;
	}

	const adapter =
	{
		getAccount: vi.fn<WorkflowyInternalAdapter["getAccount"]>(async () =>
			Promise.resolve(
				{
					userId: "7",
					joinedAt: new Date("2020-01-02T00:00:00Z"),
					fullName: "Alice Smith",
				},
			),
		),
	};

	describe("account.get op", () =>
	{
		it("answers the user id, ISO join date, full name and email", async () =>
		{
			await expect(inProcessStore(contextWith(adapter)).call("account.get", {})).resolves.toStrictEqual(
				{
					ok: true,
					value:
					{
						userId: "7",
						joinedAt: "2020-01-02T00:00:00.000Z",
						fullName: "Alice Smith",
						email: "user@example.com",
					},
				},
			);
		});

		it("fails with 503 when the internal API is not configured", async () =>
		{
			await expect(inProcessStore(contextWith(undefined)).call("account.get", {})).resolves.toStrictEqual(
				{
					ok: false,
					status: 503,
					body:
					{
						error: INTERNAL_API_NOT_CONFIGURED,
					},
				},
			);
		});
	});

	describe("GET /api/v1/account through the HTTP layer", () =>
	{
		it("builds the response from the store's result", async () =>
		{
			const app = createHttpApp(
				{
					resolveStore: () => inProcessStore(contextWith(adapter)),
				},
			);

			const response = await app.fetch(new Request("http://x/api/v1/account"));

			expect(
				{
					status: response.status,
					body: await response.json(),
				},
			).toStrictEqual(
				{
					status: 200,
					body:
					{
						userId: "7",
						joinedAt: "2020-01-02T00:00:00.000Z",
						fullName: "Alice Smith",
						email: "user@example.com",
					},
				},
			);
		});

		it("passes the 503 through", async () =>
		{
			const app = createHttpApp(
				{
					resolveStore: () => inProcessStore(contextWith(undefined)),
				},
			);

			const response = await app.fetch(new Request("http://x/api/v1/account"));

			expect(
				{
					status: response.status,
					body: await response.json(),
				},
			).toStrictEqual(
				{
					status: 503,
					body:
					{
						error: INTERNAL_API_NOT_CONFIGURED,
					},
				},
			);
		});
	});
});

describe("account route", () =>
{
	describe("GET /api/v1/account", () =>
	{
		it("answers the user id, join date, full name and email", async () =>
		{
			const adapter =
			{
				getAccount: vi.fn<WorkflowyInternalAdapter["getAccount"]>(async () =>
					Promise.resolve(
						{
							userId: "7",
							joinedAt: new Date("2020-01-02T00:00:00Z"),
							fullName: "Alice Smith",
						},
					),
				),
			};
			const ctx =
			{
				internalAdapter: () => adapter as unknown as WorkflowyInternalAdapter,
				config:
				{
					accountEmail: "user@example.com",
				},
			} as unknown as ServerContext;
			const app = httpAppFor(ctx);

			const res = await app.fetch(new Request("http://x/api/v1/account"));

			expect(
				{
					status: res.status,
					body: await res.json(),
				},
			).toStrictEqual(
				{
					status: 200,
					body:
					{
						userId: "7",
						joinedAt: "2020-01-02T00:00:00.000Z",
						fullName: "Alice Smith",
						email: "user@example.com",
					},
				},
			);
		});
	});
});

describe("account state unavailable", () =>
{
	interface Route
	{
		method: string;
		path: string;
		body?: unknown;
	}

	async function statuses(ctx: ServerContext, routes: readonly Route[]): Promise<string[]>
	{
		const app = httpAppFor(ctx);
		const responses = [];
		for (const {method, path, body} of routes)
		{
			const res = await app.fetch(
				new Request(
					`http://x${path}`,
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
			responses.push(`${method} ${path} ${res.status} ${await res.text()}`);
		}
		return responses;
	}

	const UNAVAILABLE = JSON.stringify(
		{
			error: INTERNAL_API_NOT_CONFIGURED,
		},
	);

	/** The routes that read or write account-global state. */
	const ACCOUNT_ROUTES: readonly Route[] = [
		{
			method: "GET",
			path: "/api/v1/account",
		},
		{
			method: "GET",
			path: "/api/v1/tags",
		},
		{
			method: "PUT",
			path: "/api/v1/tags/%23home",
			body:
			{
				color: "red",
			},
		},
		{
			method: "DELETE",
			path: "/api/v1/tags/%23home",
		},
		{
			method: "GET",
			path: "/api/v1/stars",
		},
		{
			method: "PUT",
			path: "/api/v1/stars/order",
			body:
			{
				keys: [],
			},
		},
		{
			method: "GET",
			path: "/api/v1/preferences",
		},
		{
			method: "PATCH",
			path: "/api/v1/preferences",
			body:
			{
				dateFormat: "MM/DD/YYYY",
			},
		},
	];

	describe("account state with nowhere to keep it", () =>
	{
		it("answers 503 in a mirror without the internal API, writing nothing locally, so it never diverges from workflowy.com", async () =>
		{
			const routes: Route[] = [
				...ACCOUNT_ROUTES,
				{
					method: "GET",
					path: "/api/v1/expansion",
				},
				{
					method: "PATCH",
					path: "/api/v1/expansion",
					body:
					{
						changes: {},
					},
				},
				{
					method: "GET",
					path: "/api/v1/expansion/left-bar",
				},
				{
					method: "PATCH",
					path: "/api/v1/expansion/left-bar",
					body:
					{
						changes: {},
					},
				},
				{
					method: "POST",
					path: "/api/v1/features/dates",
					body:
					{
						on: false,
					},
				},
			];

			await expect(statuses(mirrorWithoutInternalApi(), routes)).resolves.toStrictEqual(
				routes.map(({method, path}) => `${method} ${path} 503 ${UNAVAILABLE}`),
			);
		});

		it("answers 503 in a standalone store with no provisioned account row, rather than inventing one", async () =>
		{
			await expect(statuses(standaloneContext(null), ACCOUNT_ROUTES)).resolves.toStrictEqual(
				ACCOUNT_ROUTES.map(({method, path}) => `${method} ${path} 503 ${UNAVAILABLE}`),
			);
		});
	});
});
