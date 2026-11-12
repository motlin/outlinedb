/**
 * A `fetch` stub standing in for Workflowy's internal (session-cookie) API.
 * It records every request and serves canned responses per route; a test can
 * queue one-shot responses for a route to script sequences like "302, then OK".
 */

export interface RecordedRequest
{
	method: string;
	url: string;
	path: string;
	headers: Record<string, string>;
	body: string | undefined;
}

export type FakeRoute =
	| "/ajax_login"
	| "/get_initialization_data"
	| "/get_tree_data/"
	| "/get_user_data/"
	| "/push_and_poll"
	| "/change_settings"
	| `/features/${"enable" | "disable"}/${string}`;

type Responder = (request: RecordedRequest) => Response | Promise<Response>;

export const FAKE_SESSION_ID = "fake-session-1";
export const FAKE_CLIENT_ID = "2026-10-17 12:00:00.000000_fakeclient";

export function initializationData(mainProjectTreeInfo: Record<string, unknown> = {}): Record<string, unknown>
{
	return {
		projectTreeData:
		{
			mainProjectTreeInfo:
			{
				rootProject: null,
				rootProjectChildren: [],
				initialMostRecentOperationTransactionId: "4567",
				serverExpandedProjectsList: ["1a2b3c4d"],
				isReadOnly: false,
				ownerId: 123,
				dateJoinedTimestampInSeconds: 1_500_000_000,
				...mainProjectTreeInfo,
			},
			auxiliaryProjectTreeInfos: [],
			rootProjectMetadata:
			{
				starring:
				{
					locations:
					{
						abc: "None",
					},
				},
			},
		},
		settings:
		{
			theme: "dark",
			show_completed: true,
		},
		user:
		{
			id: 123,
			email: "alice@example.com",
		},
		globals: [
			["CLIENT_VERSION", 25],
			["FULL_OFFLINE_ENABLED", false],
		],
		features: [],
	};
}

export function json(body: unknown, init: ResponseInit = {}): Response
{
	const headers = new Headers(init.headers);
	headers.set("Content-Type", "application/json");
	return Response.json(
		body,
		{
			...init,
			headers,
		},
	);
}

function isFakeRoute(path: string): path is FakeRoute
{
	return Object.hasOwn(defaultResponders(), path) || path.startsWith("/features/");
}

function defaultResponders(): Record<string, Responder>
{
	return {
		"/ajax_login": () =>
			new Response(
				"",
				{
					status: 200,
					headers:
					{
						"set-cookie": `sessionid=${FAKE_SESSION_ID}; Path=/; HttpOnly`,
					},
				},
			),
		"/get_initialization_data": () =>
			json(
				initializationData(),
				{
					headers:
					{
						wfclientid: FAKE_CLIENT_ID,
					},
				},
			),
		"/get_tree_data/": () =>
			json(
				{
					items: [],
					shared_projects: {},
					most_recent_operation_transaction_id: "9999",
					server_expanded_projects_list: [],
				},
			),
		"/get_user_data/": () =>
			json(
				{
					user:
					{
						id: 123,
						email: "alice@example.com",
					},
				},
			),
		"/push_and_poll": () =>
			json(
				{
					results: [
						{
							new_most_recent_operation_transaction_id: "4568",
						},
					],
				},
			),
		"/change_settings": () =>
			json(
				{
					success: true,
				},
			),
	};
}

export interface FakeInternalApi
{
	fetch: typeof fetch;
	requests: RecordedRequest[];
	/** Replace the standing response for a route. */
	respond(route: FakeRoute, responder: Responder): void;
	/** Serve `responder` for the next request to `route` only, ahead of the standing response. */
	respondOnce(route: FakeRoute, responder: Responder): void;
}

export function createFakeInternalApi(): FakeInternalApi
{
	const requests: RecordedRequest[] = [];
	const standing = defaultResponders();
	const queued = new Map<FakeRoute, Responder[]>();

	const fakeFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> =>
	{
		const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
		const body = init?.body;
		if (body !== undefined && body !== null && typeof body !== "string")
		{
			return Promise.reject(new TypeError("fake internal API expects string request bodies"));
		}
		const request: RecordedRequest =
		{
			method: init?.method ?? "GET",
			url: url.href,
			path: url.pathname,
			headers: Object.fromEntries(new Headers(init?.headers).entries()),
			body: body ?? undefined,
		};
		requests.push(request);
		const route = request.path;
		if (!isFakeRoute(route))
		{
			return Promise.resolve(
				new Response(
					"not found",
					{
						status: 404,
					},
				),
			);
		}
		const next = queued.get(route)?.shift();
		return Promise.resolve((next ?? standing[route] ?? (() => json({})))(request));
	};

	return {
		fetch: fakeFetch,
		requests,
		respond(route, responder)
		{
			standing[route] = responder;
		},
		respondOnce(route, responder)
		{
			const list = queued.get(route) ?? [];
			list.push(responder);
			queued.set(route, list);
		},
	};
}

/** How many `/get_tree_data/` (whole-account) reads `api` has served so far. */
export function treeDataReads(api: Pick<FakeInternalApi, "requests">): number
{
	return api.requests.filter((request) => request.path === "/get_tree_data/").length;
}

/** Make every `/get_tree_data/` read answer 500; returns the list each forbidden read is recorded in. */
export function forbidTreeData(api: FakeInternalApi): RecordedRequest[]
{
	const forbidden: RecordedRequest[] = [];
	api.respond("/get_tree_data/", (request) =>
	{
		forbidden.push(request);
		return new Response(
			"get_tree_data is forbidden in this test",
			{
				status: 500,
			},
		);
	});
	return forbidden;
}
