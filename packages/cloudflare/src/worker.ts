import type {OAuthHelpers} from "@cloudflare/workers-oauth-provider";
import {parseAccountState} from "@workflowy/shared/cache";
import {createHttpApp} from "@workflowy/web/server-app";
import type {StoreClient} from "@workflowy/web/server-app";
import {Hono} from "hono";
import {createMiddleware} from "hono/factory";
import type {AccessEnv} from "./access";
import {authConfig, captchaMissing, createAuth} from "./auth/auth";
import type {AuthEnv} from "./auth/auth";
import {authorize, oauthProviderFor} from "./oauth";
import {resolvePrincipal} from "./principal";
import type {Principal} from "./principal";
import {storeClient} from "./store-client";
import type {UserStore} from "./user-store";

export {UserStore} from "./user-store";

/**
 * `createHttpApp` compresses API responses in this Worker. Without `encodeBody: "manual"` the runtime assumes a response's body is plain and
 * encodes it again to match `Content-Encoding`, so browsers decode one layer and read gzip bytes as JSON.
 */
function passEncodedBody(response: Response): Response {
	if (!response.headers.has("content-encoding") || response.webSocket) {
		return response;
	}
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers: response.headers,
		encodeBody: "manual",
	});
}

type WorkerEnv = Env & AccessEnv & AuthEnv & {OAUTH_PROVIDER: OAuthHelpers};
interface WorkerApp {
	Bindings: WorkerEnv;
	Variables: {principal: Principal; stub: DurableObjectStub<UserStore>};
}

const app = new Hono<WorkerApp>();
/** The store for the request being served; `createHttpApp` asks for it by the raw request. */
const stores = new WeakMap<Request, StoreClient>();

app.use("*", async (c, next) => {
	await next();
	c.res = passEncodedBody(c.res);
});

/**
 * One Better Auth per isolate (bindings, vars and secrets are fixed for its life), so its one-time schema check and
 * setup are not repeated on every request.
 */
const auths = new WeakMap<D1Database, ReturnType<typeof createAuth>>();

/**
 * This isolate's Better Auth, or undefined while `BETTER_AUTH_SECRET` is unset. Build it only in a request that goes on
 * to use it: its setup does D1 I/O that a later request cannot finish once the request that started it has ended.
 */
function authFor(env: WorkerEnv): ReturnType<typeof createAuth> | undefined {
	const secret = env.BETTER_AUTH_SECRET;
	if (!secret) {
		return undefined;
	}
	let auth = auths.get(env.AUTH_DB);
	if (!auth) {
		auth = createAuth({...env, BETTER_AUTH_SECRET: secret});
		auths.set(env.AUTH_DB, auth);
	}
	return auth;
}

// Better Auth answers its own routes ahead of the Access identity, and stays off (503) until its secret is set,
// so the Access path never depends on it.
app.on(["GET", "POST"], "/api/auth/*", async (c) => {
	if (!c.env.BETTER_AUTH_SECRET) {
		return c.json({error: "auth-not-configured"}, 503);
	}
	if (captchaMissing(c.env, c.req.path)) {
		return c.json({error: "captcha-not-configured"}, 503);
	}
	return authFor(c.env)?.handler(c.req.raw);
});

// Public: the sign-in page reads it before anyone is signed in. Shadows the Node host's `{hosted: false}`.
app.get("/api/auth-config", (c) => c.json(authConfig(c.env)));

// Access or a verified Better Auth session gates everything dynamic; the principal names the user's Durable Object.
const principal = createMiddleware<WorkerApp>(async (c, next) => {
	const result = await resolvePrincipal(c.req.raw, c.env, () => authFor(c.env));
	if ("status" in result) {
		return c.json({error: result.error}, result.status);
	}
	c.set("principal", result);
	const stub = c.env.USER_STORE.getByName(result.storeName);
	c.set("stub", stub);
	stores.set(c.req.raw, storeClient(stub));
	return next();
});

app.use("/health", principal);
app.use("/api/*", principal);

// The admin routes act on a whole store (seed, sync, account state), so only Access identities reach them.
app.use("/api/admin/*", async (c, next) =>
	c.var.principal.kind === "access" ? next() : c.json({error: "access-required"}, 403),
);

// The OAuth consent page; it runs its own Access check, since the grant it issues acts as that email.
app.on(["GET", "POST"], "/authorize", async (c) => authorize(c.req.raw, c.env));

// The DO's only HTTP surfaces: a WebSocket cannot cross RPC, and hibernation needs the DO to accept it.
// Registered before the HTTP app, so `/api/v1/nodes/events` is not taken by its `GET /api/v1/nodes/:id`.
for (const path of ["/api/v1/ladder/events", "/api/v1/nodes/events"]) {
	app.get(path, async (c) => {
		if (c.req.header("Upgrade")?.toLowerCase() !== "websocket") {
			return new Response("Expected a WebSocket upgrade", {status: 426});
		}
		return c.var.stub.fetch(c.req.raw);
	});
}

// Migrated routes are answered here over RPC.
app.route(
	"/",
	createHttpApp({
		resolveStore: (request) => {
			const store = stores.get(request);
			if (!store) {
				throw new Error("No store resolved for this request");
			}
			return store;
		},
	}),
);

const methodNotAllowed = () => new Response("Method not allowed", {status: 405});

app.get("/api/admin/status", async (c) => c.json(await c.var.stub.adminStatus()));
app.all("/api/admin/status", methodNotAllowed);

app.post("/api/admin/sync", async (c) => c.json(await c.var.stub.syncNow(), 202));
app.get("/api/admin/sync", async (c) => c.json(await c.var.stub.syncStatus()));
app.all("/api/admin/sync", methodNotAllowed);

// The one way to read the whole tree (about 54 MB): an explicit reseed when the sync reports a missing seed or a refresh.
app.post("/api/admin/seed", async (c) => c.json(await c.var.stub.seedTree(), 202));
app.all("/api/admin/seed", methodNotAllowed);

app.get("/api/admin/account-state", async (c) => c.json(await c.var.stub.getAccountState()));
// PUT merges a JSON `{rows, expandedKeys}` account state (see `parseAccountState`) into the account tables.
app.put("/api/admin/account-state", async (c) => {
	const state = parseAccountState(await c.req.json().catch(() => {}));
	if (!state) {
		return new Response("Expected a JSON {rows, expandedKeys} account state", {status: 400});
	}
	return c.json(await c.var.stub.putAccountState(state));
});
app.all("/api/admin/account-state", methodNotAllowed);

app.all("/api/*", () => new Response("Not found", {status: 404}));

app.all("*", async (c) => c.env.ASSETS.fetch(c.req.raw));

/**
 * The OAuth provider answers discovery, `/oauth/register`, `/oauth/token` and bearer-checked `/mcp` itself (outside
 * `createHttpApp`, so the API's compression never touches MCP's JSON-RPC responses), and passes the rest to `app`.
 */
export default {
	async fetch(request, env, ctx) {
		return oauthProviderFor(new URL(request.url).origin, app).fetch(request, env, ctx);
	},
} satisfies ExportedHandler<WorkerEnv>;
