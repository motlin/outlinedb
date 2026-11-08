import {betterAuth} from "better-auth";
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
		// Cloudflare sets the client IP here; without it every client shares one rate-limit bucket per path.
		advanced: {ipAddress: {ipAddressHeaders: ["cf-connecting-ip"]}},
	});
}
