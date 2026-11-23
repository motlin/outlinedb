import {afterAll, beforeAll, describe, expect, it} from "vite-plus/test";
import {readJson, startHarness} from "./harness";
import type {Harness} from "./harness";
import type {ProbeStore} from "./probe-entry";

const PASSWORD = "correct-horse-battery";
const CODE = "WF-4242";

/** One request the fake workflowy.com received: what the relay sent upstream, cookies and form fields included. */
interface Upstream
{
	method: string;
	path: string;
	cookie: string | null;
	referer: string | null;
	origin: string | null;
	form: Record<string, string>;
}

/** workflowy.com's login page as its server renders it: hidden values, the email, the inputs asked for, any errors. */
function loginPage(
	email: string,
	inputs: string,
	errors: string[] = [],
	headers: Record<string, string> = {},
): Response
{
	const list = errors.length === 0 ? "" : `<ul class="errorlist nonfield"><li>${errors.join("</li><li>")}</li></ul>`;
	return new Response(
		`<!doctype html><html><head><script>if (document.querySelector("#code")) {}</script></head><body>
<form method="POST">${list}
<input type="hidden" name="next" value="/"><input type="hidden" name="utm_source" value="">
<input type="hidden" name="utm_campaign" value=""><input type="hidden" name="utm_medium" value="">
<input type="email" name="email" id="id_email" value="${email}">${inputs}
<button type="submit">Log in</button></form></body></html>`,
		{
			headers:
			{
				"content-type": "text/html; charset=utf-8",
				...headers,
			},
		},
	);
}

const PASSWORD_INPUT =
	'<div id="password"><label for="id_password">Password</label><input type="password" name="password" id="id_password"></div>';

describe("connecting an account to workflowy.com", () =>
{
	let harness: Harness;
	const upstream: Upstream[] = [];
	let sessions = 0;

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
				// workflowy.com's /login/ form: email, then password, then an emailed code, then the session.
				outboundService: async (request: Request): Promise<Response> =>
				{
					const url = new URL(request.url);
					const form = Object.fromEntries(new URLSearchParams(await request.text()));
					upstream.push(
						{
							method: request.method,
							path: url.pathname,
							cookie: request.headers.get("cookie"),
							referer: request.headers.get("referer"),
							origin: request.headers.get("origin"),
							form,
						},
					);
					const cookie = request.headers.get("cookie") ?? "";
					if (url.pathname === "/")
					{
						return new Response(
							"<!doctype html><html><body>Workflowy</body></html>",
							{
								headers:
								{
									"content-type": "text/html; charset=utf-8",
									"set-cookie": "csrftoken=csrf-1; Path=/",
								},
							},
						);
					}
					// The auth cookie's second hop: no cookie on the first redirect, `wfauth` on this one.
					if (url.pathname === "/login/complete/")
					{
						return new Response(
							null,
							{
								status: 302,
								headers:
								{
									location: "http://upstream.test/",
									"set-cookie": "wfauth=auth-value-1; Path=/; HttpOnly",
								},
							},
						);
					}
					// An authenticated session reads init data; anything else gets workflowy.com's 404 page.
					if (url.pathname === "/get_initialization_data")
					{
						return /sessionid=upstream-session-|wfauth=auth-value-/u.test(cookie)
							? Response.json(
									{
										projectTreeData:
										{
											mainProjectTreeInfo:
											{
												initialMostRecentOperationTransactionId: "1",
											},
										},
									},
								)
							: new Response(
									`<!doctype html><html><body>${"Not found ".repeat(1000)}</body></html>`,
									{
										status: 404,
										headers:
										{
											"content-type": "text/html; charset=utf-8",
										},
									},
								);
					}
					if (url.pathname !== "/login/")
					{
						return new Response(
							"unexpected",
							{
								status: 500,
							},
						);
					}
					if (request.method === "GET")
					{
						return loginPage(
							"",
							"",
							[],
							{
								"set-cookie": "_bess=b1; Path=/; HttpOnly",
							},
						);
					}
					const email = form.email ?? "";
					if (email === "bot@example.com")
					{
						return loginPage(email, '<div class="g-recaptcha" data-sitekey="site"></div>', [
							"Just making sure you&#x27;re human...",
						]);
					}
					if (email === "odd@example.com")
					{
						return new Response(
							`<html><head><style>body{}</style></head><body><h1>Server error</h1><p>No login for ${email}</p></body></html>`,
							{
								status: 500,
							},
						);
					}
					if (form.code !== undefined)
					{
						if (form.code !== CODE)
						{
							return loginPage(
								email,
								'<input type="hidden" name="login_step" value="code"><input type="text" name="code" id="id_code" autocomplete="one-time-code">',
								["That code is not right."],
							);
						}
						sessions++;
						return new Response(
							null,
							{
								status: 302,
								headers:
								{
									location: "/",
									"set-cookie": `sessionid=upstream-session-${String(sessions)}; Path=/; HttpOnly`,
								},
							},
						);
					}
					if (form.password === undefined)
					{
						return loginPage(email, PASSWORD_INPUT);
					}
					if (form.password !== PASSWORD)
					{
						return loginPage(email, PASSWORD_INPUT, ["Please enter a correct email and password."]);
					}
					// A login that ends with only an anonymous session, which init data refuses.
					if (email === "anon@example.com")
					{
						return new Response(
							null,
							{
								status: 302,
								headers:
								{
									location: `/?next=%2Fhome&email=${encodeURIComponent(email)}`,
									"set-cookie": "sessionid=anonymous-1; Path=/; HttpOnly",
								},
							},
						);
					}
					// A login whose auth cookie arrives on a later redirect hop, under another name.
					if (email === "hop@example.com")
					{
						return new Response(
							null,
							{
								status: 302,
								headers:
								{
									location: "/login/complete/?token=hop-token",
								},
							},
						);
					}
					// The code step echoes the password back as a hidden input, which the relay must never keep.
					return loginPage(
						email,
						`<input type="hidden" name="login_step" value="code"><input type="hidden" name="password" value="${PASSWORD}"><label for="id_code">Code from your email</label><input type="text" name="code" id="id_code" autocomplete="one-time-code">`,
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

	/**
	 * The stored session's opened cookie, how many sealed BLOBs the connection's versions hold, the live login attempt
	 * opened with this object's key, and whether a secret shows anywhere in the database.
	 */
	async function stored(): Promise<
	{
		cookie: string | null;
		blobs: number;
		attempt: unknown;
		secretsStored: boolean;
		cookieInPlaintext: boolean;
	}>
	{
		const stub = await store();
		const dump = await stub.storageDump();
		const attempt = await stub.openedWorkflowyLoginAttempt();
		const everything = `${dump}\n${attempt ?? ""}`;
		return {
			cookie: await stub.openedWorkflowySession(),
			blobs:
				dump
					.split("\n")
					.filter((line) => line.startsWith("workflowy_connection|"))
					.join("\n")
					.split("blob:").length - 1,
			attempt: attempt === null ? null : JSON.parse(attempt),
			secretsStored: [PASSWORD, "wrong-password", CODE, "WF-0000"].some((secret) => everything.includes(secret)),
			cookieInPlaintext: ["upstream-session", "auth-value", "anonymous-1", "csrf-1"].some((value) =>
				dump.includes(value),
			),
		};
	}

	/** The fields a login step asks for: the relay's generic description of each visible input. */
	const PASSWORD_FIELD =
	{
		name: "password",
		type: "password",
		label: "Password",
	};
	const CODE_FIELD =
	{
		name: "code",
		type: "text",
		label: "Code from your email",
	};
	const HIDDEN =
	{
		next: "/",
		utm_source: "",
		utm_campaign: "",
		utm_medium: "",
	};

	/** What the relay sends upstream for each step, as the fake recorded it. */
	function post(cookie: string, form: Record<string, string>): Upstream
	{
		return {
			method: "POST",
			path: "/login/",
			cookie,
			referer: "http://upstream.test",
			origin: "http://upstream.test",
			form,
		};
	}
	const GET_LOGIN: Upstream =
	{
		method: "GET",
		path: "/login/",
		cookie: null,
		referer: null,
		origin: null,
		form: {},
	};
	const INIT_PATH = "/get_initialization_data";

	/** A redirect hop the relay follows, or the init data read that verifies the login, with the jar it sent. */
	function get(path: string, cookie: string): Upstream
	{
		return {
			...GET_LOGIN,
			path,
			cookie,
		};
	}

	function attemptId(body: unknown): string
	{
		const id: unknown = typeof body === "object" && body !== null ? Reflect.get(body, "attemptId") : undefined;
		return typeof id === "string" ? id : "";
	}

	it("starts disconnected, and ends an attempt on a captcha, an unexpected reply, an unknown or expired attempt, keeping nothing", async () =>
	{
		const before = await send("GET");
		const anonStarted = await send(
			"POST",
			{
				email: "anon@example.com",
			},
		);
		const anon = await send(
			"POST",
			{
				attemptId: attemptId(anonStarted.body),
				values:
				{
					password: PASSWORD,
				},
			},
		);
		const mirror = await send(
			"PATCH",
			{
				mirror: true,
			},
		);
		const captcha = await send(
			"POST",
			{
				email: "bot@example.com",
			},
		);
		const odd = await send(
			"POST",
			{
				email: "odd@example.com",
			},
		);
		const unknown = await send(
			"POST",
			{
				attemptId: "no-such-attempt",
				values:
				{
					password: PASSWORD,
				},
			},
		);
		const started = await send(
			"POST",
			{
				email: "alice@example.com",
			},
		);
		await (await store()).ageWorkflowyLoginAttempt(10 * 60 * 1000);
		const expired = await send(
			"POST",
			{
				attemptId: attemptId(started.body),
				values:
				{
					password: PASSWORD,
				},
			},
		);
		const after = await send("GET");
		expect(
			{
				before,
				anon,
				mirror,
				captcha,
				odd,
				unknown,
				started,
				expired,
				after,
				upstream: upstream.splice(0),
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
				// Every hop is followed, but init data refuses the jar: the account stays disconnected, and the detail
				// shows each request's status, redirect path and cookie names, never a value, query value or secret.
				anon:
				{
					status: 422,
					body:
					{
						ok: false,
						status: 422,
						error: "workflowy-login-unverified",
						message: "workflowy.com finished the sign-in, but did not accept the session it set.",
						detail: "GET /login/ -> 200 set [_bess]; POST /login/ -> 200; POST /login/ -> 302 /?next=&email= set [sessionid]; GET /?next=&email= -> 200 set [csrftoken]; jar [_bess, sessionid, csrftoken]; verify GET /get_initialization_data -> 404 text/html",
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
				captcha:
				{
					status: 422,
					body:
					{
						ok: false,
						status: 422,
						error: "workflowy-captcha",
						message: "workflowy.com asked for a captcha. Try again later.",
					},
				},
				// The page's text, without its markup or style, with the email redacted.
				odd:
				{
					status: 422,
					body:
					{
						ok: false,
						status: 422,
						error: "workflowy-login-failed",
						message: "Login failed: workflowy.com answered unexpectedly",
						detail: "HTTP 500: Server error No login for [redacted]",
					},
				},
				unknown:
				{
					status: 409,
					body:
					{
						ok: false,
						status: 409,
						error: "workflowy-login-expired",
					},
				},
				started:
				{
					status: 200,
					body:
					{
						attemptId: attemptId(started.body),
						fields: [PASSWORD_FIELD],
						errors: [],
					},
				},
				// Ten minutes on, the attempt is gone and its password never left OutlineDB.
				expired:
				{
					status: 409,
					body:
					{
						ok: false,
						status: 409,
						error: "workflowy-login-expired",
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
				upstream: [
					GET_LOGIN,
					post(
						"_bess=b1",
						{
							...HIDDEN,
							email: "anon@example.com",
						},
					),
					post(
						"_bess=b1",
						{
							...HIDDEN,
							email: "anon@example.com",
							password: PASSWORD,
						},
					),
					get("/", "_bess=b1; sessionid=anonymous-1"),
					get(INIT_PATH, "_bess=b1; sessionid=anonymous-1; csrftoken=csrf-1"),
					GET_LOGIN,
					post(
						"_bess=b1",
						{
							...HIDDEN,
							email: "bot@example.com",
						},
					),
					GET_LOGIN,
					post(
						"_bess=b1",
						{
							...HIDDEN,
							email: "odd@example.com",
						},
					),
					GET_LOGIN,
					post(
						"_bess=b1",
						{
							...HIDDEN,
							email: "alice@example.com",
						},
					),
				],
				stored:
				{
					cookie: null,
					blobs: 0,
					attempt: null,
					secretsStored: false,
					cookieInPlaintext: false,
				},
			},
		);
	});

	it("relays email, password and code, re-asks after a wrong answer, and keeps only the sealed session, never a password or code", async () =>
	{
		const started = await send(
			"POST",
			{
				email: " alice@example.com ",
			},
		);
		const id = attemptId(started.body);
		const afterEmail = await stored();
		const wrong = await send(
			"POST",
			{
				attemptId: id,
				values:
				{
					password: "wrong-password",
				},
			},
		);
		const missing = await send(
			"POST",
			{
				attemptId: id,
				values: {},
			},
		);
		const password = await send(
			"POST",
			{
				attemptId: id,
				values:
				{
					password: PASSWORD,
					next: "https://evil.test/",
				},
			},
		);
		const afterPassword = await stored();
		const wrongCode = await send(
			"POST",
			{
				attemptId: id,
				values:
				{
					code: "WF-0000",
				},
			},
		);
		const connected = await send(
			"POST",
			{
				attemptId: id,
				values:
				{
					code: CODE,
				},
			},
		);
		const replay = await send(
			"POST",
			{
				attemptId: id,
				values:
				{
					code: CODE,
				},
			},
		);
		expect(
			{
				started,
				afterEmail,
				wrong,
				missing,
				password,
				afterPassword,
				wrongCode,
				connected,
				replay,
				upstream: upstream.splice(0),
				stored: await stored(),
			},
		).toStrictEqual(
			{
				started:
				{
					status: 200,
					body:
					{
						attemptId: id,
						fields: [PASSWORD_FIELD],
						errors: [],
					},
				},
				// Between steps the object keeps only workflowy.com's cookies and the form's hidden values, sealed.
				afterEmail:
				{
					cookie: null,
					blobs: 0,
					attempt:
					{
						attemptId: id,
						email: "alice@example.com",
						state:
						{
							jar:
							{
								_bess: "b1",
							},
							hidden: HIDDEN,
							fields: ["password"],
							// Each request's status, path and cookie names, for a login that fails to verify.
							trace: ["GET /login/ -> 200 set [_bess]", "POST /login/ -> 200"],
						},
					},
					secretsStored: false,
					cookieInPlaintext: false,
				},
				wrong:
				{
					status: 200,
					body:
					{
						attemptId: id,
						fields: [PASSWORD_FIELD],
						errors: ["Please enter a correct email and password."],
					},
				},
				missing:
				{
					status: 400,
					body:
					{
						ok: false,
						status: 400,
						error: "workflowy-login-incomplete",
						message: "Fill in password",
					},
				},
				password:
				{
					status: 200,
					body:
					{
						attemptId: id,
						fields: [CODE_FIELD],
						errors: [],
					},
				},
				// The code step's hidden echo of the password is dropped, not kept.
				afterPassword:
				{
					cookie: null,
					blobs: 0,
					attempt:
					{
						attemptId: id,
						email: "alice@example.com",
						state:
						{
							jar:
							{
								_bess: "b1",
							},
							hidden:
							{
								...HIDDEN,
								login_step: "code",
							},
							fields: ["code"],
							trace: [
								"GET /login/ -> 200 set [_bess]",
								"POST /login/ -> 200",
								"POST /login/ -> 200",
								"POST /login/ -> 200",
							],
						},
					},
					secretsStored: false,
					cookieInPlaintext: false,
				},
				wrongCode:
				{
					status: 200,
					body:
					{
						attemptId: id,
						fields: [
							{
								...CODE_FIELD,
								label: "code",
							},
						],
						errors: ["That code is not right."],
					},
				},
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
				// A finished attempt is gone.
				replay:
				{
					status: 409,
					body:
					{
						ok: false,
						status: 409,
						error: "workflowy-login-expired",
					},
				},
				// Only the fields the form asked for go upstream; `next` from the client never does.
				upstream: [
					GET_LOGIN,
					post(
						"_bess=b1",
						{
							...HIDDEN,
							email: "alice@example.com",
						},
					),
					post(
						"_bess=b1",
						{
							...HIDDEN,
							email: "alice@example.com",
							password: "wrong-password",
						},
					),
					post(
						"_bess=b1",
						{
							...HIDDEN,
							email: "alice@example.com",
							password: PASSWORD,
						},
					),
					post(
						"_bess=b1",
						{
							...HIDDEN,
							login_step: "code",
							email: "alice@example.com",
							code: "WF-0000",
						},
					),
					post(
						"_bess=b1",
						{
							...HIDDEN,
							login_step: "code",
							email: "alice@example.com",
							code: CODE,
						},
					),
					get("/", "_bess=b1; sessionid=upstream-session-1"),
					get(INIT_PATH, "_bess=b1; sessionid=upstream-session-1; csrftoken=csrf-1"),
				],
				// The whole jar init data accepted is kept, sealed.
				stored:
				{
					cookie: "_bess=b1; sessionid=upstream-session-1; csrftoken=csrf-1",
					blobs: 2,
					attempt: null,
					secretsStored: false,
					cookieInPlaintext: false,
				},
			},
		);
	});

	it("keeps keep-syncing across a reconnect, with one sealed cookie across versions", async () =>
	{
		const mirrored = await send(
			"PATCH",
			{
				mirror: true,
			},
		);
		const started = await send(
			"POST",
			{
				email: "alice@example.com",
			},
		);
		await send(
			"POST",
			{
				attemptId: attemptId(started.body),
				values:
				{
					password: PASSWORD,
				},
			},
		);
		const reconnected = await send(
			"POST",
			{
				attemptId: attemptId(started.body),
				values:
				{
					code: CODE,
				},
			},
		);
		upstream.length = 0;
		expect(
			{
				mirrored,
				reconnected,
				afterReconnect: await stored(),
			},
		).toStrictEqual(
			{
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
					cookie: "_bess=b1; sessionid=upstream-session-2; csrftoken=csrf-1",
					blobs: 2,
					attempt: null,
					secretsStored: false,
					cookieInPlaintext: false,
				},
			},
		);
	});

	it("follows every redirect hop, keeping cookies set on any of them, and stores the jar init data accepted", async () =>
	{
		const started = await send(
			"POST",
			{
				email: "hop@example.com",
			},
		);
		upstream.length = 0;
		const connected = await send(
			"POST",
			{
				attemptId: attemptId(started.body),
				values:
				{
					password: PASSWORD,
				},
			},
		);
		expect(
			{
				connected,
				upstream: upstream.splice(0),
				stored: await stored(),
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
						email: "hop@example.com",
						mirror: true,
						lastSyncAt: null,
					},
				},
				upstream: [
					post(
						"_bess=b1",
						{
							...HIDDEN,
							email: "hop@example.com",
							password: PASSWORD,
						},
					),
					get("/login/complete/", "_bess=b1"),
					get("/", "_bess=b1; wfauth=auth-value-1"),
					get(INIT_PATH, "_bess=b1; wfauth=auth-value-1; csrftoken=csrf-1"),
				],
				stored:
				{
					cookie: "_bess=b1; wfauth=auth-value-1; csrftoken=csrf-1",
					blobs: 2,
					attempt: null,
					secretsStored: false,
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
					attempt: null,
					secretsStored: false,
					cookieInPlaintext: false,
				},
			},
		);
	});
});
