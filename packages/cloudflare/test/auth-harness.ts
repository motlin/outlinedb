import {startHarness, applyD1Migrations} from "./harness";
import type {Harness} from "./harness";

export const origin = "http://localhost";

/** Cloudflare's published Turnstile test keys: the always-pass and always-fail secrets, and the always-pass site key. */
export const turnstile = {
	passSecret: "1x0000000000000000000000000000000AA",
	failSecret: "2x0000000000000000000000000000000AA",
	siteKey: "1x00000000000000000000AA",
};

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export interface SentEmail {
	from: string;
	to: string;
	subject: string;
	text: string;
	html: string;
}

export interface AuthHarness extends Harness {
	/** The JSON bodies posted to Turnstile siteverify, oldest first. */
	siteverify: unknown[];
}

const authBindings = {
	APP_ORIGIN: origin,
	EMAIL_PROVIDER: "cloudflare",
	EMAIL_FROM: "no-reply@outlinedb.com",
};

/** Answers siteverify like Cloudflare does for its test secrets: success only for the always-pass one. */
async function fakeSiteverify(request: Request, posted: unknown[]): Promise<Response> {
	if (request.url !== SITEVERIFY_URL) {
		return new Response("unexpected outbound fetch", {status: 500});
	}
	const body: unknown = await request.json();
	posted.push(body);
	const passed =
		typeof body === "object" && body !== null && "secret" in body && body.secret === turnstile.passSecret;
	return passed
		? Response.json({success: true, "error-codes": [], hostname: "localhost"})
		: Response.json({success: false, "error-codes": ["invalid-input-response"]});
}

/** The auth test Worker over migrated D1, with siteverify answered by a fake that records what it was sent. */
export async function startAuthHarness(bindings: Record<string, string>): Promise<AuthHarness> {
	const siteverify: unknown[] = [];
	const harness = await startHarness(
		"./auth-entry.ts",
		"UserStore",
		undefined,
		{...authBindings, ...bindings},
		{outboundService: async (request: Request) => fakeSiteverify(request, siteverify)},
	);
	await applyD1Migrations(harness.mf);
	return Object.assign(harness, {siteverify});
}

/** POST JSON to `/api/auth{path}` from the trusted origin, with a Turnstile token unless `headers` overrides it. */
export async function post(h: Harness, path: string, body: unknown, headers: Record<string, string> = {}) {
	return h.mf.dispatchFetch(`${origin}/api/auth${path}`, {
		method: "POST",
		headers: {"content-type": "application/json", origin, "x-captcha-response": "test-token", ...headers},
		body: JSON.stringify(body),
	});
}

export async function drainEmails(h: Harness): Promise<SentEmail[]> {
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the test entry's own /__emails, which returns SentEmail[]
	return (await (await h.mf.dispatchFetch(`${origin}/__emails`)).json()) as SentEmail[];
}
