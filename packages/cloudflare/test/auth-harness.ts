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
async function fakeSiteverify(
	request: Request,
	posted: unknown[],
	otherwise: (request: Request) => Response | Promise<Response>,
): Promise<Response> {
	if (request.url !== SITEVERIFY_URL) {
		return otherwise(request);
	}
	const body: unknown = await request.json();
	posted.push(body);
	const passed =
		typeof body === "object" && body !== null && "secret" in body && body.secret === turnstile.passSecret;
	return passed
		? Response.json({success: true, "error-codes": [], hostname: "localhost"})
		: Response.json({success: false, "error-codes": ["invalid-input-response"]});
}

const unexpectedOutbound = () => new Response("unexpected outbound fetch", {status: 500});

/**
 * The auth test Worker over migrated D1, with siteverify answered by a fake that records what it was sent and every
 * other outbound fetch answered by `otherwise`. `className` picks the Durable Object class `auth-entry.ts` exports.
 */
export async function startAuthHarness(
	bindings: Record<string, string>,
	{
		className = "UserStore",
		otherwise = unexpectedOutbound,
	}: {className?: string; otherwise?: (request: Request) => Response | Promise<Response>} = {},
): Promise<AuthHarness> {
	const siteverify: unknown[] = [];
	const harness = await startHarness(
		"./auth-entry.ts",
		className,
		undefined,
		{...authBindings, ...bindings},
		{outboundService: async (request: Request) => fakeSiteverify(request, siteverify, otherwise)},
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

/** The one link in an email's text, as a path on this origin. */
export function linkIn(email: SentEmail): string {
	const match = /https?:\/\/\S+/u.exec(email.text);
	if (!match) {
		throw new Error(`No link in ${email.text}`);
	}
	const url = new URL(match[0]);
	return `${url.pathname}${url.search}`;
}

/** The `name=value` pairs of a response's Set-Cookie headers, joined for a Cookie header. */
export function cookiesFrom(response: {headers: {getSetCookie(): string[]}}): string {
	return response.headers
		.getSetCookie()
		.map((cookie) => cookie.split(";")[0])
		.join("; ");
}
