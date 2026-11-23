import type {OAuthHelpers} from "@cloudflare/workers-oauth-provider";
import {parseAccountState} from "@outlinedb/shared/cache";
import {createHttpApp} from "@outlinedb/web/server-app";
import type {StoreClient} from "@outlinedb/web/server-app";
import {Hono} from "hono";
import {createMiddleware} from "hono/factory";
import type {AccessEnv} from "./access";
import {authConfig, captchaMissing, createAuth} from "./auth/auth";
import type {AuthEnv} from "./auth/auth";
import {provisionUser} from "./auth/provision";
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
function passEncodedBody(response: Response): Response
{
	if (!response.headers.has("content-encoding") || response.webSocket)
	{
		return response;
	}
	return new Response(
		response.body,
		{
			status: response.status,
			statusText: response.statusText,
			headers: response.headers,
			encodeBody: "manual",
		},
	);
}

type WorkerEnv = Env &
	AccessEnv &
	AuthEnv &
	{
		OAUTH_PROVIDER: OAuthHelpers;
	};
interface WorkerApp
{
	Bindings: WorkerEnv;
	Variables:
	{
		principal: Principal;
		stub: DurableObjectStub<UserStore>;
	};
}

const app = new Hono<WorkerApp>();
/** The store for the request being served; `createHttpApp` asks for it by the raw request. */
const stores = new WeakMap<Request, StoreClient>();

app.use("*", async (c, next) =>
{
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
function authFor(env: WorkerEnv): ReturnType<typeof createAuth> | undefined
{
	const secret = env.BETTER_AUTH_SECRET;
	if (!secret)
	{
		return undefined;
	}
	let auth = auths.get(env.AUTH_DB);
	if (!auth)
	{
		auth = createAuth(
			{
				...env,
				BETTER_AUTH_SECRET: secret,
			},
			async (user) => provisionUser(env, user),
		);
		auths.set(env.AUTH_DB, auth);
	}
	return auth;
}

// Better Auth answers its own routes ahead of the Access identity, and stays off (503) until its secret is set,
// so the Access path never depends on it.
app.on(["GET", "POST"], "/api/auth/*", async (c) =>
{
	if (!c.env.BETTER_AUTH_SECRET)
	{
		return c.json(
			{
				error: "auth-not-configured",
			},
			503,
		);
	}
	if (captchaMissing(c.env, c.req.path))
	{
		return c.json(
			{
				error: "captcha-not-configured",
			},
			503,
		);
	}
	return authFor(c.env)?.handler(c.req.raw);
});

// Public: the sign-in page reads it before anyone is signed in. Shadows the Node host's `{hosted: false}`.
app.get("/api/auth-config", (c) => c.json(authConfig(c.env)));

// Access or a verified Better Auth session gates everything dynamic; the principal names the user's Durable Object.
const principal = createMiddleware<WorkerApp>(async (c, next) =>
{
	const result = await resolvePrincipal(c.req.raw, c.env, () => authFor(c.env));
	if ("status" in result)
	{
		return c.json(
			{
				error: result.error,
			},
			result.status,
		);
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
	c.var.principal.kind === "access"
		? next()
		: c.json(
				{
					error: "access-required",
				},
				403,
			),
);

// The OAuth consent page; it resolves its own principal, sending a signed-out browser to /login and back.
app.on(["GET", "POST"], "/authorize", async (c) => authorize(c.req.raw, c.env, () => authFor(c.env)));

// The DO's only HTTP surfaces: a WebSocket cannot cross RPC, and hibernation needs the DO to accept it.
// Registered before the HTTP app, so `/api/v1/nodes/events` is not taken by its `GET /api/v1/nodes/:id`.
for (const path of ["/api/v1/ladder/events", "/api/v1/nodes/events"])
{
	app.get(path, async (c) =>
	{
		if (c.req.header("Upgrade")?.toLowerCase() !== "websocket")
		{
			return new Response(
				"Expected a WebSocket upgrade",
				{
					status: 426,
				},
			);
		}
		return c.var.stub.fetch(c.req.raw);
	});
}

// Any signed-in user's own import progress, which the empty outline shows while the first sync runs.
app.get("/api/v1/sync-status", async (c) => c.json(await c.var.stub.accountSync()));

// The signed-in user's own workflowy.com connection: GET reads it, PATCH {mirror} turns keep-syncing on or off, DELETE
// disconnects and wipes the cookie. POST relays workflowy.com's login form a step at a time: {email} starts an attempt,
// {attemptId, values} answers the fields its last reply asked for (a password, a code). A step that wants more answers
// {attemptId, fields, errors}; the one that signs in answers the connection, keeping only the sealed session cookie.
const WORKFLOWY_CONNECTION = "/api/v1/workflowy-connection";
app.get(WORKFLOWY_CONNECTION, async (c) => c.json(await c.var.stub.getWorkflowyConnection()));
app.post(WORKFLOWY_CONNECTION, async (c) =>
{
	const body: unknown = await c.req.json().catch(() => null);
	const email = field(body, "email");
	const attemptId = field(body, "attemptId");
	const values = stringRecord(field(body, "values"));
	let result;
	if (typeof email === "string" && email.trim() !== "")
	{
		result = await c.var.stub.startWorkflowyLogin(email.trim());
	}
	else if (typeof attemptId === "string" && attemptId !== "" && values !== undefined)
	{
		result = await c.var.stub.continueWorkflowyLogin(attemptId, values);
	}
	else
	{
		return c.json(
			{
				error: "Expected a JSON {email} or {attemptId, values} body",
			},
			400,
		);
	}
	if (!result.ok)
	{
		return c.json(result, result.status);
	}
	return c.json("connection" in result ? result.connection : result.attempt);
});
app.patch(WORKFLOWY_CONNECTION, async (c) =>
{
	const mirror = field(await c.req.json().catch(() => null), "mirror");
	if (typeof mirror !== "boolean")
	{
		return c.json(
			{
				error: "Expected a JSON {mirror: boolean} body",
			},
			400,
		);
	}
	const result = await c.var.stub.setWorkflowyMirror(mirror);
	return result.ok ? c.json(result.connection) : c.json(result, result.status);
});
app.delete(WORKFLOWY_CONNECTION, async (c) => c.json(await c.var.stub.disconnectWorkflowy()));

// The signed-in user's import from their connected workflowy.com account: POST starts it (or keeps the one in progress),
// GET reads the newest run's phase, per-kind counts and failures.
const WORKFLOWY_IMPORT = "/api/v1/workflowy-import";
app.get(WORKFLOWY_IMPORT, async (c) => c.json(await c.var.stub.workflowyImportStatus()));
app.post(WORKFLOWY_IMPORT, async (c) =>
{
	const result = await c.var.stub.startWorkflowyImport();
	return result.ok ? c.json(result.import, 202) : c.json(result, result.status);
});

// Migrated routes are answered here over RPC.
app.route(
	"/",
	createHttpApp(
		{
			resolveStore: (request) =>
			{
				const store = stores.get(request);
				if (!store)
				{
					throw new Error("No store resolved for this request");
				}
				return store;
			},
		},
	),
);

const methodNotAllowed = () =>
	new Response(
		"Method not allowed",
		{
			status: 405,
		},
	);

app.get("/api/admin/status", async (c) => c.json(await c.var.stub.adminStatus()));
app.all("/api/admin/status", methodNotAllowed);

app.get("/api/admin/sync", async (c) => c.json(await c.var.stub.syncStatus()));
app.all("/api/admin/sync", methodNotAllowed);

app.get("/api/admin/account-state", async (c) => c.json(await c.var.stub.getAccountState()));
// PUT merges a JSON `{rows, expandedKeys}` account state (see `parseAccountState`) into the account tables.
app.put("/api/admin/account-state", async (c) =>
{
	const state = parseAccountState(await c.req.json().catch(() => {}));
	if (!state)
	{
		return new Response(
			"Expected a JSON {rows, expandedKeys} account state",
			{
				status: 400,
			},
		);
	}
	return c.json(await c.var.stub.putAccountState(state));
});
app.all("/api/admin/account-state", methodNotAllowed);

app.all(
	"/api/*",
	() =>
		new Response(
			"Not found",
			{
				status: 404,
			},
		),
);

app.all("*", async (c) => c.env.ASSETS.fetch(c.req.raw));

/**
 * The OAuth provider answers discovery, `/oauth/register`, `/oauth/token` and bearer-checked `/mcp` itself (outside
 * `createHttpApp`, so the API's compression never touches MCP's JSON-RPC responses), and passes the rest to `app`.
 */
export default
{
	async fetch(request, env, ctx)
	{
		return oauthProviderFor(new URL(request.url).origin, app).fetch(request, env, ctx);
	},
} satisfies ExportedHandler<WorkerEnv>;

/** `body[name]` when `body` is an object, else undefined. */
/** An object whose every value is a string, or undefined when `value` is anything else. */
function stringRecord(value: unknown): Record<string, string> | undefined
{
	if (typeof value !== "object" || value === null || Array.isArray(value))
	{
		return undefined;
	}
	const entries = Object.entries(value);
	return entries.every(([, inner]) => typeof inner === "string")
		? Object.fromEntries(entries.map(([name, inner]) => [name, String(inner)]))
		: undefined;
}

function field(body: unknown, name: string): unknown
{
	const value: unknown = typeof body === "object" && body !== null ? Reflect.get(body, name) : undefined;
	return value;
}
