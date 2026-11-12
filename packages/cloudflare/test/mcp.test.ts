import {afterAll, beforeAll, describe, expect, it} from "vite-plus/test";
import {origin, signUp, startAuthHarness, turnstile} from "./auth-harness";
import type {AuthHarness, SignedUp} from "./auth-harness";
import {authDb, startHarness} from "./harness";
import type {Harness} from "./harness";
import {accessToken, approve, callback, consentCookies, exchange, mcpRpc, openConsent} from "./oauth-flow";
import type {UserStore} from "../src/user-store";

const READ_TOOLS = [
	"outlinedb_cache_status",
	"outlinedb_calendar_day",
	"outlinedb_node_changes",
	"outlinedb_node_get",
	"outlinedb_node_list",
	"outlinedb_search",
];

const ALL_TOOLS = [
	"outlinedb_cache_status",
	"outlinedb_calendar_day",
	"outlinedb_node_changes",
	"outlinedb_node_complete",
	"outlinedb_node_create",
	"outlinedb_node_delete",
	"outlinedb_node_get",
	"outlinedb_node_list",
	"outlinedb_node_mirror",
	"outlinedb_node_move",
	"outlinedb_node_uncomplete",
	"outlinedb_node_update",
	"outlinedb_search",
];

/** Better Auth on, with invite-only signup for `invites`, and no ACCESS_DEV_IDENTITY, so a request has a session or nothing. */
async function startSessionHarness(invites: string, persistDir?: string): Promise<AuthHarness>
{
	return startAuthHarness(
		{
			BETTER_AUTH_SECRET: "test-secret-0123456789abcdef0123456789abcdef",
			SIGNUP_MODE: "invite",
			SIGNUP_INVITES: invites,
			TURNSTILE_SECRET_KEY: turnstile.passSecret,
			TURNSTILE_SITE_KEY: turnstile.siteKey,
		},
		{
			className: "ProbeStore",
			persistDir,
		},
	);
}

async function seedStore(h: Harness, name: string, nodeName: string): Promise<void>
{
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Miniflare types its namespace with undici classes
	const ns = (await h.mf.getDurableObjectNamespace("USER_STORE")) as unknown as DurableObjectNamespace<UserStore>;
	await ns.get(ns.idFromName(name)).fetch(`http://localhost/__seed?name=${encodeURIComponent(nodeName)}`);
}

function toolNames(body: string): string[]
{
	const parsed:
	{
		result:
		{
			tools:
			{
				name: string;
			}[];
		};
	} = JSON.parse(body);
	return parsed.result.tools.map((tool) => tool.name).toSorted();
}

describe("OAuth discovery", () =>
{
	let h: Harness;

	beforeAll(async () =>
	{
		h = await startHarness("../src/worker.ts", "UserStore");
	}, 120_000);

	afterAll(async () =>
	{
		await h.dispose();
	});

	it("publishes authorization server metadata with PKCE, registration and both scopes", async () =>
	{
		const response = await h.mf.dispatchFetch(`${origin}/.well-known/oauth-authorization-server`);
		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toMatchObject(
			{
				issuer: origin,
				authorization_endpoint: `${origin}/authorize`,
				token_endpoint: `${origin}/oauth/token`,
				registration_endpoint: `${origin}/oauth/register`,
				code_challenge_methods_supported: ["S256"],
				scopes_supported: ["mcp:read", "mcp:write", "offline_access"],
			},
		);
	});

	it("publishes protected resource metadata for /mcp", async () =>
	{
		const response = await h.mf.dispatchFetch(`${origin}/.well-known/oauth-protected-resource/mcp`);
		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toMatchObject(
			{
				resource: `${origin}/mcp`,
				authorization_servers: [origin],
				scopes_supported: ["mcp:read"],
			},
		);
	});

	it("answers /mcp without a bearer with 401 pointing at the resource metadata", async () =>
	{
		const response = await h.mf.dispatchFetch(
			`${origin}/mcp`,
			{
				method: "POST",
			},
		);
		expect(response.status).toBe(401);
		expect(response.headers.get("www-authenticate")).toContain(
			`resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
		);
	});

	it("answers /mcp with an unknown bearer with 401", async () =>
	{
		expect((await mcpRpc(h.mf, "not-a-token", 1, "tools/list", {})).status).toBe(401);
	});

	it("registers a public client dynamically", async () =>
	{
		const response = await h.mf.dispatchFetch(
			`${origin}/oauth/register`,
			{
				method: "POST",
				headers:
				{
					"content-type": "application/json",
				},
				body: JSON.stringify(
					{
						client_name: "Claude",
						redirect_uris: [callback],
						token_endpoint_auth_method: "none",
					},
				),
			},
		);
		expect(response.status).toBe(201);
		await expect(response.json()).resolves.toMatchObject(
			{
				client_name: "Claude",
				redirect_uris: [callback],
				token_endpoint_auth_method: "none",
			},
		);
	});
});

describe("OAuth consent", () =>
{
	let h: AuthHarness;
	let alice: SignedUp;

	beforeAll(async () =>
	{
		h = await startSessionHarness("alice@example.com");
		alice = await signUp(h, "alice@example.com");
	}, 120_000);

	afterAll(async () =>
	{
		await h.dispose();
	});

	it("shows a consent page naming the client, where tokens go, and both access levels", async () =>
	{
		const page = await openConsent(h.mf, alice.cookie);
		expect(page.status).toBe(200);
		expect(page.handle).not.toBe("");
		expect(page.cookie).toMatch(/^__Host-oauth-consent-/u);
		expect(page.html).toContain("Claude");
		expect(page.html).toContain("OutlineDB");
		expect(page.html).toContain("alice@example.com");
		expect(page.html).toContain("claude.ai");
		expect(page.html).toContain('name="access" value="read"');
		expect(page.html).toContain('name="access" value="write" checked');
	});

	it("pre-selects read-only when the client asks only for mcp:read", async () =>
	{
		const page = await openConsent(h.mf, alice.cookie, "mcp:read");
		expect(page.html).toContain('name="access" value="read" checked');
		expect(page.html).not.toContain('name="access" value="write" checked');
	});

	it("escapes the client's self-asserted name", async () =>
	{
		const response = await h.mf.dispatchFetch(
			`${origin}/oauth/register`,
			{
				method: "POST",
				headers:
				{
					"content-type": "application/json",
				},
				body: JSON.stringify(
					{
						client_name: "<script>alert(1)</script>",
						redirect_uris: [callback],
						token_endpoint_auth_method: "none",
					},
				),
			},
		);
		const
		{
			client_id: clientId,
		}:
		{
			client_id: string;
		} = JSON.parse(await response.text());
		const query = new URLSearchParams(
			{
				response_type: "code",
				client_id: clientId,
				redirect_uri: callback,
				scope: "mcp:read",
				code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
				code_challenge_method: "S256",
			},
		);
		const html = await (
			await h.mf.dispatchFetch(
				`${origin}/authorize?${query}`,
				{
					headers:
					{
						cookie: alice.cookie,
					},
				},
			)
		).text();
		expect(html).not.toContain("<script>alert(1)</script>");
		expect(html).toContain("&#60;script&#62;");
	});

	it("redirects to the client with a code and the state after approval", async () =>
	{
		const page = await openConsent(h.mf, alice.cookie);
		const redirect = await approve(h.mf, page, "write");
		expect(`${redirect.origin}${redirect.pathname}`).toBe(callback);
		expect(redirect.searchParams.get("state")).toBe("state-1");
		expect(redirect.searchParams.get("code")).toBeTruthy();
	});

	it("redirects with access_denied when the user denies", async () =>
	{
		const page = await openConsent(h.mf, alice.cookie);
		const response = await h.mf.dispatchFetch(
			`${origin}/authorize`,
			{
				method: "POST",
				redirect: "manual",
				headers:
				{
					"content-type": "application/x-www-form-urlencoded",
					cookie: consentCookies(page),
				},
				body: new URLSearchParams(
					{
						handle: page.handle,
						decision: "deny",
					},
				).toString(),
			},
		);
		expect(response.status).toBe(302);
		const location = new URL(response.headers.get("location") ?? "");
		expect([location.searchParams.get("error"), location.searchParams.get("state")]).toStrictEqual([
			"access_denied",
			"state-1",
		]);
	});

	it("issues a read/write token for write access and a read-only token for read access", async () =>
	{
		const write = await accessToken(h.mf, alice.cookie, "write");
		const read = await accessToken(h.mf, alice.cookie, "read");
		expect([write.scope, read.scope]).toStrictEqual(["mcp:read mcp:write", "mcp:read"]);
		expect([typeof write.refresh_token, typeof read.refresh_token]).toStrictEqual(["string", "string"]);
	});

	it("rejects a code exchange with the wrong PKCE verifier", async () =>
	{
		const page = await openConsent(h.mf, alice.cookie);
		const redirect = await approve(h.mf, page, "write");
		const wrong =
		{
			...page,
			verifier: "wrong-verifier-wrong-verifier-wrong-verifier",
		};
		await expect(exchange(h.mf, wrong, redirect)).rejects.toThrow(/token: 400/u);
	});

	// The same harness: a request without a session never sees the signed-up user.
	describe("/authorize without a session", () =>
	{
		it("redirects to /login with the whole /authorize path and query as next", async () =>
		{
			const page = await openConsent(h.mf, "");
			const location = new URL(page.location ?? "", origin);
			const next = new URL(location.searchParams.get("next") ?? "", origin);
			expect(
				{
					status: page.status,
					path: location.pathname,
					nextPath: next.pathname,
				},
			).toStrictEqual(
				{
					status: 302,
					path: "/login",
					nextPath: "/authorize",
				},
			);
			expect([next.searchParams.get("client_id"), next.searchParams.get("state")]).toStrictEqual([
				page.clientId,
				"state-1",
			]);
		});

		it("redirects a forged session token to /login too", async () =>
		{
			const page = await openConsent(h.mf, "better-auth.session_token=forged.token");
			expect([page.status, new URL(page.location ?? "", origin).pathname]).toStrictEqual([302, "/login"]);
		});
	});
});

describe("/mcp with a bearer token", () =>
{
	let h: AuthHarness;
	let alice: SignedUp;
	let bob: SignedUp;

	beforeAll(async () =>
	{
		h = await startSessionHarness("alice@example.com, bob@example.com");
		alice = await signUp(h, "alice@example.com");
		bob = await signUp(h, "bob@example.com");
		await seedStore(h, alice.userId, "Plan the remote MCP");
		await seedStore(h, bob.userId, "Bob's remote node");
	}, 120_000);

	afterAll(async () =>
	{
		await h.dispose();
	});

	it("answers initialize, tools/list and tools/call outlinedb_search from the user's Durable Object with plain JSON", async () =>
	{
		const {access_token: token} = await accessToken(h.mf, alice.cookie, "write");

		const init = await mcpRpc(
			h.mf,
			token,
			1,
			"initialize",
			{
				protocolVersion: "2025-06-18",
				capabilities: {},
				clientInfo:
				{
					name: "test",
					version: "0",
				},
			},
		);
		expect(
			{
				status: init.status,
				type: init.type,
				encoding: init.encoding,
			},
		).toStrictEqual(
			{
				status: 200,
				type: "application/json",
				encoding: null,
			},
		);
		expect(JSON.parse(init.body)).toMatchObject(
			{
				jsonrpc: "2.0",
				id: 1,
				result:
				{
					serverInfo:
					{
						name: "outlinedb",
					},
				},
			},
		);

		const list = await mcpRpc(h.mf, token, 2, "tools/list", {});
		expect(list.status).toBe(200);
		expect(toolNames(list.body)).toStrictEqual(ALL_TOOLS);

		const call = await mcpRpc(
			h.mf,
			token,
			3,
			"tools/call",
			{
				name: "outlinedb_search",
				arguments:
				{
					query: "remote",
				},
			},
		);
		expect(call.status).toBe(200);
		const parsed = JSON.parse(call.body);
		expect(parsed.result.isError).toBeUndefined();
		expect(JSON.parse(parsed.result.content[0].text)).toStrictEqual([
			{
				id: "seed-node",
				name: "Plan the remote MCP",
				note: null,
				parentPath: "",
				completedAt: null,
				url: "https://workflowy.com/#/seednode",
			},
		]);
	});

	it("lists and runs only the read tools for a read-only token", async () =>
	{
		const {access_token: token} = await accessToken(h.mf, alice.cookie, "read");

		const list = await mcpRpc(h.mf, token, 1, "tools/list", {});
		expect(toolNames(list.body)).toStrictEqual(READ_TOOLS);

		const search = await mcpRpc(
			h.mf,
			token,
			2,
			"tools/call",
			{
				name: "outlinedb_search",
				arguments:
				{
					query: "remote",
				},
			},
		);
		expect(JSON.parse(search.body).result.isError).toBeUndefined();

		const create = await mcpRpc(
			h.mf,
			token,
			3,
			"tools/call",
			{
				name: "outlinedb_node_create",
				arguments:
				{
					parentId: "seed-node",
					name: "Sneaky",
				},
			},
		);
		expect(JSON.parse(create.body).result).toStrictEqual(
			{
				isError: true,
				content: [
					{
						type: "text",
						text: "MCP error -32602: Tool outlinedb_node_create not found",
					},
				],
			},
		);
	});

	it("reaches each user's own Durable Object", async () =>
	{
		const tokens = await Promise.all([alice, bob].map(async ({cookie}) => accessToken(h.mf, cookie, "read")));
		const names = await Promise.all(
			tokens.map(async ({access_token: token}) =>
			{
				const call = await mcpRpc(
					h.mf,
					token,
					1,
					"tools/call",
					{
						name: "outlinedb_search",
						arguments:
						{
							query: "remote",
						},
					},
				);
				const rows:
				{
					name: string;
				}[] = JSON.parse(JSON.parse(call.body).result.content[0].text);
				return rows.map(({name}) => name);
			}),
		);
		expect(names).toStrictEqual([["Plan the remote MCP"], ["Bob's remote node"]]);
	});

	it("rejects GET and DELETE with 405, since stateless mode has no server-to-client stream", async () =>
	{
		const {access_token: token} = await accessToken(h.mf, alice.cookie, "write");
		const authorization = `Bearer ${token}`;
		const get = await h.mf.dispatchFetch(
			`${origin}/mcp`,
			{
				headers:
				{
					accept: "text/event-stream",
					authorization,
				},
			},
		);
		const del = await h.mf.dispatchFetch(
			`${origin}/mcp`,
			{
				method: "DELETE",
				headers:
				{
					authorization,
				},
			},
		);
		expect([get.status, del.status]).toStrictEqual([405, 405]);
	});
});

describe("/mcp after the user is deleted or unverified", () =>
{
	let h: AuthHarness;

	beforeAll(async () =>
	{
		h = await startSessionHarness("carol@example.com, dave@example.com");
	}, 120_000);

	afterAll(async () =>
	{
		await h.dispose();
	});

	it("returns 403 for a deleted user's still-live token", async () =>
	{
		const carol = await signUp(h, "carol@example.com");
		const {access_token: token} = await accessToken(h.mf, carol.cookie, "write");
		expect((await mcpRpc(h.mf, token, 1, "tools/list", {})).status).toBe(200);

		await (await authDb(h.mf)).prepare('DELETE FROM "user" WHERE id = ?').bind(carol.userId).run();
		expect((await mcpRpc(h.mf, token, 2, "tools/list", {})).status).toBe(403);
	});

	it("returns 403 for a user whose email is no longer verified", async () =>
	{
		const dave = await signUp(h, "dave@example.com");
		const {access_token: token} = await accessToken(h.mf, dave.cookie, "read");

		await (await authDb(h.mf)).prepare('UPDATE "user" SET emailVerified = 0 WHERE id = ?').bind(dave.userId).run();
		expect((await mcpRpc(h.mf, token, 1, "tools/list", {})).status).toBe(403);
	});
});
