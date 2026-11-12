import {afterAll, beforeAll, describe, expect, it} from "vite-plus/test";
import {drainEmails, origin, post, startAuthHarness, turnstile} from "./auth-harness";
import type {AuthHarness} from "./auth-harness";

const secret = "test-secret-0123456789abcdef0123456789abcdef";
const password = "correct horse battery staple";

async function authConfig(h: AuthHarness)
{
	const response = await h.mf.dispatchFetch(`${origin}/api/auth-config`);
	return {
		status: response.status,
		body: await response.json(),
	};
}

describe("Turnstile with the always-pass secret", () =>
{
	let h: AuthHarness;

	beforeAll(async () =>
	{
		h = await startAuthHarness(
			{
				BETTER_AUTH_SECRET: secret,
				SIGNUP_MODE: "invite",
				SIGNUP_INVITES: "pass@example.com",
				TURNSTILE_SECRET_KEY: turnstile.passSecret,
				TURNSTILE_SITE_KEY: turnstile.siteKey,
			},
		);
	}, 120_000);

	afterAll(async () =>
	{
		await h.dispose();
	});

	it("rejects a signup with no token with 400 before it reaches siteverify", async () =>
	{
		const response = await h.mf.dispatchFetch(
			`${origin}/api/auth/sign-up/email`,
			{
				method: "POST",
				headers:
				{
					"content-type": "application/json",
					origin,
				},
				body: JSON.stringify(
					{
						email: "pass@example.com",
						password,
						name: "Pass",
					},
				),
			},
		);
		expect(
			{
				status: response.status,
				body: await response.json(),
				siteverify: h.siteverify.splice(0),
			},
		).toStrictEqual(
			{
				status: 400,
				body:
				{
					code: "MISSING_RESPONSE",
					message: "Missing CAPTCHA response",
				},
				siteverify: [],
			},
		);
		await expect(drainEmails(h)).resolves.toStrictEqual([]);
	});

	it("checks the token with siteverify and continues to signup", async () =>
	{
		const response = await post(
			h,
			"/sign-up/email",
			{
				email: "pass@example.com",
				password,
				name: "Pass",
			},
			{
				"cf-connecting-ip": "203.0.113.7",
			},
		);
		expect(
			{
				status: response.status,
				siteverify: h.siteverify.splice(0),
			},
		).toStrictEqual(
			{
				status: 200,
				siteverify: [
					{
						secret: turnstile.passSecret,
						response: "test-token",
						remoteip: "203.0.113.7",
					},
				],
			},
		);
		const emails = await drainEmails(h);
		expect(
			emails.map(({to, subject}) => (
			{
				to,
				subject,
			})),
		).toStrictEqual([
			{
				to: "pass@example.com",
				subject: "Verify your OutlineDB email",
			},
		]);
	});

	it("serves /api/auth-config without an Access identity", async () =>
	{
		await expect(authConfig(h)).resolves.toStrictEqual(
			{
				status: 200,
				body:
				{
					hosted: true,
					turnstileSiteKey: turnstile.siteKey,
					providers:
					{
						google: false,
						magicLink: false,
					},
					signupMode: "invite",
				},
			},
		);
	});
});

describe("Turnstile with the always-fail secret", () =>
{
	let h: AuthHarness;

	beforeAll(async () =>
	{
		h = await startAuthHarness(
			{
				BETTER_AUTH_SECRET: secret,
				SIGNUP_MODE: "open",
				TURNSTILE_SECRET_KEY: turnstile.failSecret,
				TURNSTILE_SITE_KEY: turnstile.siteKey,
			},
		);
	}, 120_000);

	afterAll(async () =>
	{
		await h.dispose();
	});

	it("rejects signup, sign-in and password reset with 403 and sends no email", async () =>
	{
		const responses = [
			await post(
				h,
				"/sign-up/email",
				{
					email: "fail@example.com",
					password,
					name: "Fail",
				},
			),
			await post(
				h,
				"/sign-in/email",
				{
					email: "fail@example.com",
					password,
				},
			),
			await post(
				h,
				"/request-password-reset",
				{
					email: "fail@example.com",
					redirectTo: `${origin}/reset`,
				},
			),
		];
		const failed =
		{
			status: 403,
			body:
			{
				code: "VERIFICATION_FAILED",
				message: "Captcha verification failed",
			},
		};
		await expect(
			Promise.all(
				responses.map(async (r) => (
				{
					status: r.status,
					body: await r.json(),
				})),
			),
		).resolves.toStrictEqual([failed, failed, failed]);
		expect(h.siteverify).toHaveLength(3);
		await expect(drainEmails(h)).resolves.toStrictEqual([]);
	});
});

describe("Turnstile with its keys unset", () =>
{
	let h: AuthHarness;

	beforeAll(async () =>
	{
		h = await startAuthHarness(
			{
				BETTER_AUTH_SECRET: secret,
				SIGNUP_MODE: "open",
				TURNSTILE_SITE_KEY: turnstile.siteKey,
			},
		);
	}, 120_000);

	afterAll(async () =>
	{
		await h.dispose();
	});

	it("fails closed with 503 captcha-not-configured on every captcha endpoint, and leaves the others up", async () =>
	{
		const responses = [
			await post(
				h,
				"/sign-up/email",
				{
					email: "unset@example.com",
					password,
					name: "Unset",
				},
			),
			await post(
				h,
				"/sign-in/email",
				{
					email: "unset@example.com",
					password,
				},
			),
			await post(
				h,
				"/request-password-reset",
				{
					email: "unset@example.com",
					redirectTo: `${origin}/reset`,
				},
			),
		];
		const session = await h.mf.dispatchFetch(`${origin}/api/auth/get-session`);
		const unset =
		{
			status: 503,
			body:
			{
				error: "captcha-not-configured",
			},
		};
		expect(
			{
				captcha: await Promise.all(
					responses.map(async (r) => (
					{
						status: r.status,
						body: await r.json(),
					})),
				),
				session:
				{
					status: session.status,
					body: await session.json(),
				},
				siteverify: h.siteverify,
			},
		).toStrictEqual(
			{
				captcha: [unset, unset, unset],
				session:
				{
					status: 200,
					body: null,
				},
				siteverify: [],
			},
		);
		await expect(drainEmails(h)).resolves.toStrictEqual([]);
	});
});

describe("/api/auth-config with nothing configured", () =>
{
	let h: AuthHarness;

	beforeAll(async () =>
	{
		h = await startAuthHarness(
			{
				BETTER_AUTH_SECRET: secret,
				TURNSTILE_SECRET_KEY: turnstile.passSecret,
			},
		);
	}, 120_000);

	afterAll(async () =>
	{
		await h.dispose();
	});

	it("reports no site key and closed signup, and captcha endpoints answer 503 without the site key", async () =>
	{
		await expect(authConfig(h)).resolves.toStrictEqual(
			{
				status: 200,
				body:
				{
					hosted: true,
					turnstileSiteKey: null,
					providers:
					{
						google: false,
						magicLink: false,
					},
					signupMode: "closed",
				},
			},
		);
		const signIn = await post(
			h,
			"/sign-in/email",
			{
				email: "unset@example.com",
				password,
			},
		);
		expect(
			{
				status: signIn.status,
				body: await signIn.json(),
				siteverify: h.siteverify,
			},
		).toStrictEqual(
			{
				status: 503,
				body:
				{
					error: "captcha-not-configured",
				},
				siteverify: [],
			},
		);
	});
});
