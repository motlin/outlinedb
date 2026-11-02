import {describe, expect, it} from "vite-plus/test";
import type {ServerContext} from "../src/server/context.js";
import {INTERNAL_API_NOT_CONFIGURED} from "../src/server/internal-api-error.js";
import {mirrorWithoutInternalApi, standaloneContext} from "./helpers/local-context.js";
import {httpAppFor} from "./http-app-for.js";

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
