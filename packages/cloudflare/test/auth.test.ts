import {afterAll, beforeAll, describe, expect, it} from "vite-plus/test";
import {drainEmails, origin, post, startAuthHarness, turnstile, cookiesFrom, linkIn} from "./auth-harness";
import type {AuthHarness} from "./auth-harness";
import type {Harness} from "./harness";
import {signupAllowed} from "../src/auth/signup-gate";

describe("auth captcha", () => {
	const secret = "test-secret-0123456789abcdef0123456789abcdef";
	const password = "correct horse battery staple";

	async function authConfig(h: AuthHarness) {
		const response = await h.mf.dispatchFetch(`${origin}/api/auth-config`);
		return {status: response.status, body: await response.json()};
	}

	describe("Turnstile with the always-pass secret", () => {
		let h: AuthHarness;

		beforeAll(async () => {
			h = await startAuthHarness({
				BETTER_AUTH_SECRET: secret,
				SIGNUP_MODE: "invite",
				SIGNUP_INVITES: "pass@example.com",
				TURNSTILE_SECRET_KEY: turnstile.passSecret,
				TURNSTILE_SITE_KEY: turnstile.siteKey,
			});
		}, 120_000);

		afterAll(async () => {
			await h.dispose();
		});

		it("rejects a signup with no token with 400 before it reaches siteverify", async () => {
			const response = await h.mf.dispatchFetch(`${origin}/api/auth/sign-up/email`, {
				method: "POST",
				headers: {"content-type": "application/json", origin},
				body: JSON.stringify({email: "pass@example.com", password, name: "Pass"}),
			});
			expect({
				status: response.status,
				body: await response.json(),
				siteverify: h.siteverify.splice(0),
			}).toStrictEqual({
				status: 400,
				body: {code: "MISSING_RESPONSE", message: "Missing CAPTCHA response"},
				siteverify: [],
			});
			await expect(drainEmails(h)).resolves.toStrictEqual([]);
		});

		it("checks the token with siteverify and continues to signup", async () => {
			const response = await post(
				h,
				"/sign-up/email",
				{email: "pass@example.com", password, name: "Pass"},
				{"cf-connecting-ip": "203.0.113.7"},
			);
			expect({status: response.status, siteverify: h.siteverify.splice(0)}).toStrictEqual({
				status: 200,
				siteverify: [{secret: turnstile.passSecret, response: "test-token", remoteip: "203.0.113.7"}],
			});
			const emails = await drainEmails(h);
			expect(emails.map(({to, subject}) => ({to, subject}))).toStrictEqual([
				{to: "pass@example.com", subject: "Verify your OutlineDB email"},
			]);
		});

		it("serves /api/auth-config without an Access identity", async () => {
			await expect(authConfig(h)).resolves.toStrictEqual({
				status: 200,
				body: {
					hosted: true,
					turnstileSiteKey: turnstile.siteKey,
					providers: {google: false, magicLink: false},
					signupMode: "invite",
				},
			});
		});
	});

	describe("Turnstile with the always-fail secret", () => {
		let h: AuthHarness;

		beforeAll(async () => {
			h = await startAuthHarness({
				BETTER_AUTH_SECRET: secret,
				SIGNUP_MODE: "open",
				TURNSTILE_SECRET_KEY: turnstile.failSecret,
				TURNSTILE_SITE_KEY: turnstile.siteKey,
			});
		}, 120_000);

		afterAll(async () => {
			await h.dispose();
		});

		it("rejects signup, sign-in and password reset with 403 and sends no email", async () => {
			const responses = [
				await post(h, "/sign-up/email", {email: "fail@example.com", password, name: "Fail"}),
				await post(h, "/sign-in/email", {email: "fail@example.com", password}),
				await post(h, "/request-password-reset", {email: "fail@example.com", redirectTo: `${origin}/reset`}),
			];
			const failed = {status: 403, body: {code: "VERIFICATION_FAILED", message: "Captcha verification failed"}};
			await expect(
				Promise.all(responses.map(async (r) => ({status: r.status, body: await r.json()}))),
			).resolves.toStrictEqual([failed, failed, failed]);
			expect(h.siteverify).toHaveLength(3);
			await expect(drainEmails(h)).resolves.toStrictEqual([]);
		});
	});

	describe("Turnstile with its keys unset", () => {
		let h: AuthHarness;

		beforeAll(async () => {
			h = await startAuthHarness({
				BETTER_AUTH_SECRET: secret,
				SIGNUP_MODE: "open",
				TURNSTILE_SITE_KEY: turnstile.siteKey,
			});
		}, 120_000);

		afterAll(async () => {
			await h.dispose();
		});

		it("fails closed with 503 captcha-not-configured on every captcha endpoint, and leaves the others up", async () => {
			const responses = [
				await post(h, "/sign-up/email", {email: "unset@example.com", password, name: "Unset"}),
				await post(h, "/sign-in/email", {email: "unset@example.com", password}),
				await post(h, "/request-password-reset", {email: "unset@example.com", redirectTo: `${origin}/reset`}),
			];
			const session = await h.mf.dispatchFetch(`${origin}/api/auth/get-session`);
			const unset = {status: 503, body: {error: "captcha-not-configured"}};
			expect({
				captcha: await Promise.all(responses.map(async (r) => ({status: r.status, body: await r.json()}))),
				session: {status: session.status, body: await session.json()},
				siteverify: h.siteverify,
			}).toStrictEqual({captcha: [unset, unset, unset], session: {status: 200, body: null}, siteverify: []});
			await expect(drainEmails(h)).resolves.toStrictEqual([]);
		});
	});

	describe("/api/auth-config with nothing configured", () => {
		let h: AuthHarness;

		beforeAll(async () => {
			h = await startAuthHarness({BETTER_AUTH_SECRET: secret, TURNSTILE_SECRET_KEY: turnstile.passSecret});
		}, 120_000);

		afterAll(async () => {
			await h.dispose();
		});

		it("reports no site key and closed signup, and captcha endpoints answer 503 without the site key", async () => {
			await expect(authConfig(h)).resolves.toStrictEqual({
				status: 200,
				body: {
					hosted: true,
					turnstileSiteKey: null,
					providers: {google: false, magicLink: false},
					signupMode: "closed",
				},
			});
			const signIn = await post(h, "/sign-in/email", {email: "unset@example.com", password});
			expect({status: signIn.status, body: await signIn.json(), siteverify: h.siteverify}).toStrictEqual({
				status: 503,
				body: {error: "captcha-not-configured"},
				siteverify: [],
			});
		});
	});
});

describe("auth signup", () => {
	const secret = "test-secret-0123456789abcdef0123456789abcdef";
	const invited = "invited@example.com";
	const password = "correct horse battery staple";
	const captchaKeys = {TURNSTILE_SECRET_KEY: turnstile.passSecret, TURNSTILE_SITE_KEY: turnstile.siteKey};

	describe("signupAllowed", () => {
		it("is closed by default, admits only invited emails in invite mode, and admits anyone when open", () => {
			expect([
				signupAllowed({}, "a@example.com"),
				signupAllowed({SIGNUP_MODE: "closed", SIGNUP_INVITES: "a@example.com"}, "a@example.com"),
				signupAllowed(
					{SIGNUP_MODE: "invite", SIGNUP_INVITES: " A@Example.com , b@example.com"},
					"a@EXAMPLE.com",
				),
				signupAllowed({SIGNUP_MODE: "invite", SIGNUP_INVITES: "a@example.com"}, "c@example.com"),
				signupAllowed({SIGNUP_MODE: "invite"}, "a@example.com"),
				signupAllowed({SIGNUP_MODE: "open"}, "c@example.com"),
				signupAllowed({SIGNUP_MODE: "bogus"}, "c@example.com"),
			]).toStrictEqual([false, false, true, false, false, true, false]);
		});
	});

	describe("Better Auth with signup closed by default", () => {
		let h: Harness;

		beforeAll(async () => {
			h = await startAuthHarness({...captchaKeys, BETTER_AUTH_SECRET: secret});
		}, 120_000);

		afterAll(async () => {
			await h.dispose();
		});

		it("rejects every signup with 403 signup-closed and sends no email", async () => {
			const response = await post(h, "/sign-up/email", {email: invited, password, name: "Invited"});
			expect({status: response.status, body: await response.json()}).toStrictEqual({
				status: 403,
				body: {error: "signup-closed"},
			});
			await expect(drainEmails(h)).resolves.toStrictEqual([]);
		});
	});

	describe("Better Auth without BETTER_AUTH_SECRET", () => {
		let h: Harness;

		beforeAll(async () => {
			h = await startAuthHarness({SIGNUP_MODE: "open"});
		}, 120_000);

		afterAll(async () => {
			await h.dispose();
		});

		it("fails closed with 503 auth-not-configured on GET and POST", async () => {
			const get = await h.mf.dispatchFetch(`${origin}/api/auth/get-session`);
			const signup = await post(h, "/sign-up/email", {email: invited, password, name: "Invited"});
			expect([
				{status: get.status, body: await get.json()},
				{status: signup.status, body: await signup.json()},
			]).toStrictEqual([
				{status: 503, body: {error: "auth-not-configured"}},
				{status: 503, body: {error: "auth-not-configured"}},
			]);
		});
	});

	describe("Better Auth in invite mode", () => {
		let h: Harness;

		beforeAll(async () => {
			h = await startAuthHarness({
				...captchaKeys,
				BETTER_AUTH_SECRET: secret,
				SIGNUP_MODE: "invite",
				SIGNUP_INVITES: `other@example.com, ${invited.toUpperCase()}`,
			});
		}, 120_000);

		afterAll(async () => {
			await h.dispose();
		});

		it("rejects an uninvited email with 403 signup-closed", async () => {
			const response = await post(h, "/sign-up/email", {
				email: "stranger@example.com",
				password,
				name: "Stranger",
			});
			expect({status: response.status, body: await response.json()}).toStrictEqual({
				status: 403,
				body: {error: "signup-closed"},
			});
			await expect(drainEmails(h)).resolves.toStrictEqual([]);
		});

		it("signs up an invited email, verifies it by link, and serves its session; resets its password by link", async () => {
			const signup = await post(h, "/sign-up/email", {email: invited, password, name: "Invited"});
			expect(signup.status).toBe(200);

			const verification = await drainEmails(h);
			expect(verification.map(({from, to, subject}) => ({from, to, subject}))).toStrictEqual([
				{from: "no-reply@outlinedb.com", to: invited, subject: "Verify your OutlineDB email"},
			]);
			const [verifyEmail] = verification;
			if (!verifyEmail) {
				throw new Error("No verification email");
			}
			expect(`${verifyEmail.text} ${verifyEmail.html}`).not.toMatch(/workflowy/iu);

			const early = await post(h, "/sign-in/email", {email: invited, password});
			expect({status: early.status, code: ((await early.json()) as {code?: string}).code}).toStrictEqual({
				status: 403,
				code: "EMAIL_NOT_VERIFIED",
			});
			// Signing in unverified resends the verification email; drop it so the reset below is the only one.
			await drainEmails(h);

			const verified = await h.mf.dispatchFetch(`${origin}${linkIn(verifyEmail)}`, {redirect: "manual"});
			const cookie = cookiesFrom(verified);
			expect(cookie).toContain("better-auth.session_token=");

			const session = await h.mf.dispatchFetch(`${origin}/api/auth/get-session`, {headers: {cookie}});
			const sessionBody = (await session.json()) as {user: {email: string; emailVerified: boolean}};
			expect({email: sessionBody.user.email, emailVerified: sessionBody.user.emailVerified}).toStrictEqual({
				email: invited,
				emailVerified: true,
			});

			const resetRequest = await post(h, "/request-password-reset", {
				email: invited,
				redirectTo: `${origin}/reset`,
			});
			expect(resetRequest.status).toBe(200);
			const reset = await drainEmails(h);
			expect(reset.map(({from, to, subject}) => ({from, to, subject}))).toStrictEqual([
				{from: "no-reply@outlinedb.com", to: invited, subject: "Reset your OutlineDB password"},
			]);
			const [resetEmail] = reset;
			if (!resetEmail) {
				throw new Error("No reset email");
			}
			const resetLink = await h.mf.dispatchFetch(`${origin}${linkIn(resetEmail)}`, {redirect: "manual"});
			const token = new URL(resetLink.headers.get("location") ?? "", origin).searchParams.get("token");
			const newPassword = "a brand new passphrase";
			const changed = await post(h, "/reset-password", {token, newPassword});
			expect(changed.status).toBe(200);

			const oldSignIn = await post(h, "/sign-in/email", {email: invited, password});
			const newSignIn = await post(h, "/sign-in/email", {email: invited, password: newPassword});
			expect([oldSignIn.status, newSignIn.status]).toStrictEqual([401, 200]);
			expect(cookiesFrom(newSignIn)).toContain("better-auth.session_token=");
		});
	});
});
