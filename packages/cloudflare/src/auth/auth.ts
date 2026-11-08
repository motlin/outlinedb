import {betterAuth} from "better-auth";
import {captcha} from "better-auth/plugins/captcha";
import {senderFor} from "../email/send";
import type {EmailEnv, EmailSender} from "../email/send";
import {signupGate} from "./signup-gate";
import type {SignupEnv} from "./signup-gate";

/** Bindings Better Auth needs; `BETTER_AUTH_SECRET` is a secret, and without it `/api/auth/*` stays off. */
export interface AuthEnv extends EmailEnv, SignupEnv {
	AUTH_DB: D1Database;
	/** Var: the public origin, used for links in emails and as the only trusted origin. */
	APP_ORIGIN: string;
	BETTER_AUTH_SECRET?: string;
	/** Secret: the Turnstile secret key. Without it (or the site key) the captcha endpoints answer 503. */
	TURNSTILE_SECRET_KEY?: string;
	/** Var: the public Turnstile site key the sign-in page renders its widget with. */
	TURNSTILE_SITE_KEY?: string;
}

/** The Better Auth endpoints (under `/api/auth`) that need a Turnstile token in `x-captcha-response`. */
const CAPTCHA_ENDPOINTS = ["/sign-up/email", "/sign-in/email", "/request-password-reset"];

/** Whether `pathname` is a captcha endpoint and either Turnstile key is unset, so the request must fail closed. */
export function captchaMissing(env: AuthEnv, pathname: string): boolean {
	const endpoint = pathname.replace(/^\/api\/auth/u, "").replace(/\/+$/u, "");
	return CAPTCHA_ENDPOINTS.includes(endpoint) && (!env.TURNSTILE_SECRET_KEY || !env.TURNSTILE_SITE_KEY);
}

/** The public auth settings the sign-in page needs before anyone is signed in. */
export function authConfig(env: AuthEnv) {
	return {
		hosted: true,
		turnstileSiteKey: env.TURNSTILE_SITE_KEY ?? null,
		providers: {google: false, magicLink: false},
		signupMode: env.SIGNUP_MODE === "open" || env.SIGNUP_MODE === "invite" ? env.SIGNUP_MODE : "closed",
	};
}

/** A link email in plain text and HTML. */
function linkEmail(to: string, subject: string, intro: string, url: string) {
	const escaped = url.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
	return {
		to,
		subject,
		text: `${intro}\n\n${url}\n\nIf you didn't ask for this, you can ignore this email.\n\nOutlineDB`,
		html: `<p>${intro}</p><p><a href="${escaped}">${escaped}</a></p><p>If you didn't ask for this, you can ignore this email.</p><p>OutlineDB</p>`,
	};
}

/** Better Auth over AUTH_DB: email and password with required verification; signup gated by `SIGNUP_MODE`. */
export function createAuth(env: AuthEnv & {BETTER_AUTH_SECRET: string}, sender: EmailSender = senderFor(env)) {
	const origin = env.APP_ORIGIN;
	return betterAuth({
		appName: "OutlineDB",
		baseURL: origin,
		basePath: "/api/auth",
		secret: env.BETTER_AUTH_SECRET,
		database: env.AUTH_DB,
		trustedOrigins: [origin],
		emailAndPassword: {
			enabled: true,
			requireEmailVerification: true,
			async sendResetPassword({user, url}) {
				await sender.send(
					linkEmail(
						user.email,
						"Reset your OutlineDB password",
						"Open this link to choose a new OutlineDB password:",
						url,
					),
				);
			},
		},
		emailVerification: {
			sendOnSignUp: true,
			autoSignInAfterVerification: true,
			async sendVerificationEmail({user, url}) {
				await sender.send(
					linkEmail(
						user.email,
						"Verify your OutlineDB email",
						"Open this link to verify your email and sign in to OutlineDB:",
						url,
					),
				);
			},
		},
		session: {cookieCache: {enabled: true, maxAge: 300}},
		rateLimit: {enabled: true, storage: "database"},
		hooks: {before: signupGate(env)},
		// The Worker answers 503 on these endpoints before Better Auth when a Turnstile key is unset.
		plugins: [
			captcha({
				provider: "cloudflare-turnstile",
				// Empty only if the Worker's 503 guard is bypassed; the plugin then fails closed with 500.
				secretKey: env.TURNSTILE_SECRET_KEY ?? "",
				endpoints: CAPTCHA_ENDPOINTS,
			}),
		],
		// Cloudflare sets the client IP here; without it every client shares one rate-limit bucket per path.
		advanced: {ipAddress: {ipAddressHeaders: ["cf-connecting-ip"]}},
	});
}
