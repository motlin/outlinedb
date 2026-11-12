import {startHarness, applyD1Migrations} from "./harness";
import type {Harness} from "./harness";

export const origin = "http://localhost";

/** Cloudflare's published Turnstile test keys: the always-pass and always-fail secrets, and the always-pass site key. */
export const turnstile =
{
	passSecret: "1x0000000000000000000000000000000AA",
	failSecret: "2x0000000000000000000000000000000AA",
	siteKey: "1x00000000000000000000AA",
};

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export interface SentEmail
{
	from: string;
	to: string;
	subject: string;
	text: string;
	html: string;
}

export interface AuthHarness extends Harness
{
	/** The JSON bodies posted to Turnstile siteverify, oldest first. */
	siteverify: unknown[];
}

const authBindings =
{
	APP_ORIGIN: origin,
	EMAIL_PROVIDER: "cloudflare",
	EMAIL_FROM: "no-reply@outlinedb.com",
};

/** Answers siteverify like Cloudflare does for its test secrets: success only for the always-pass one. */
async function fakeSiteverify(
	request: Request,
	posted: unknown[],
	otherwise: (request: Request) => Response | Promise<Response>,
): Promise<Response>
{
	if (request.url !== SITEVERIFY_URL)
	{
		return otherwise(request);
	}
	const body: unknown = await request.json();
	posted.push(body);
	const passed =
		typeof body === "object" && body !== null && "secret" in body && body.secret === turnstile.passSecret;
	return passed
		? Response.json(
				{
					success: true,
					"error-codes": [],
					hostname: "localhost",
				},
			)
		: Response.json(
				{
					success: false,
					"error-codes": ["invalid-input-response"],
				},
			);
}

const unexpectedOutbound = () =>
	new Response(
		"unexpected outbound fetch",
		{
			status: 500,
		},
	);

/**
 * The auth test Worker over migrated D1, with siteverify answered by a fake that records what it was sent and every
 * other outbound fetch answered by `otherwise`. `className` picks the Durable Object class `auth-entry.ts` exports.
 */
export async function startAuthHarness(
	bindings: Record<string, string>,
	{
		className = "UserStore",
		otherwise = unexpectedOutbound,
		persistDir,
	}:
	{
		className?: string;
		otherwise?: (request: Request) => Response | Promise<Response>;
		/** A previous harness's directory, kept by `dispose(true)`, to restart over the same D1 and Durable Objects. */
		persistDir?: string;
	} = {},
): Promise<AuthHarness>
{
	const siteverify: unknown[] = [];
	const harness = await startHarness(
		"./auth-entry.ts",
		className,
		persistDir,
		{
			...authBindings,
			...bindings,
		},
		{
			outboundService: async (request: Request) => fakeSiteverify(request, siteverify, otherwise),
		},
	);
	await applyD1Migrations(harness.mf);
	return Object.assign(
		harness,
		{
			siteverify,
		},
	);
}

/** POST JSON to `/api/auth{path}` from the trusted origin, with a Turnstile token unless `headers` overrides it. */
export async function post(h: Harness, path: string, body: unknown, headers: Record<string, string> = {})
{
	return h.mf.dispatchFetch(
		`${origin}/api/auth${path}`,
		{
			method: "POST",
			headers:
			{
				"content-type": "application/json",
				origin,
				"x-captcha-response": "test-token",
				...headers,
			},
			body: JSON.stringify(body),
		},
	);
}

export async function drainEmails(h: Harness): Promise<SentEmail[]>
{
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the test entry's own /__emails, which returns SentEmail[]
	return (await (await h.mf.dispatchFetch(`${origin}/__emails`)).json()) as SentEmail[];
}

/** The one link in an email's text, as a path on this origin. */
export function linkIn(email: SentEmail): string
{
	const match = /https?:\/\/\S+/u.exec(email.text);
	if (!match)
	{
		throw new Error(`No link in ${email.text}`);
	}
	const url = new URL(match[0]);
	return `${url.pathname}${url.search}`;
}

/** The `name=value` pairs of a response's Set-Cookie headers, joined for a Cookie header. */
export function cookiesFrom(response: {
	headers:
	{
		getSetCookie(): string[];
	};
}): string
{
	return response.headers
		.getSetCookie()
		.map((cookie) => cookie.split(";")[0])
		.join("; ");
}

/** The password `signUp` gives every test user. */
const password = "correct horse battery staple";

export interface SignedUp
{
	userId: string;
	/** The Cookie header Better Auth's verification link set: the session token and its cookie cache. */
	cookie: string;
}

/** Sign up an invited email from its own client IP (so rate limits never collide), open its verification link, and read its session. */
export async function signUp(h: Harness, email: string): Promise<SignedUp>
{
	const ip =
	{
		"cf-connecting-ip": `198.51.100.${email.length}`,
	};
	const signup = await post(
		h,
		"/sign-up/email",
		{
			email,
			password,
			name: email,
		},
		ip,
	);
	if (signup.status !== 200)
	{
		throw new Error(`sign-up ${email}: ${signup.status} ${await signup.text()}`);
	}
	const [verification] = await drainEmails(h);
	if (!verification)
	{
		throw new Error(`No verification email for ${email}`);
	}
	const verified = await h.mf.dispatchFetch(
		`${origin}${linkIn(verification)}`,
		{
			redirect: "manual",
		},
	);
	const cookie = cookiesFrom(verified);
	const session = await h.mf.dispatchFetch(
		`${origin}/api/auth/get-session`,
		{
			headers:
			{
				cookie,
			},
		},
	);
	const body: unknown = await session.json();
	const user: unknown = typeof body === "object" && body !== null ? Reflect.get(body, "user") : undefined;
	const userId: unknown = typeof user === "object" && user !== null ? Reflect.get(user, "id") : undefined;
	if (typeof userId !== "string")
	{
		throw new TypeError(`No session for ${email}`);
	}
	return {
		userId,
		cookie,
	};
}
