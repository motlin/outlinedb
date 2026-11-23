import {afterAll, beforeAll, describe, expect, it} from "vite-plus/test";
import {readJson, startHarness} from "./harness";
import type {Harness} from "./harness";
import type {ProbeStore} from "./probe-entry";

const PASSWORD = "correct-horse-battery";

describe("connecting an account to workflowy.com", () =>
{
	let harness: Harness;
	const logins: string[] = [];

	beforeAll(async () =>
	{
		harness = await startHarness(
			"./probe-entry.ts",
			"ProbeStore",
			undefined,
			{
				ACCESS_DEV_IDENTITY: "dev",
				OUTLINEDB_CREDENTIALS_KEY: "test-credentials-key",
				WORKFLOWY_API_URL: "http://upstream.test",
			},
			{
				outboundService: async (request: Request): Promise<Response> =>
				{
					const url = new URL(request.url);
					if (url.pathname !== "/ajax_login")
					{
						return new Response(
							"unexpected",
							{
								status: 500,
							},
						);
					}
					const form = new URLSearchParams(await request.text());
					logins.push(form.get("username") ?? "");
					return form.get("password") === PASSWORD
						? new Response(
								"",
								{
									headers:
									{
										"set-cookie": `sessionid=upstream-session-${String(logins.length)}; Path=/; HttpOnly`,
									},
								},
							)
						: Response.json(
								{
									success: false,
									errors:
									{
										__all__: ["Wrong email or password"],
									},
								},
							);
				},
			},
		);
	}, 60_000);
	afterAll(async () =>
	{
		await harness.dispose();
	});

	async function store(): Promise<DurableObjectStub<ProbeStore>>
	{
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Miniflare types its namespace with undici classes
		const ns = (await harness.mf.getDurableObjectNamespace(
			"USER_STORE",
		)) as unknown as DurableObjectNamespace<ProbeStore>;
		return ns.getByName("dev");
	}

	async function send(
		method: string,
		body?: unknown,
	): Promise<
	{
		status: number;
		body: unknown;
	}>
	{
		const response = await harness.mf.dispatchFetch(
			"http://localhost/api/v1/workflowy-connection",
			{
				method,
				headers:
				{
					"content-type": "application/json",
				},
				body: body === undefined ? undefined : JSON.stringify(body),
			},
		);
		return {
			status: response.status,
			body: await readJson(response),
		};
	}

	/** The stored session's opened cookie, how many sealed BLOBs the connection's versions hold, and what leaked anywhere. */
	async function stored(): Promise<
	{
		cookie: string | null;
		blobs: number;
		passwordStored: boolean;
		cookieInPlaintext: boolean;
	}>
	{
		const stub = await store();
		const dump = await stub.storageDump();
		return {
			cookie: await stub.openedWorkflowySession(),
			blobs:
				dump
					.split("\n")
					.filter((line) => line.startsWith("workflowy_connection|"))
					.join("\n")
					.split("blob:").length - 1,
			passwordStored: dump.includes(PASSWORD),
			cookieInPlaintext: dump.includes("upstream-session"),
		};
	}

	it("starts disconnected, refuses keep-syncing before a connection, and keeps nothing from a failed login", async () =>
	{
		const before = await send("GET");
		const mirror = await send(
			"PATCH",
			{
				mirror: true,
			},
		);
		const wrong = await send(
			"POST",
			{
				email: "alice@example.com",
				password: "wrong-password",
			},
		);
		const after = await send("GET");
		expect(
			{
				before,
				mirror,
				wrong,
				after,
				logins,
				stored: await stored(),
			},
		).toStrictEqual(
			{
				before:
				{
					status: 200,
					body:
					{
						connected: false,
					},
				},
				mirror:
				{
					status: 409,
					body:
					{
						ok: false,
						status: 409,
						error: "workflowy-not-connected",
					},
				},
				wrong:
				{
					status: 422,
					body:
					{
						ok: false,
						status: 422,
						error: "workflowy-login-failed",
						message: "Login failed: Wrong email or password",
					},
				},
				after:
				{
					status: 200,
					body:
					{
						connected: false,
					},
				},
				logins: ["alice@example.com"],
				stored:
				{
					cookie: null,
					blobs: 0,
					passwordStored: false,
					cookieInPlaintext: false,
				},
			},
		);
	});

	it("logs in once, keeps only the sealed cookie, defaults keep-syncing off, and keeps one sealed copy across versions", async () =>
	{
		const connected = await send(
			"POST",
			{
				email: " alice@example.com ",
				password: PASSWORD,
			},
		);
		const afterConnect = await stored();
		const mirrored = await send(
			"PATCH",
			{
				mirror: true,
			},
		);
		const reconnected = await send(
			"POST",
			{
				email: "alice@example.com",
				password: PASSWORD,
			},
		);
		expect(
			{
				connected,
				afterConnect,
				mirrored,
				reconnected,
				afterReconnect: await stored(),
			},
		).toStrictEqual(
			{
				connected:
				{
					status: 200,
					body:
					{
						connected: true,
						status: "connected",
						email: "alice@example.com",
						mirror: false,
						lastSyncAt: null,
					},
				},
				afterConnect:
				{
					cookie: "sessionid=upstream-session-2",
					blobs: 2,
					passwordStored: false,
					cookieInPlaintext: false,
				},
				mirrored:
				{
					status: 200,
					body:
					{
						connected: true,
						status: "connected",
						email: "alice@example.com",
						mirror: true,
						lastSyncAt: null,
					},
				},
				// A reconnect replaces the cookie but keeps the keep-syncing choice.
				reconnected:
				{
					status: 200,
					body:
					{
						connected: true,
						status: "connected",
						email: "alice@example.com",
						mirror: true,
						lastSyncAt: null,
					},
				},
				// Only the live version holds a sealed cookie (its nonce and ciphertext); closed versions were stripped.
				afterReconnect:
				{
					cookie: "sessionid=upstream-session-3",
					blobs: 2,
					passwordStored: false,
					cookieInPlaintext: false,
				},
			},
		);
	});

	it("disconnects by phasing the connection out and wiping every sealed cookie", async () =>
	{
		const disconnected = await send("DELETE");
		expect(
			{
				disconnected,
				after: await send("GET"),
				stored: await stored(),
			},
		).toStrictEqual(
			{
				disconnected:
				{
					status: 200,
					body:
					{
						connected: false,
					},
				},
				after:
				{
					status: 200,
					body:
					{
						connected: false,
					},
				},
				stored:
				{
					cookie: null,
					blobs: 0,
					passwordStored: false,
					cookieInPlaintext: false,
				},
			},
		);
	});
});
