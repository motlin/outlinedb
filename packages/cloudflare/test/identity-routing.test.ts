import {afterAll, beforeAll, describe, expect, it} from "vite-plus/test";
import {SignJWT, exportJWK, generateKeyPair} from "jose";
import {createHttpApp} from "@outlinedb/web/server-app";
import {origin, signUp, startAuthHarness, turnstile} from "./auth-harness";
import {applyD1Migrations, authDb, countStoreCalls, readJson, startHarness} from "./harness";
import type {Harness} from "./harness";
import {storeClient} from "../src/store-client";
import type {UserStore} from "../src/user-store";

const teamDomain = "team.example.com";
const audience = "aud-routing";
const url = "http://localhost/api/admin/account-state";

const TABLES = [
	"account",
	"rootPreferences",
	"accountSettings",
	"tagColors",
	"stars",
	"starOrder",
	"locationRenames",
	"enabledFeatures",
	"visibleFeatures",
	"changelogReads",
	"surveys",
	"savedViews",
	"aiAssistants",
	"aiPromptButtons",
];

/** An account state holding only `tagColors`. */
function stateWith(tagColors: unknown[]) {
	return {rows: {...Object.fromEntries(TABLES.map((name) => [name, []])), tagColors}, expandedKeys: null};
}

describe("worker routes each Access email to its own Durable Object", () => {
	let h: Harness;
	let privateKey: CryptoKey;

	beforeAll(async () => {
		const pair = await generateKeyPair("RS256");
		privateKey = pair.privateKey;
		const jwks = JSON.stringify({keys: [{...(await exportJWK(pair.publicKey)), alg: "RS256", use: "sig"}]});
		h = await startHarness(
			"./probe-entry.ts",
			"ProbeStore",
			undefined,
			{
				ACCESS_TEAM_DOMAIN: teamDomain,
				ACCESS_AUD: audience,
				ALLOWED_EMAILS: "Alice@example.com, bob@example.com",
			},
			{
				outboundService: (request: Request): Response =>
					new URL(request.url).pathname === "/cdn-cgi/access/certs"
						? new Response(jwks, {headers: {"content-type": "application/json"}})
						: new Response("unexpected", {status: 500}),
			},
		);
		await applyD1Migrations(h.mf);
	}, 120_000);

	afterAll(async () => {
		await h.dispose();
	});

	async function as(email: string, init: {method?: string; body?: string} = {}): Promise<unknown> {
		const jwt = await new SignJWT({email})
			.setProtectedHeader({alg: "RS256"})
			.setAudience(audience)
			.setIssuer(`https://${teamDomain}`)
			.setIssuedAt()
			.setExpirationTime("1h")
			.sign(privateKey);
		const response = await h.mf.dispatchFetch(url, {
			...init,
			headers: {"Cf-Access-Jwt-Assertion": jwt, "content-type": "application/json"},
		});
		return response.json();
	}

	async function named(name: string): Promise<unknown> {
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Miniflare types its namespace with undici classes
		const ns = (await h.mf.getDurableObjectNamespace("USER_STORE")) as unknown as DurableObjectNamespace<UserStore>;
		return ns.get(ns.idFromName(name)).getAccountState();
	}

	it("stores a valid token's writes in the DO named by the lowercased email, not dev, and keeps emails separate", async () => {
		const alice = stateWith([{tag: "#a", colorIndex: 1}]);
		await as("ALICE@example.com", {method: "PUT", body: JSON.stringify(alice)});

		// The RPC result is built in another realm, so compare it as JSON.
		await expect(named("alice@example.com").then((state) => JSON.stringify(state))).resolves.toBe(
			JSON.stringify(alice),
		);
		await expect(named("dev").then((state) => JSON.stringify(state))).resolves.toBe(JSON.stringify(stateWith([])));
		await expect(as("bob@example.com")).resolves.toStrictEqual(stateWith([]));
		await expect(as("alice@example.com")).resolves.toStrictEqual(alice);
	});

	it("reaches a migrated op over RPC under the Access identity, and the DO answers the op itself", async () => {
		const jwt = await new SignJWT({email: "alice@example.com"})
			.setProtectedHeader({alg: "RS256"})
			.setAudience(audience)
			.setIssuer(`https://${teamDomain}`)
			.setIssuedAt()
			.setExpirationTime("1h")
			.sign(privateKey);
		const viaWorker = await h.mf.dispatchFetch("http://localhost/api/v1/account", {
			headers: {"Cf-Access-Jwt-Assertion": jwt},
		});
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Miniflare types its namespace with undici classes
		const ns = (await h.mf.getDurableObjectNamespace("USER_STORE")) as unknown as DurableObjectNamespace<UserStore>;
		const viaRpc = await storeClient(ns.get(ns.idFromName("alice@example.com"))).call("account.get", {});

		const body: unknown = await viaWorker.json();
		expect(viaWorker.status).toBe(503);
		// The RPC result is built in another realm, so compare it as JSON.
		expect(JSON.stringify(viaRpc)).toBe(JSON.stringify({ok: false, status: 503, body}));
		expect(JSON.stringify(body)).toContain("internal API is not configured");
	});

	it("serves the admin routes from the Worker only: the Durable Object's own fetch answers 404", async () => {
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Miniflare types its namespace with undici classes
		const ns = (await h.mf.getDurableObjectNamespace("USER_STORE")) as unknown as DurableObjectNamespace;
		const stub = ns.get(ns.idFromName("alice@example.com"));
		const viaDo = await Promise.all(
			["status", "sync", "account-state"].map(
				async (name) => (await stub.fetch(`http://localhost/api/admin/${name}`)).status,
			),
		);
		expect(viaDo).toStrictEqual([404, 404, 404]);
	});

	it("serves the migrated routers from the Worker only: the Durable Object's own app answers 404", async () => {
		const jwt = await new SignJWT({email: "alice@example.com"})
			.setProtectedHeader({alg: "RS256"})
			.setAudience(audience)
			.setIssuer(`https://${teamDomain}`)
			.setIssuedAt()
			.setExpirationTime("1h")
			.sign(privateKey);
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Miniflare types its namespace with undici classes
		const ns = (await h.mf.getDurableObjectNamespace("USER_STORE")) as unknown as DurableObjectNamespace;
		const stub = ns.get(ns.idFromName("alice@example.com"));
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
			paths.slice(1).map(async (path) => {
				const response = await h.mf.dispatchFetch(`http://localhost${path}`, {
					headers: {"Cf-Access-Jwt-Assertion": jwt},
				});
				return {status: response.status, body: await response.json()};
			}),
		);

		expect(viaDo).toStrictEqual([404, 404, 404, 404, 404, 404, 404, 404, 404, 404]);
		expect(viaWorker.map(({status}) => status)).toStrictEqual([200, 200, 200, 200, 503, 503, 503, 503, 503]);
		// A fresh database with no workflowy.com account still answers the 20 Settings rows and the default flags.
		const features = viaWorker[0]?.body as {visible: unknown[]; enabled: Record<string, true>; available: boolean};
		expect({...features, visible: features.visible.length}).toStrictEqual({
			visible: 20,
			enabled: {
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
		});
		expect(viaWorker[1]?.body).toMatchObject({rootId: null, rootChildren: []});
		expect(viaWorker[3]?.body).toStrictEqual({tags: []});

		const ladderViaDo = await stub.fetch("http://localhost/api/v1/ladder/move", {method: "POST", body: "{}"});
		const ladderViaWorker = await h.mf.dispatchFetch("http://localhost/api/v1/ladder/move", {
			method: "POST",
			headers: {"Cf-Access-Jwt-Assertion": jwt, "content-type": "application/json"},
			body: "{}",
		});
		expect(ladderViaDo.status).toBe(404);
		expect(ladderViaWorker.status).toBe(400);
		await expect(ladderViaWorker.json()).resolves.toStrictEqual({
			error: "root, node_id and to_tier are required strings, and before_id must be a string when given",
		});

		const calendarViaDo = await stub.fetch("http://localhost/api/v1/calendar/dots?from=bad&to=bad");
		const calendarViaWorker = await h.mf.dispatchFetch("http://localhost/api/v1/calendar/dots?from=bad&to=bad", {
			headers: {"Cf-Access-Jwt-Assertion": jwt},
		});
		expect(calendarViaDo.status).toBe(404);
		expect(calendarViaWorker.status).toBe(400);
		await expect(calendarViaWorker.json()).resolves.toStrictEqual({
			error: "from and to must be YYYYMMDD days at most 100 days apart, from first",
		});

		const searchViaDo = await stub.fetch("http://localhost/api/search/helpers?rootId=");
		const searchViaWorker = await h.mf.dispatchFetch("http://localhost/api/search/helpers?rootId=", {
			headers: {"Cf-Access-Jwt-Assertion": jwt},
		});
		expect(searchViaDo.status).toBe(404);
		expect(searchViaWorker.status).toBe(200);
		await expect(searchViaWorker.json()).resolves.toStrictEqual({hashTags: [], atTags: []});

		const relatedRequest = {
			method: "POST",
			headers: {"content-type": "application/json"},
			body: JSON.stringify({type: "similar"}),
		};
		const relatedViaDo = await stub.fetch("http://localhost/api/related", relatedRequest);
		const relatedViaWorker = await h.mf.dispatchFetch("http://localhost/api/related", {
			...relatedRequest,
			headers: {...relatedRequest.headers, "Cf-Access-Jwt-Assertion": jwt},
		});
		expect(relatedViaDo.status).toBe(404);
		expect(relatedViaWorker.status).toBe(400);
		await expect(relatedViaWorker.json()).resolves.toStrictEqual({error: "nodeId is required"});

		const nodesViaDo = await stub.fetch("http://localhost/api/v1/nodes");
		const nodesViaWorker = await h.mf.dispatchFetch("http://localhost/api/v1/nodes", {
			headers: {"Cf-Access-Jwt-Assertion": jwt},
		});
		expect(nodesViaDo.status).toBe(404);
		expect(nodesViaWorker.status).toBe(200);
		await expect(nodesViaWorker.json()).resolves.toStrictEqual({nodes: []});
		const viewViaWorker = await h.mf.dispatchFetch("http://localhost/api/v1/nodes/view", {
			method: "POST",
			headers: {"content-type": "application/json", "Cf-Access-Jwt-Assertion": jwt},
			body: JSON.stringify({rootId: null, expandedIds: null, limit: 10}),
		});
		expect(viewViaWorker.status).toBe(400);
		await expect(viewViaWorker.json()).resolves.toStrictEqual({
			error: "body must be {rootId, expandedIds, limit, showCompleted}",
		});

		const moveViaDo = await stub.fetch("http://localhost/api/v1/nodes/abc/move", {method: "POST", body: "{}"});
		expect(moveViaDo.status).toBe(404);
		const duplicateViaWorker = await h.mf.dispatchFetch("http://localhost/api/v1/nodes/duplicate", {
			method: "POST",
			headers: {"content-type": "application/json", "Cf-Access-Jwt-Assertion": jwt},
			body: "{}",
		});
		expect(duplicateViaWorker.status).toBe(400);
		await expect(duplicateViaWorker.json()).resolves.toStrictEqual({error: "Invalid request body"});

		const swapViaDo = await stub.fetch("http://localhost/api/v1/nodes/abc/swap-mirror-origin", {method: "POST"});
		expect(swapViaDo.status).toBe(404);
		const mirrorViaWorker = await h.mf.dispatchFetch("http://localhost/api/v1/nodes/mirror", {
			method: "POST",
			headers: {"content-type": "application/json", "Cf-Access-Jwt-Assertion": jwt},
			body: "{}",
		});
		expect(mirrorViaWorker.status).toBe(400);
		await expect(mirrorViaWorker.json()).resolves.toStrictEqual({error: "Invalid request body"});

		const completeViaDo = await stub.fetch("http://localhost/api/v1/nodes/abc/complete", {method: "POST"});
		expect(completeViaDo.status).toBe(404);
		const createViaWorker = await h.mf.dispatchFetch("http://localhost/api/v1/nodes", {
			method: "POST",
			headers: {"content-type": "application/json", "Cf-Access-Jwt-Assertion": jwt},
			body: JSON.stringify({parent_id: null, name: ""}),
		});
		expect(createViaWorker.status).toBe(500);
		await expect(createViaWorker.json()).resolves.toStrictEqual({
			error: "WORKFLOWY_API_KEY environment variable is required",
		});
	});

	it("makes exactly one store call per HTTP request on every migrated route", async () => {
		const jwt = await new SignJWT({email: "alice@example.com"})
			.setProtectedHeader({alg: "RS256"})
			.setAudience(audience)
			.setIssuer(`https://${teamDomain}`)
			.setIssuedAt()
			.setExpirationTime("1h")
			.sign(privateKey);
		const json = {"content-type": "application/json"};
		const routes: {method: string; path: string; body?: string}[] = [
			{method: "GET", path: "/api/v1/account"},
			{method: "GET", path: "/api/v1/features"},
			{method: "GET", path: "/api/v1/custom-tree"},
			{method: "GET", path: "/api/changes?since=1d"},
			{method: "GET", path: "/api/v1/tags"},
			{method: "GET", path: "/api/v1/stars"},
			{method: "GET", path: "/api/v1/preferences"},
			{method: "GET", path: "/api/v1/expansion"},
			{method: "GET", path: "/api/v1/nodes"},
			{method: "GET", path: "/api/search/helpers?rootId="},
			{method: "POST", path: "/api/related", body: JSON.stringify({type: "similar"})},
			{method: "POST", path: "/api/v1/nodes", body: JSON.stringify({parent_id: null, name: ""})},
		];

		// Sequential: the counter is per Durable Object, so concurrent requests would share it.
		const counts: number[] = [];
		for (const {method, path, body} of routes) {
			counts.push(
				await countStoreCalls(h.mf, "alice@example.com", async () =>
					h.mf.dispatchFetch(`http://localhost${path}`, {
						method,
						body,
						headers: {...json, "Cf-Access-Jwt-Assertion": jwt},
					}),
				),
			);
		}

		expect(counts).toStrictEqual(routes.map(() => 1));
	});
});

const secret = "test-secret-0123456789abcdef0123456789abcdef";

/** Only the session token pair of a Cookie header, so the session is read from D1 rather than the cookie cache. */
function tokenOnly(cookie: string): string {
	return cookie
		.split("; ")
		.filter((pair) => pair.startsWith("better-auth.session_token="))
		.join("; ");
}

async function stubNamed(h: Harness, name: string): Promise<DurableObjectStub<UserStore>> {
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Miniflare types its namespace with undici classes
	const ns = (await h.mf.getDurableObjectNamespace("USER_STORE")) as unknown as DurableObjectNamespace<UserStore>;
	return ns.get(ns.idFromName(name));
}

async function nodeNames(h: Harness, headers: Record<string, string>): Promise<{status: number; body: unknown}> {
	const response = await h.mf.dispatchFetch(`${origin}/api/v1/nodes`, {headers});
	const body = await readJson(response);
	const nodes = (body as {nodes?: {name: string}[]}).nodes;
	return {status: response.status, body: nodes ? nodes.map(({name}) => name) : body};
}

describe("worker resolves a principal from Access or a Better Auth session", () => {
	let h: Harness;
	let privateKey: CryptoKey;

	beforeAll(async () => {
		const pair = await generateKeyPair("RS256");
		privateKey = pair.privateKey;
		const jwks = JSON.stringify({keys: [{...(await exportJWK(pair.publicKey)), alg: "RS256", use: "sig"}]});
		h = await startAuthHarness(
			{
				ACCESS_TEAM_DOMAIN: teamDomain,
				ACCESS_AUD: audience,
				ALLOWED_EMAILS: "alice@example.com, bob@example.com",
				BETTER_AUTH_SECRET: secret,
				SIGNUP_MODE: "invite",
				SIGNUP_INVITES:
					"alice@example.com, carol@example.com, dave@example.com, erin@example.com, gina@example.com",
				TURNSTILE_SECRET_KEY: turnstile.passSecret,
				TURNSTILE_SITE_KEY: turnstile.siteKey,
			},
			{
				className: "ProbeStore",
				otherwise: (request) =>
					new URL(request.url).pathname === "/cdn-cgi/access/certs"
						? new Response(jwks, {headers: {"content-type": "application/json"}})
						: new Response("unexpected", {status: 500}),
			},
		);
	}, 120_000);

	afterAll(async () => {
		await h.dispose();
	});

	async function accessJwt(email: string): Promise<string> {
		return new SignJWT({email})
			.setProtectedHeader({alg: "RS256"})
			.setAudience(audience)
			.setIssuer(`https://${teamDomain}`)
			.setIssuedAt()
			.setExpirationTime("1h")
			.sign(privateKey);
	}

	it("routes a verified session user to the Durable Object named by its user id, and keeps two users apart", async () => {
		const carol = await signUp(h, "carol@example.com");
		const dave = await signUp(h, "dave@example.com");
		const carolStore = await stubNamed(h, carol.userId);
		await carolStore.fetch("http://localhost/__seed?name=Carol%27s%20node");

		// Each standalone signup starts with the provisioned Inbox and welcome; only Carol's store holds her node.
		await expect(nodeNames(h, {cookie: carol.cookie})).resolves.toStrictEqual({
			status: 200,
			body: ["Inbox", "Welcome to OutlineDB", "Carol's node"],
		});
		await expect(nodeNames(h, {cookie: dave.cookie})).resolves.toStrictEqual({
			status: 200,
			body: ["Inbox", "Welcome to OutlineDB"],
		});
		const status = await carolStore.adminStatus();
		expect(status.storeName).toBe(carol.userId);
	});

	it("routes an Access email to its email-named Durable Object, or to its user's once it has a verified D1 user", async () => {
		const tags = [{tag: "#b", colorIndex: 2}];
		const put = async (email: string, tagColors: unknown[]) =>
			h.mf.dispatchFetch(`${origin}/api/admin/account-state`, {
				method: "PUT",
				headers: {"Cf-Access-Jwt-Assertion": await accessJwt(email), "content-type": "application/json"},
				body: JSON.stringify(stateWith(tagColors)),
			});

		expect((await put("bob@example.com", tags)).status).toBe(200);
		const alice = await signUp(h, "alice@example.com");
		expect((await put("alice@example.com", [{tag: "#a", colorIndex: 1}])).status).toBe(200);

		const states = await Promise.all(
			["bob@example.com", alice.userId, "alice@example.com"].map(async (name) =>
				JSON.stringify(await (await stubNamed(h, name)).getAccountState()),
			),
		);
		expect(states).toStrictEqual([
			JSON.stringify(stateWith(tags)),
			JSON.stringify(stateWith([{tag: "#a", colorIndex: 1}])),
			JSON.stringify(stateWith([])),
		]);
	});

	it("refuses a session on /api/admin/* with 403, so only Access reaches the admin routes", async () => {
		const {cookie} = await signUp(h, "gina@example.com");
		const responses = await Promise.all(
			["/api/admin/status", "/api/admin/account-state"].map(async (path) => {
				const response = await h.mf.dispatchFetch(`${origin}${path}`, {headers: {cookie}});
				return {status: response.status, body: await response.json()};
			}),
		);
		expect(responses).toStrictEqual([
			{status: 403, body: {error: "access-required"}},
			{status: 403, body: {error: "access-required"}},
		]);
	});

	it("refuses a session whose email is unverified with 403 email-unverified", async () => {
		const erin = await signUp(h, "erin@example.com");
		const db = await authDb(h.mf);
		await db.prepare("UPDATE user SET emailVerified = 0 WHERE id = ?").bind(erin.userId).run();

		await expect(nodeNames(h, {cookie: tokenOnly(erin.cookie)})).resolves.toStrictEqual({
			status: 403,
			body: {error: "email-unverified"},
		});
	});

	it("answers 401 JSON unauthenticated with no credentials or an unknown session token", async () => {
		await expect(
			Promise.all([nodeNames(h, {}), nodeNames(h, {cookie: "better-auth.session_token=forged.token"})]),
		).resolves.toStrictEqual([
			{status: 401, body: {error: "unauthenticated"}},
			{status: 401, body: {error: "unauthenticated"}},
		]);
	});

	it("answers 401 on every registered /api/v1/* route without credentials", async () => {
		const routes = createHttpApp({
			resolveStore: () => {
				throw new Error("unreachable");
			},
		})
			.routes.filter(({method, path}) => method !== "ALL" && path.startsWith("/api/v1/"))
			.map(({method, path}) => ({method, path: path.replaceAll(/:\w+(\{[^}]*\})?/gu, "x")}));
		const sockets = ["/api/v1/ladder/events", "/api/v1/nodes/events"].map((path) => ({method: "GET", path}));
		const all = [...routes, ...sockets];
		expect(all.length).toBeGreaterThan(40);

		const statuses = await Promise.all(
			all.map(async ({method, path}) => {
				const response = await h.mf.dispatchFetch(`${origin}${path}`, {method});
				return `${method} ${path} ${response.status}`;
			}),
		);
		expect(statuses).toStrictEqual(all.map(({method, path}) => `${method} ${path} 401`));
	});
});

describe("worker uses ACCESS_DEV_IDENTITY only when no session cookie is present", () => {
	let h: Harness;

	beforeAll(async () => {
		h = await startAuthHarness(
			{
				ACCESS_DEV_IDENTITY: "dev",
				BETTER_AUTH_SECRET: secret,
				SIGNUP_MODE: "invite",
				SIGNUP_INVITES: "frank@example.com",
				TURNSTILE_SECRET_KEY: turnstile.passSecret,
				TURNSTILE_SITE_KEY: turnstile.siteKey,
			},
			{className: "ProbeStore"},
		);
	}, 120_000);

	afterAll(async () => {
		await h.dispose();
	});

	it("routes a session to its user's Durable Object and a cookieless request to dev", async () => {
		const frank = await signUp(h, "frank@example.com");
		await (await stubNamed(h, "dev")).fetch("http://localhost/__seed?name=dev%20node");

		await expect(Promise.all([nodeNames(h, {cookie: frank.cookie}), nodeNames(h, {})])).resolves.toStrictEqual([
			{status: 200, body: ["Inbox", "Welcome to OutlineDB"]},
			{status: 200, body: ["dev node"]},
		]);
	});
});
