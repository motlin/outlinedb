/**
 * A relay of workflowy.com's server-rendered login form (`/login/`), one step at a time, so a person can answer
 * whatever it asks for next: the email first, then a password, then perhaps a one-time code. Each step POSTs the
 * form's hidden values, the email and the person's answers with the attempt's cookie jar, and reads the reply: a form
 * asking for more fields (with its error list), a captcha, or a jar holding the `sessionid` a login sets. Nothing here
 * keeps an answer: the state a step returns holds only the cookies and the form's hidden values.
 */

import {z} from "zod";
import {decodeHtmlEntities} from "../search/switcher-rank.js";
import {loginReplyDetail, WORKFLOWY_URL} from "./workflowy-internal-client.js";

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
}

const LoginAttemptStateSchema = z.object(
	{
		jar: z.record(z.string(), z.string()),
		hidden: z.record(z.string(), z.string()),
		fields: z.array(z.string()),
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
			/** `sessionid=...`, the cookie the rest of the internal client sends. */
			cookie: string;
	  }
	|
	  {
			kind: "fields";
			state: LoginAttemptState;
			fields: LoginFormField[];
			errors: string[];
	  }
	|
	  {
			kind: "captcha";
	  }
	|
	  {
			kind: "refused";
			message: string;
			/** workflowy.com's reply, status and text, with the email and every answer redacted. */
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
	for (const [, attrs = ""] of form.matchAll(/<input\b([^>]*)>/giu))
	{
		const input = attributes(attrs);
		const name = input.name ?? "";
		const type = (input.type ?? "text").toLowerCase();
		if (name === "" || name === "email")
		{
			continue;
		}
		if (type === "hidden")
		{
			hidden[name] = input.value ?? "";
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

/** Reads a step's reply into what the person sees next. */
async function outcome(response: Response, jar: CookieJar, secrets: readonly string[]): Promise<LoginStepOutcome>
{
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
		const kept = Object.entries(page.hidden).filter(([, value]) => !secrets.includes(value) || value === "");
		return {
			kind: "fields",
			state:
			{
				jar,
				hidden: Object.fromEntries(kept),
				fields: page.fields.map((field) => field.name),
			},
			fields: page.fields,
			errors: page.errors,
		};
	}
	const session = jar.sessionid;
	if (session !== undefined && response.status < 400)
	{
		return {
			kind: "session",
			cookie: `sessionid=${session}`,
		};
	}
	const errors = page?.errors ?? [];
	return {
		kind: "refused",
		message: `Login failed: ${errors.length > 0 ? errors.join(", ") : "workflowy.com answered unexpectedly"}`,
		detail: replyDetail(response.status, body, secrets),
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
 * Submit the form once more: its hidden values, the email and the person's answers to the fields it asked for
 * (`values`, such as a password or a code; any other key is left out), with the attempt's cookies. The answers live
 * only in this request.
 */
export async function continueWorkflowyLogin(
	email: string,
	state: LoginAttemptState,
	values: Record<string, string>,
	options: LoginRelayOptions = {},
): Promise<LoginStepOutcome>
{
	const base = baseOf(options);
	const answers = Object.fromEntries(state.fields.map((name) => [name, values[name] ?? ""]));
	const form = new URLSearchParams(
		{
			...state.hidden,
			email,
			...answers,
		},
	);
	const cookies = cookieHeader(state.jar);
	const response = await fetcher(options)(
		`${base}/login/`,
		{
			method: "POST",
			headers:
			{
				"Content-Type": "application/x-www-form-urlencoded",
				Referer: base,
				Origin: base,
				...(cookies !== "" &&
				{
					Cookie: cookies,
				}),
			},
			body: form.toString(),
			redirect: "manual",
		},
	);
	return outcome(response, mergeSetCookies(state.jar, response.headers), [email, ...Object.values(answers)]);
}

/** Open the login page for its cookies and hidden values, then submit the email: the first step of an attempt. */
export async function startWorkflowyLogin(email: string, options: LoginRelayOptions = {}): Promise<LoginStepOutcome>
{
	const response = await fetcher(options)(
		`${baseOf(options)}/login/`,
		{
			redirect: "manual",
		},
	);
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
			detail: replyDetail(response.status, body, [email]),
		};
	}
	return continueWorkflowyLogin(
		email,
		{
			jar: mergeSetCookies({}, response.headers),
			hidden: page.hidden,
			fields: [],
		},
		{},
		options,
	);
}
