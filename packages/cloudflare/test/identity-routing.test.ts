import {afterAll, beforeAll, describe, expect, it} from "vite-plus/test";
import {createHttpApp} from "@outlinedb/web/server-app";
import {origin, signUp, startAuthHarness, turnstile} from "./auth-harness";
import {authDb, countStoreCalls, readJson, startHarness} from "./harness";
import type {Harness} from "./harness";
import {storeClient} from "../src/store-client";
import type {UserStore} from "../src/user-store";

describe("worker serves the migrated routes over RPC to the principal's Durable Object", () =>
{
	let h: Harness;

	beforeAll(async () =>
	{
		h = await startHarness("./probe-entry.ts", "ProbeStore");
	}, 120_000);

	afterAll(async () =>
	{
		await h.dispose();
	});

	it("reaches a migrated op over RPC under the dev identity, and the DO answers the op itself", async () =>
	{
		const viaWorker = await h.mf.dispatchFetch("http://localhost/api/v1/account", {});
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Miniflare types its namespace with undici classes
		const ns = (await h.mf.getDurableObjectNamespace("USER_STORE")) as unknown as DurableObjectNamespace<UserStore>;
		const viaRpc = await storeClient(ns.get(ns.idFromName("dev"))).call("account.get", {});

		const body: unknown = await viaWorker.json();
		expect(viaWorker.status).toBe(503);
		// The RPC result is built in another realm, so compare it as JSON.
		expect(JSON.stringify(viaRpc)).toBe(
			JSON.stringify(
				{
					ok: false,
					status: 503,
					body,
				},
			),
		);
		expect(JSON.stringify(body)).toContain("internal API is not configured");
	});

	it("serves the migrated routers from the Worker only: the Durable Object's own app answers 404", async () =>
	{
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Miniflare types its namespace with undici classes
		const ns = (await h.mf.getDurableObjectNamespace("USER_STORE")) as unknown as DurableObjectNamespace;
		const stub = ns.get(ns.idFromName("dev"));
		const paths = [
			"/api/v1/account",
			"/api/v1/features",
			"/api/v1/custom-tree",
			"/api/changes?since=1d",
			"/api/v1/tags/autocomplete",
			"/api/v1/tags",
			"/api/v1/stars",
			"/api/v1/preferences",
			"/api/v1/expansion",
			"/api/v1/files/11111111-2222-3333-4444-555555555555/original",
		];

		const viaDo = await Promise.all(
			paths.map(async (path) => (await stub.fetch(`http://localhost${path}`)).status),
		);
		const viaWorker = await Promise.all(
			paths.slice(1).map(async (path) =>
			{
				const response = await h.mf.dispatchFetch(`http://localhost${path}`, {});
				return {
					status: response.status,
					body: await response.json(),
				};
			}),
		);

		expect(viaDo).toStrictEqual([404, 404, 404, 404, 404, 404, 404, 404, 404, 404]);
		// The dev object is standalone but never provisioned, so it has no account row: tags, stars and preferences
		// answer 503 while expansion reads its local table. Files has the R2 blob store, so an attachment the object does
		// not have is a 404.
		expect(viaWorker.map(({status}) => status)).toStrictEqual([200, 200, 200, 200, 503, 503, 503, 200, 404]);
		// A fresh database with no workflowy.com account still answers the 20 Settings rows and the default flags.
		const features = viaWorker[0]?.body as
		{
			visible: unknown[];
			enabled: Record<string, true>;
			available: boolean;
		};
		expect(
			{
				...features,
				visible: features.visible.length,
			},
		).toStrictEqual(
			{
				visible: 20,
				enabled:
				{
					always_visible_controls: true,
					bdl: true,
					beta_redirect: true,
					calendar_node: true,
					dates: true,
					full_width_page: true,
					keep_keyboard_on_scroll: true,
					markdown_pasting: true,
					nested_search: true,
					numbered_list: true,
					open_links_in_desktop: true,
					present: true,
					rich_tags: true,
					side_pane: true,
					table: true,
					templates: true,
					update_notifications: true,
				},
				available: false,
			},
		);
		expect(viaWorker[1]?.body).toMatchObject(
			{
				rootId: null,
				rootChildren: [],
			},
		);
		expect(viaWorker[3]?.body).toStrictEqual(
			{
				tags: [],
			},
		);

		const ladderViaDo = await stub.fetch(
			"http://localhost/api/v1/ladder/move",
			{
				method: "POST",
				body: "{}",
			},
		);
		const ladderViaWorker = await h.mf.dispatchFetch(
			"http://localhost/api/v1/ladder/move",
			{
				method: "POST",
				headers:
				{
					"content-type": "application/json",
				},
				body: "{}",
			},
		);
		expect(ladderViaDo.status).toBe(404);
		expect(ladderViaWorker.status).toBe(400);
		await expect(ladderViaWorker.json()).resolves.toStrictEqual(
			{
				error: "root, node_id and to_tier are required strings, and before_id must be a string when given",
			},
		);

		const calendarViaDo = await stub.fetch("http://localhost/api/v1/calendar/dots?from=bad&to=bad");
		const calendarViaWorker = await h.mf.dispatchFetch("http://localhost/api/v1/calendar/dots?from=bad&to=bad", {});
		expect(calendarViaDo.status).toBe(404);
		expect(calendarViaWorker.status).toBe(400);
		await expect(calendarViaWorker.json()).resolves.toStrictEqual(
			{
				error: "from and to must be YYYYMMDD days at most 100 days apart, from first",
			},
		);

		const searchViaDo = await stub.fetch("http://localhost/api/search/helpers?rootId=");
		const searchViaWorker = await h.mf.dispatchFetch("http://localhost/api/search/helpers?rootId=", {});
		expect(searchViaDo.status).toBe(404);
		expect(searchViaWorker.status).toBe(200);
		await expect(searchViaWorker.json()).resolves.toStrictEqual(
			{
				hashTags: [],
				atTags: [],
			},
		);

		const relatedRequest =
		{
			method: "POST",
			headers:
			{
				"content-type": "application/json",
			},
			body: JSON.stringify(
				{
					type: "similar",
				},
			),
		};
		const relatedViaDo = await stub.fetch("http://localhost/api/related", relatedRequest);
		const relatedViaWorker = await h.mf.dispatchFetch(
			"http://localhost/api/related",
			{
				...relatedRequest,
				headers:
				{
					...relatedRequest.headers,
				},
			},
		);
		expect(relatedViaDo.status).toBe(404);
		expect(relatedViaWorker.status).toBe(400);
		await expect(relatedViaWorker.json()).resolves.toStrictEqual(
			{
				error: "nodeId is required",
			},
		);

		const nodesViaDo = await stub.fetch("http://localhost/api/v1/nodes");
		const nodesViaWorker = await h.mf.dispatchFetch("http://localhost/api/v1/nodes", {});
		expect(nodesViaDo.status).toBe(404);
		expect(nodesViaWorker.status).toBe(200);
		await expect(nodesViaWorker.json()).resolves.toStrictEqual(
			{
				nodes: [],
			},
		);
		const viewViaWorker = await h.mf.dispatchFetch(
			"http://localhost/api/v1/nodes/view",
			{
				method: "POST",
				headers:
				{
					"content-type": "application/json",
				},
				body: JSON.stringify(
					{
						rootId: null,
						limit: 10,
					},
				),
			},
		);
		expect(viewViaWorker.status).toBe(400);
		await expect(viewViaWorker.json()).resolves.toStrictEqual(
			{
				error: "body must be {rootId, limit, showCompleted}",
			},
		);

		const moveViaDo = await stub.fetch(
			"http://localhost/api/v1/nodes/abc/move",
			{
				method: "POST",
				body: "{}",
			},
		);
		expect(moveViaDo.status).toBe(404);
		const duplicateViaWorker = await h.mf.dispatchFetch(
			"http://localhost/api/v1/nodes/duplicate",
			{
				method: "POST",
				headers:
				{
					"content-type": "application/json",
				},
				body: "{}",
			},
		);
		expect(duplicateViaWorker.status).toBe(400);
		await expect(duplicateViaWorker.json()).resolves.toStrictEqual(
			{
				error: "Invalid request body",
			},
		);

		const swapViaDo = await stub.fetch(
			"http://localhost/api/v1/nodes/abc/swap-mirror-origin",
			{
				method: "POST",
			},
		);
		expect(swapViaDo.status).toBe(404);
		const mirrorViaWorker = await h.mf.dispatchFetch(
			"http://localhost/api/v1/nodes/mirror",
			{
				method: "POST",
				headers:
				{
					"content-type": "application/json",
				},
				body: "{}",
			},
		);
		expect(mirrorViaWorker.status).toBe(400);
		await expect(mirrorViaWorker.json()).resolves.toStrictEqual(
			{
				error: "Invalid request body",
			},
		);

		const completeViaDo = await stub.fetch(
			"http://localhost/api/v1/nodes/abc/complete",
			{
				method: "POST",
			},
		);
		expect(completeViaDo.status).toBe(404);
		const createViaWorker = await h.mf.dispatchFetch(
			"http://localhost/api/v1/nodes",
			{
				method: "POST",
				headers:
				{
					"content-type": "application/json",
				},
				body: JSON.stringify(
					{
						parent_id: null,
						name: "",
					},
				),
			},
		);
		// The dev object is standalone, so the create writes locally.
		expect(createViaWorker.status).toBe(201);
	});

	it("makes exactly one store call per HTTP request on every migrated route", async () =>
	{
		const json =
		{
			"content-type": "application/json",
		};
		const routes:
		{
			method: string;
			path: string;
			body?: string;
		}[] = [
			{
				method: "GET",
				path: "/api/v1/account",
			},
			{
				method: "GET",
				path: "/api/v1/features",
			},
			{
				method: "GET",
				path: "/api/v1/custom-tree",
			},
			{
				method: "GET",
				path: "/api/changes?since=1d",
			},
			{
				method: "GET",
				path: "/api/v1/tags",
			},
			{
				method: "GET",
				path: "/api/v1/stars",
			},
			{
				method: "GET",
				path: "/api/v1/preferences",
			},
			{
				method: "GET",
				path: "/api/v1/expansion",
			},
			{
				method: "GET",
				path: "/api/v1/nodes",
			},
			{
				method: "GET",
				path: "/api/search/helpers?rootId=",
			},
			{
				method: "POST",
				path: "/api/related",
				body: JSON.stringify(
					{
						type: "similar",
					},
				),
			},
			{
				method: "POST",
				path: "/api/v1/nodes",
				body: JSON.stringify(
					{
						parent_id: null,
						name: "",
					},
				),
			},
		];

		// Sequential: the counter is per Durable Object, so concurrent requests would share it.
		const counts: number[] = [];
		for (const {method, path, body} of routes)
		{
			counts.push(
				await countStoreCalls(h.mf, "dev", async () =>
					h.mf.dispatchFetch(
						`http://localhost${path}`,
						{
							method,
							body,
							headers:
							{
								...json,
							},
						},
					),
				),
			);
		}

		expect(counts).toStrictEqual(routes.map(() => 1));
	});
});

const secret = "test-secret-0123456789abcdef0123456789abcdef";

/** Only the session token pair of a Cookie header, so the session is read from D1 rather than the cookie cache. */
function tokenOnly(cookie: string): string
{
	return cookie
		.split("; ")
		.filter((pair) => pair.startsWith("better-auth.session_token="))
		.join("; ");
}

async function stubNamed(h: Harness, name: string): Promise<DurableObjectStub<UserStore>>
{
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Miniflare types its namespace with undici classes
	const ns = (await h.mf.getDurableObjectNamespace("USER_STORE")) as unknown as DurableObjectNamespace<UserStore>;
	return ns.get(ns.idFromName(name));
}

async function nodeNames(
	h: Harness,
	headers: Record<string, string>,
): Promise<
{
	status: number;
	body: unknown;
}>
{
	const response = await h.mf.dispatchFetch(
		`${origin}/api/v1/nodes`,
		{
			headers,
		},
	);
	const body = await readJson(response);
	const nodes = (
		body as
		{
			nodes?:
			{
				name: string;
			}[];
		}
	).nodes;
	return {
		status: response.status,
		body: nodes ? nodes.map(({name}) => name) : body,
	};
}

describe("worker resolves a principal from a Better Auth session", () =>
{
	let h: Harness;

	beforeAll(async () =>
	{
		h = await startAuthHarness(
			{
				BETTER_AUTH_SECRET: secret,
				SIGNUP_MODE: "invite",
				SIGNUP_INVITES:
					"alice@example.com, carol@example.com, dave@example.com, erin@example.com, gina@example.com",
				TURNSTILE_SECRET_KEY: turnstile.passSecret,
				TURNSTILE_SITE_KEY: turnstile.siteKey,
			},
			{
				className: "ProbeStore",
			},
		);
	}, 120_000);

	afterAll(async () =>
	{
		await h.dispose();
	});

	it("routes a verified session user to the Durable Object named by its user id, keeps two users apart, and serves a standalone store's account state locally", async () =>
	{
		const carol = await signUp(h, "carol@example.com");
		const dave = await signUp(h, "dave@example.com");
		const carolStore = await stubNamed(h, carol.userId);
		await carolStore.fetch("http://localhost/__seed?name=Carol%27s%20node");

		// Each standalone signup starts with the provisioned Inbox and welcome; only Carol's store holds her node.
		await expect(
			nodeNames(
				h,
				{
					cookie: carol.cookie,
				},
			),
		).resolves.toStrictEqual(
			{
				status: 200,
				body: ["Inbox", "Welcome to OutlineDB", "Carol's node"],
			},
		);
		await expect(
			nodeNames(
				h,
				{
					cookie: dave.cookie,
				},
			),
		).resolves.toStrictEqual(
			{
				status: 200,
				body: ["Inbox", "Welcome to OutlineDB"],
			},
		);
		const status = await carolStore.adminStatus();
		expect(status.storeName).toBe(carol.userId);

		// Dave's object is standalone, as every account starts: account state lives in its local tables, and the account
		// answers the row provisioning wrote.
		const call = async (method: string, path: string, body?: unknown) =>
		{
			const response = await h.mf.dispatchFetch(
				`${origin}${path}`,
				{
					method,
					headers:
					{
						cookie: dave.cookie,
						"content-type": "application/json",
					},
					...(body === undefined
						? {}
						:
							{
								body: JSON.stringify(body),
							}),
				},
			);
			const text = await response.text();
			return {
				status: response.status,
				body: text === "" ? null : (JSON.parse(text) as unknown),
			};
		};

		const account = await call("GET", "/api/v1/account");
		const tag = await call(
			"PUT",
			"/api/v1/tags/%23home",
			{
				color: "red",
			},
		);
		const tags = await call("GET", "/api/v1/tags");
		const order = await call(
			"PUT",
			"/api/v1/stars/order",
			{
				keys: [],
			},
		);
		const stars = await call("GET", "/api/v1/stars");
		const preferences = await call(
			"PATCH",
			"/api/v1/preferences",
			{
				dateFormat: "MM/DD/YYYY",
			},
		);
		const expansion = await call(
			"PATCH",
			"/api/v1/expansion/left-bar",
			{
				changes:
				{
					leftbar__starred__abc: true,
				},
			},
		);
		const leftBar = await call("GET", "/api/v1/expansion/left-bar");

		const joinedAt = (
			account.body as
			{
				joinedAt?: unknown;
			}
		).joinedAt;
		expect(typeof joinedAt === "string" && !Number.isNaN(Date.parse(joinedAt))).toBe(true);
		expect(
			{
				account:
				{
					...account,
					body:
					{
						...(account.body as object),
						joinedAt: "<joinedAt>",
					},
				},
				tag,
				tags,
				order,
				stars,
				preferences:
				{
					status: preferences.status,
					dateFormat: (
						preferences.body as
						{
							dateFormat?: unknown;
						}
					).dateFormat,
				},
				expansion,
				leftBar,
			},
		).toStrictEqual(
			{
				account:
				{
					status: 200,
					body:
					{
						userId: dave.userId,
						joinedAt: "<joinedAt>",
						fullName: null,
						email: "dave@example.com",
					},
				},
				tag:
				{
					status: 200,
					body:
					{
						name: "#home",
						color: "red",
					},
				},
				tags:
				{
					status: 200,
					body:
					{
						colors:
						{
							"#home": "red",
						},
					},
				},
				order:
				{
					status: 204,
					body: null,
				},
				stars:
				{
					status: 200,
					body:
					{
						stars: [],
						nodes: [],
					},
				},
				preferences:
				{
					status: 200,
					dateFormat: "MM/DD/YYYY",
				},
				expansion:
				{
					status: 204,
					body: null,
				},
				leftBar:
				{
					status: 200,
					body:
					{
						keys: ["leftbar__starred__abc"],
					},
				},
			},
		);
	});

	it("answers 404 to a session for the removed admin routes", async () =>
	{
		const gina = await signUp(h, "gina@example.com");
		const statuses = await Promise.all(
			["/api/admin/status", "/api/admin/sync", "/api/admin/account-state"].map(async (path) =>
			{
				const response = await h.mf.dispatchFetch(
					`${origin}${path}`,
					{
						headers:
						{
							cookie: gina.cookie,
						},
					},
				);
				await response.arrayBuffer();
				return response.status;
			}),
		);
		expect(statuses).toStrictEqual([404, 404, 404]);
	});

	it("refuses a session whose email is unverified with 403 email-unverified", async () =>
	{
		const erin = await signUp(h, "erin@example.com");
		const db = await authDb(h.mf);
		await db.prepare("UPDATE user SET emailVerified = 0 WHERE id = ?").bind(erin.userId).run();

		await expect(
			nodeNames(
				h,
				{
					cookie: tokenOnly(erin.cookie),
				},
			),
		).resolves.toStrictEqual(
			{
				status: 403,
				body:
				{
					error: "email-unverified",
				},
			},
		);
	});

	it("answers 401 JSON unauthenticated with no credentials or an unknown session token", async () =>
	{
		await expect(
			Promise.all([
				nodeNames(h, {}),
				nodeNames(
					h,
					{
						cookie: "better-auth.session_token=forged.token",
					},
				),
			]),
		).resolves.toStrictEqual([
			{
				status: 401,
				body:
				{
					error: "unauthenticated",
				},
			},
			{
				status: 401,
				body:
				{
					error: "unauthenticated",
				},
			},
		]);
	});

	it("answers 401 on every registered /api/v1/* route without credentials", async () =>
	{
		const routes = createHttpApp(
			{
				resolveStore: () =>
				{
					throw new Error("unreachable");
				},
			},
		)
			.routes.filter(({method, path}) => method !== "ALL" && path.startsWith("/api/v1/"))
			.map(({method, path}) => (
			{
				method,
				path: path.replaceAll(/:\w+(\{[^}]*\})?/gu, "x"),
			}));
		const sockets = ["/api/v1/ladder/events", "/api/v1/nodes/events"].map((path) => (
		{
			method: "GET",
			path,
		}));
		const all = [...routes, ...sockets];
		expect(all.length).toBeGreaterThan(40);

		const statuses = await Promise.all(
			all.map(async ({method, path}) =>
			{
				const response = await h.mf.dispatchFetch(
					`${origin}${path}`,
					{
						method,
					},
				);
				return `${method} ${path} ${response.status}`;
			}),
		);
		expect(statuses).toStrictEqual(all.map(({method, path}) => `${method} ${path} 401`));
	});
});

describe("worker uses DEV_IDENTITY only when no session cookie is present", () =>
{
	let h: Harness;

	beforeAll(async () =>
	{
		h = await startAuthHarness(
			{
				DEV_IDENTITY: "dev",
				BETTER_AUTH_SECRET: secret,
				SIGNUP_MODE: "invite",
				SIGNUP_INVITES: "frank@example.com",
				TURNSTILE_SECRET_KEY: turnstile.passSecret,
				TURNSTILE_SITE_KEY: turnstile.siteKey,
			},
			{
				className: "ProbeStore",
			},
		);
	}, 120_000);

	afterAll(async () =>
	{
		await h.dispose();
	});

	it("routes a session to its user's Durable Object and a cookieless request to dev", async () =>
	{
		const frank = await signUp(h, "frank@example.com");
		await (await stubNamed(h, "dev")).fetch("http://localhost/__seed?name=dev%20node");

		await expect(
			Promise.all([
				nodeNames(
					h,
					{
						cookie: frank.cookie,
					},
				),
				nodeNames(h, {}),
			]),
		).resolves.toStrictEqual([
			{
				status: 200,
				body: ["Inbox", "Welcome to OutlineDB"],
			},
			{
				status: 200,
				body: ["dev node"],
			},
		]);
	});
});
