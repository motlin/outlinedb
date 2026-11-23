/**
 * A relay of workflowy.com's server-rendered login form (`/login/`), one step at a time, so a person can answer
 * whatever it asks for next: the email first, then a password, then perhaps a one-time code. Each step POSTs the
 * form's hidden values, the email and the person's answers with the attempt's cookie jar, follows every same-origin
 * redirect by hand (keeping the cookies each hop sets), and reads the reply: a form asking for more fields (with its
 * error list), a captcha, or the end of the form. A login only counts once the jar it produced reads
 * `/get_initialization_data`, the request every import starts with. Nothing here keeps an answer: the state a step
 * returns holds only the cookies, the form's hidden values and a trace of each request (status, redirect path, the
 * form's names, cookie names), never a cookie value, a query value or an answer. A hidden input that echoes an answer
 * back (a password carried to the code step) is kept by name only; the person's browser sends that answer again.
 */

import {z} from "zod";
import {decodeHtmlEntities} from "../search/switcher-rank.js";
import {initializationPath, isLoggedOutReply, loginReplyDetail, WORKFLOWY_URL} from "./workflowy-internal-client.js";

/** Cookie name to value, in the order the server set them. */
export type CookieJar = Record<string, string>;

/** One input the login form asks the person to fill. */
export interface LoginFormField
{
	name: string;
	/** The input's `type`, `text` when it names none. */
	type: string;
	/** Its `<label for>` text, else its name. */
	label: string;
}

/** What a login page's POST form holds. */
export interface LoginFormPage
{
	/** Every value the form sends unasked: its hidden inputs, checked boxes and radios, and its default submit button. */
	hidden: Record<string, string>;
	/** Every visible input but the email, in page order. */
	fields: LoginFormField[];
	/** Each `errorlist` item's text. */
	errors: string[];
	/** The page shows a reCAPTCHA, which this relay never tries to answer. */
	captcha: boolean;
}

/** What carries an attempt from one step to the next: never an answer, only cookies and the form's hidden values. */
export interface LoginAttemptState
{
	jar: CookieJar;
	hidden: Record<string, string>;
	/** The names of the fields the form asked for; a step sends answers for these and nothing else. */
	fields: string[];
	/**
	 * Hidden input name to the field whose answer it echoed back, such as a password the code step carries: the next
	 * step sends that answer again under the hidden name, so the answer itself is never kept here.
	 */
	resend: Record<string, string>;
	/** One line per request the attempt sent so far, as {@link traceLine} writes it. */
	trace: string[];
}

const LoginAttemptStateSchema = z.object(
	{
		jar: z.record(z.string(), z.string()),
		hidden: z.record(z.string(), z.string()),
		fields: z.array(z.string()),
		resend: z.record(z.string(), z.string()),
		trace: z.array(z.string()),
	},
);

/** A {@link LoginAttemptState} kept as JSON, or undefined when the text is not one. */
export function parseLoginAttemptState(json: string): LoginAttemptState | undefined
{
	try
	{
		return LoginAttemptStateSchema.safeParse(JSON.parse(json)).data;
	}
	catch
	{
		return undefined;
	}
}

export type LoginStepOutcome =
	|
	  {
			kind: "session";
			/** The whole jar init data accepted, as the `Cookie` header the rest of the internal client sends. */
			cookie: string;
	  }
	|
	  {
			kind: "unverified";
			/** Each request's trace line, the final jar's cookie names and the init data read's status; no values. */
			detail: string;
	  }
	|
	  {
			kind: "fields";
			state: LoginAttemptState;
			fields: LoginFormField[];
			errors: string[];
			/** The fields whose answers the next step must send again ({@link LoginAttemptState.resend}'s values). */
			resend: string[];
			/** Each request's trace line and the jar's cookie names; no values. */
			detail: string;
	  }
	|
	  {
			kind: "captcha";
	  }
	|
	  {
			kind: "refused";
			message: string;
			/** Each request's trace line, the jar's names, then workflowy.com's reply with every secret redacted. */
			detail: string;
	  };

export interface LoginRelayOptions
{
	/** Defaults to the global `fetch`. */
	fetch?: typeof fetch;
	/** Defaults to `https://workflowy.com`. */
	baseUrl?: string;
}

const NOT_ASKED = new Set(["hidden", "submit", "button", "image", "reset", "checkbox", "radio"]);
const SUBMITS = new Set(["submit", "image"]);

function attributes(tag: string): Record<string, string>
{
	const found: Record<string, string> = {};
	for (const match of tag.matchAll(/([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/gu))
	{
		const [, name = "", double, single, bare] = match;
		found[name.toLowerCase()] = decodeHtmlEntities(double ?? single ?? bare ?? "");
	}
	return found;
}

function text(html: string): string
{
	return decodeHtmlEntities(html.replaceAll(/<[^>]*>/gu, ""))
		.replaceAll(/\s+/gu, " ")
		.trim();
}

/** The page's `method="POST"` form, or undefined when it has none. */
export function parseLoginForm(html: string): LoginFormPage | undefined
{
	const form = [...html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/giu)].find(
		([, attrs = ""]) => attributes(attrs).method?.toLowerCase() === "post",
	)?.[2];
	if (form === undefined)
	{
		return undefined;
	}
	const labels = new Map(
		[...form.matchAll(/<label\b([^>]*)>([\s\S]*?)<\/label>/giu)]
			.map(([, attrs = "", inner = ""]) => [attributes(attrs).for ?? "", text(inner)] as const)
			.filter(([, label]) => label !== ""),
	);
	const hidden: Record<string, string> = {};
	const fields: LoginFormField[] = [];
	// Enter submits with the form's first submit button, which sends its name and value when it has a name.
	let submitted = false;
	for (const [, tag = "", attrs = ""] of form.matchAll(/<(input|button)\b([^>]*)>/giu))
	{
		const input = attributes(attrs);
		const name = input.name ?? "";
		const button = tag.toLowerCase() === "button";
		const type = (input.type ?? (button ? "submit" : "text")).toLowerCase();
		if (SUBMITS.has(type))
		{
			if (!submitted && name !== "")
			{
				hidden[name] = input.value ?? "";
			}
			submitted = true;
			continue;
		}
		if (name === "" || name === "email" || button)
		{
			continue;
		}
		if (type === "hidden")
		{
			hidden[name] = input.value ?? "";
		}
		else if ((type === "checkbox" || type === "radio") && "checked" in input)
		{
			hidden[name] = input.value ?? "on";
		}
		else if (!NOT_ASKED.has(type))
		{
			fields.push(
				{
					name,
					type,
					label: labels.get(input.id ?? "") ?? name,
				},
			);
		}
	}
	return {
		hidden,
		fields,
		errors: [...form.matchAll(/<ul\b[^>]*class="errorlist[^"]*"[^>]*>([\s\S]*?)<\/ul>/giu)].flatMap(
			([, list = ""]) => [...list.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/giu)].map(([, item = ""]) => text(item)),
		),
		captcha: html.includes("g-recaptcha"),
	};
}

/** `jar` with every `Set-Cookie` of `headers` applied: a new value replaces, an expired or emptied cookie goes. */
export function mergeSetCookies(jar: CookieJar, headers: Headers): CookieJar
{
	const merged = new Map(Object.entries(jar));
	for (const header of headers.getSetCookie())
	{
		const [pair = "", ...attrs] = header.split(";");
		const equals = pair.indexOf("=");
		if (equals <= 0)
		{
			continue;
		}
		const name = pair.slice(0, equals).trim();
		const value = pair.slice(equals + 1).trim();
		const expired = attrs.some((attr) =>
		{
			const at = attr.indexOf("=");
			const key = attr.slice(0, at).trim().toLowerCase();
			const raw = attr.slice(at + 1).trim();
			return (key === "max-age" && Number(raw) <= 0) || (key === "expires" && Date.parse(raw) <= Date.now());
		});
		if (expired || value === "")
		{
			merged.delete(name);
		}
		else
		{
			merged.set(name, value);
		}
	}
	return Object.fromEntries(merged);
}

export function cookieHeader(jar: CookieJar): string
{
	return Object.entries(jar)
		.map(([name, value]) => `${name}=${value}`)
		.join("; ");
}

/** A redacted, readable account of a reply: an HTML page shows as its text, without scripts and styles. */
function replyDetail(status: number, body: string, secrets: readonly string[]): string
{
	const shown = body.trimStart().startsWith("<")
		? text(body.replaceAll(/<(script|style)\b[\s\S]*?<\/\1>/giu, " ").replaceAll(/<[^>]*>/gu, " "))
		: body;
	return loginReplyDetail(status, shown, undefined, secrets);
}

/** A URL as a trace shows it: its path, its query's keys with every value dropped, and its origin only when foreign. */
function tracePath(url: URL, origin: string): string
{
	const keys = [...new Set(url.searchParams.keys())];
	const query = keys.length === 0 ? "" : `?${keys.map((key) => `${key}=`).join("&")}`;
	return `${url.origin === origin ? "" : url.origin}${url.pathname}${query}`;
}

/** The names, never the values, of the cookies a reply sets. */
function setCookieNames(headers: Headers): string[]
{
	return headers
		.getSetCookie()
		.map((header) => header.slice(0, Math.max(0, header.indexOf("="))).trim())
		.filter((name) => name !== "");
}

function redact(line: string, secrets: readonly string[]): string
{
	return secrets
		.filter((secret) => secret !== "")
		.reduce((shown, secret) => shown.replaceAll(secret, "[redacted]"), line);
}

/**
 * `POST /login/ form [next, email] -> 302 /?next= set [sessionid]`: one request's method, path, the names its form sent,
 * status, redirect and cookie names.
 */
function traceLine(request: StepRequest, url: URL, response: Response, next: URL | undefined, origin: string): string
{
	const names = setCookieNames(response.headers);
	const sent = request.body === undefined ? [] : [...new Set(new URLSearchParams(request.body).keys())];
	return [
		`${request.method ?? "GET"} ${tracePath(url, origin)}`,
		...(sent.length === 0 ? [] : [`form [${sent.join(", ")}]`]),
		`-> ${String(response.status)}`,
		...(next === undefined ? [] : [tracePath(next, origin)]),
		...(names.length === 0 ? [] : [`set [${names.join(", ")}]`]),
	].join(" ");
}

/** How many redirects one step follows before it reads the reply as it stands. */
const MAX_REDIRECTS = 10;

/** One request of a step; a redirect hop is a plain GET. */
interface StepRequest
{
	method?: string;
	headers?: Record<string, string>;
	body?: string;
}

interface Exchange
{
	response: Response;
	jar: CookieJar;
	trace: string[];
}

/**
 * Send one request with the jar, then follow each same-origin redirect with a GET, keeping every hop's cookies: a login
 * may set its session on a redirect hop, under any name. A foreign redirect is not followed, so no cookie leaves.
 */
async function exchange(
	url: string,
	init: StepRequest,
	jar: CookieJar,
	secrets: readonly string[],
	options: LoginRelayOptions,
): Promise<Exchange>
{
	const origin = new URL(baseOf(options)).origin;
	const trace: string[] = [];
	let current = jar;
	let target = new URL(url);
	let request = init;
	for (let hop = 0; ; hop++)
	{
		const cookies = cookieHeader(current);
		const response = await fetcher(options)(
			target.href,
			{
				...request,
				headers:
				{
					...request.headers,
					...(cookies !== "" &&
					{
						Cookie: cookies,
					}),
				},
				redirect: "manual",
			},
		);
		current = mergeSetCookies(current, response.headers);
		const location = response.headers.get("location");
		const next =
			response.status >= 300 && response.status < 400 && location !== null
				? new URL(location, target)
				: undefined;
		trace.push(redact(traceLine(request, target, response, next, origin), secrets));
		if (next?.origin !== origin || hop >= MAX_REDIRECTS)
		{
			return {
				response,
				jar: current,
				trace,
			};
		}
		await response.body?.cancel();
		target = next;
		request = {};
	}
}

/**
 * Read `/get_initialization_data` with the jar, as the import will: undefined when it answers 200 with JSON other than
 * `logged_out`, else a line saying what it answered instead.
 */
async function verifySession(jar: CookieJar, options: LoginRelayOptions): Promise<string | undefined>
{
	const path = initializationPath();
	const response = await fetcher(options)(
		`${baseOf(options)}${path}`,
		{
			headers:
			{
				Cookie: cookieHeader(jar),
				Accept: "application/json",
				"X-Requested-With": "XMLHttpRequest",
			},
			redirect: "manual",
		},
	);
	let reply: unknown;
	try
	{
		reply = JSON.parse(await response.text());
	}
	catch
	{
		reply = undefined;
	}
	if (response.status === 200 && reply !== undefined && !isLoggedOutReply(reply))
	{
		return undefined;
	}
	const type = (response.headers.get("content-type") ?? "").split(";")[0]?.trim() ?? "";
	const location = response.headers.get("location");
	const origin = new URL(baseOf(options)).origin;
	return [
		`verify GET ${path.split("?")[0] ?? path} -> ${String(response.status)}`,
		...(location === null ? [] : [tracePath(new URL(location, origin), origin)]),
		...(type === "" ? [] : [type]),
		...(response.status === 200 ? [reply === undefined ? "not JSON" : "logged_out"] : []),
	].join(" ");
}

/**
 * Reads a step's reply into what the person sees next, checking a finished login against init data. `typed` is each
 * field's answer this step sent; a hidden input echoing one back is kept by name only, for the next step to resend.
 */
async function outcome(
	step: Exchange,
	prior: readonly string[],
	email: string,
	typed: Record<string, string>,
	options: LoginRelayOptions,
): Promise<LoginStepOutcome>
{
	const {response, jar} = step;
	const trace = [...prior, ...step.trace];
	const secrets = [email, ...Object.values(typed)];
	const jarLine = `jar [${Object.keys(jar).join(", ")}]`;
	const body = await response.text();
	const page = parseLoginForm(body);
	if (page?.captcha === true || body.includes("g-recaptcha"))
	{
		return {
			kind: "captcha",
		};
	}
	if (page !== undefined && page.fields.length > 0)
	{
		const hidden: Record<string, string> = {};
		const resend: Record<string, string> = {};
		for (const [name, value] of Object.entries(page.hidden))
		{
			const echoed = value === "" ? undefined : Object.keys(typed).find((field) => typed[field] === value);
			if (echoed === undefined)
			{
				hidden[name] = value;
			}
			else
			{
				resend[name] = echoed;
			}
		}
		return {
			kind: "fields",
			state:
			{
				jar,
				hidden,
				fields: page.fields.map((field) => field.name),
				resend,
				trace,
			},
			fields: page.fields,
			errors: page.errors,
			resend: [...new Set(Object.values(resend))],
			detail: [...trace, jarLine].join("; "),
		};
	}
	if (response.status < 400 && Object.keys(jar).length > 0)
	{
		const refusal = await verifySession(jar, options);
		return refusal === undefined
			?
				{
					kind: "session",
					cookie: cookieHeader(jar),
				}
			:
				{
					kind: "unverified",
					detail: [...trace, jarLine, refusal].join("; "),
				};
	}
	const errors = page?.errors ?? [];
	return {
		kind: "refused",
		message: `Login failed: ${errors.length > 0 ? errors.join(", ") : "workflowy.com answered unexpectedly"}`,
		detail: [...trace, jarLine, replyDetail(response.status, body, secrets)].join("; "),
	};
}

function baseOf(options: LoginRelayOptions): string
{
	return options.baseUrl === undefined || options.baseUrl === "" ? WORKFLOWY_URL : options.baseUrl;
}

function fetcher(options: LoginRelayOptions): typeof fetch
{
	return options.fetch ?? (async (input, init) => fetch(input, init));
}

/**
 * Submit the form once more: its hidden values, the email, each echoed answer the form carried (under its hidden name)
 * and the person's answers to the fields it asked for (`values`, such as a password or a code; any other key is left
 * out), with the attempt's cookies. The answers live only in this request.
 */
export async function continueWorkflowyLogin(
	email: string,
	state: LoginAttemptState,
	values: Record<string, string>,
	options: LoginRelayOptions = {},
): Promise<LoginStepOutcome>
{
	const base = baseOf(options);
	const typed = Object.fromEntries(
		[...Object.values(state.resend), ...state.fields].map((name) => [name, values[name] ?? ""]),
	);
	const echoes = Object.fromEntries(
		Object.entries(state.resend).map(([hidden, field]) => [hidden, typed[field] ?? ""]),
	);
	const answers = Object.fromEntries(state.fields.map((name) => [name, typed[name] ?? ""]));
	const form = new URLSearchParams(
		{
			...state.hidden,
			email,
			...echoes,
			...answers,
		},
	);
	const secrets = [email, ...Object.values(typed)];
	const step = await exchange(
		`${base}/login/`,
		{
			method: "POST",
			headers:
			{
				"Content-Type": "application/x-www-form-urlencoded",
				Referer: base,
				Origin: base,
			},
			body: form.toString(),
		},
		state.jar,
		secrets,
		options,
	);
	return outcome(step, state.trace, email, typed, options);
}

/** Open the login page for its cookies and hidden values, then submit the email: the first step of an attempt. */
export async function startWorkflowyLogin(email: string, options: LoginRelayOptions = {}): Promise<LoginStepOutcome>
{
	const step = await exchange(`${baseOf(options)}/login/`, {}, {}, [email], options);
	const {response} = step;
	const body = await response.text();
	const page = parseLoginForm(body);
	if (page?.captcha === true)
	{
		return {
			kind: "captcha",
		};
	}
	if (!response.ok || page === undefined)
	{
		return {
			kind: "refused",
			message: "Login failed: workflowy.com's login page answered unexpectedly",
			detail: [
				...step.trace,
				`jar [${Object.keys(step.jar).join(", ")}]`,
				replyDetail(response.status, body, [email]),
			].join("; "),
		};
	}
	return continueWorkflowyLogin(
		email,
		{
			jar: step.jar,
			hidden: page.hidden,
			fields: [],
			resend: {},
			trace: step.trace,
		},
		{},
		options,
	);
}
