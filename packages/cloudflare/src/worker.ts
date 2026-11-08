import type {OAuthHelpers} from "@cloudflare/workers-oauth-provider";
import {parseAccountState} from "@workflowy/shared/cache";
import {createHttpApp} from "@workflowy/web/server-app";
import type {StoreClient} from "@workflowy/web/server-app";
import {Hono} from "hono";
import {createMiddleware} from "hono/factory";
import {resolveIdentity} from "./access";
import type {AccessEnv} from "./access";
import {createAuth} from "./auth/auth";
import type {AuthEnv} from "./auth/auth";
import {authorize, oauthProviderFor} from "./oauth";
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
	Variables: {email: string; stub: DurableObjectStub<UserStore>};
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

// Better Auth answers its own routes ahead of the Access identity, and stays off (503) until its secret is set,
// so the Access path never depends on it.
app.on(["GET", "POST"], "/api/auth/*", async (c) => {
	const secret = c.env.BETTER_AUTH_SECRET;
	if (!secret) {
		return c.json({error: "auth-not-configured"}, 503);
	}
	let auth = auths.get(c.env.AUTH_DB);
	if (!auth) {
		auth = createAuth({...c.env, BETTER_AUTH_SECRET: secret});
		auths.set(c.env.AUTH_DB, auth);
	}
	return auth.handler(c.req.raw);
});

// Access gates everything dynamic; the identity names the user's Durable Object.
const identity = createMiddleware<WorkerApp>(async (c, next) => {
	const result = await resolveIdentity(c.req.raw, c.env);
	if ("status" in result) {
		return new Response(result.status === 401 ? "Unauthorized" : "Forbidden", {status: result.status});
	}
	c.set("email", result.email);
	const stub = c.env.USER_STORE.get(c.env.USER_STORE.idFromName(result.email));
	c.set("stub", stub);
	stores.set(c.req.raw, storeClient(stub));
	return next();
});

app.use("/health", identity);
app.use("/api/*", identity);

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
