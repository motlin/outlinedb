// @vitest-environment happy-dom
import {afterEach, beforeAll, beforeEach, describe, expect, it, vi} from "vite-plus/test";
import type {Root} from "react-dom/client";

declare global
{
	// React reads this to know act() wraps every update.
	var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const {act, createElement} = await import("react");
const {createRoot} = await import("react-dom/client");
const {AuthApp} = await import("../src/client/auth/auth-pages.js");

interface Call
{
	path: string;
	body: unknown;
	captcha: string | null;
}

let root: Root | undefined;
let host: HTMLElement | undefined;
const calls: Call[] = [];
let config: unknown =
{
	hosted: true,
	turnstileSiteKey: "site-key",
	providers:
	{
		google: false,
		magicLink: false,
	},
	signupMode: "open",
};
let replies: Partial<Record<string, Response>> = {};
const assigned: string[] = [];
const replaced: string[] = [];

/** Lets the fetches, the widget and React settle. */
async function settle(): Promise<void>
{
	for (let turn = 0; turn < 10; turn++)
	{
		await act(async () =>
		{
			await new Promise<void>((resolve) =>
			{
				setTimeout(resolve, 5);
			});
		});
	}
}

beforeAll(() =>
{
	globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() =>
{
	calls.length = 0;
	assigned.length = 0;
	replaced.length = 0;
	replies = {};
	config =
	{
		hosted: true,
		turnstileSiteKey: "site-key",
		providers:
		{
			google: false,
			magicLink: false,
		},
		signupMode: "open",
	};
	vi.stubGlobal(
		"turnstile",
		{
			render: (
				_element: HTMLElement,
				options:
				{
					sitekey: string;
					callback: (token: string) => void;
				},
			) =>
			{
				options.callback(`token-for-${options.sitekey}`);
				return "widget-1";
			},
			remove: () =>
			{
			},
		},
	);
	vi.spyOn(globalThis.location, "assign").mockImplementation((url: string | URL) =>
	{
		assigned.push(String(url));
	});
	vi.spyOn(globalThis.location, "replace").mockImplementation((url: string | URL) =>
	{
		replaced.push(String(url));
	});
	vi.stubGlobal(
		"fetch",
		vi.fn(async (request: string | URL | Request, init?: RequestInit) =>
		{
			const url = new URL(request instanceof Request ? request.url : String(request), globalThis.location.origin);
			if (url.pathname === "/api/auth-config")
			{
				return Response.json(config);
			}
			const headers = new Headers(init?.headers ?? (request instanceof Request ? request.headers : undefined));
			const rawBody = init?.body ?? (request instanceof Request ? await request.text() : undefined);
			calls.push(
				{
					path: url.pathname,
					body: typeof rawBody === "string" && rawBody !== "" ? JSON.parse(rawBody) : null,
					captcha: headers.get("x-captcha-response"),
				},
			);
			return replies[url.pathname]?.clone() ?? Response.json({});
		}),
	);
});

afterEach(async () =>
{
	await act(async () =>
	{
		root?.unmount();
		await Promise.resolve();
	});
	host?.remove();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

async function open(path: string): Promise<void>
{
	globalThis.history.replaceState(null, "", path);
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () =>
	{
		root?.render(createElement(AuthApp));
		await Promise.resolve();
	});
	await settle();
}

function input(name: string): HTMLInputElement
{
	const found = document.querySelector<HTMLInputElement>(`input[name="${name}"]`);
	if (!found)
	{
		throw new Error(`no ${name} input`);
	}
	return found;
}

/** Sets a controlled input's value the way typing does, so React sees the change. */
async function type(name: string, value: string): Promise<void>
{
	const element = input(name);
	// oxlint-disable-next-line typescript/unbound-method -- called with the input as `this` below
	const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
	await act(async () =>
	{
		setter?.call(element, value);
		element.dispatchEvent(
			new Event(
				"input",
				{
					bubbles: true,
				},
			),
		);
		await Promise.resolve();
	});
}

async function submit(): Promise<void>
{
	await act(async () =>
	{
		document.querySelector<HTMLButtonElement>("form button[type=submit]")?.click();
		await Promise.resolve();
	});
	await settle();
}

describe("login", () =>
{
	it("says OutlineDB, never Workflowy", async () =>
	{
		await open("/login");

		expect([
			document.body.textContent.includes("OutlineDB"),
			/workflowy/iu.test(document.body.textContent),
		]).toStrictEqual([true, false]);
	});

	it("posts the credentials with the Turnstile token and goes to next", async () =>
	{
		replies["/api/auth/sign-in/email"] = Response.json(
			{
				token: "t",
				user:
				{
					id: "u1",
				},
			},
		);
		await open("/login?next=%2F%23%2Fabc");

		await type("email", "alice@example.com");
		await type("password", "correct horse");
		await submit();

		expect([calls, assigned]).toStrictEqual([
			[
				{
					path: "/api/auth/sign-in/email",
					body:
					{
						email: "alice@example.com",
						password: "correct horse",
					},
					captcha: "token-for-site-key",
				},
			],
			["/#/abc"],
		]);
	});

	it("shows the unverified message on EMAIL_NOT_VERIFIED", async () =>
	{
		replies["/api/auth/sign-in/email"] = Response.json(
			{
				code: "EMAIL_NOT_VERIFIED",
				message: "Email not verified",
			},
			{
				status: 403,
			},
		);
		await open("/login");

		await type("email", "alice@example.com");
		await type("password", "correct horse");
		await submit();

		expect([document.querySelector("[role=alert]")?.textContent, assigned]).toStrictEqual([
			"Verify your email first: open the link we sent to alice@example.com.",
			[],
		]);
	});
});

describe("signup", () =>
{
	it("posts the signup with the Turnstile token and shows the check-your-email screen", async () =>
	{
		replies["/api/auth/sign-up/email"] = Response.json(
			{
				token: null,
				user:
				{
					id: "u1",
				},
			},
		);
		await open("/signup");

		await type("email", "bob@example.com");
		await type("password", "correct horse");
		await submit();

		expect([
			calls,
			globalThis.location.pathname,
			document.body.textContent.includes("bob@example.com"),
		]).toStrictEqual([
			[
				{
					path: "/api/auth/sign-up/email",
					body:
					{
						email: "bob@example.com",
						password: "correct horse",
						name: "bob",
						callbackURL: "/",
					},
					captcha: "token-for-site-key",
				},
			],
			"/verify-email",
			true,
		]);
	});

	it("says signups are closed on a signup-closed 403", async () =>
	{
		replies["/api/auth/sign-up/email"] = Response.json(
			{
				error: "signup-closed",
			},
			{
				status: 403,
			},
		);
		await open("/signup");

		await type("email", "bob@example.com");
		await type("password", "correct horse");
		await submit();

		expect(document.querySelector("[role=alert]")?.textContent).toBe("OutlineDB isn't open for signups yet.");
	});
});

describe("reset password", () =>
{
	it("requests a reset link with the Turnstile token", async () =>
	{
		await open("/reset-password");

		await type("email", "carol@example.com");
		await submit();

		expect(calls).toStrictEqual([
			{
				path: "/api/auth/request-password-reset",
				body:
				{
					email: "carol@example.com",
					redirectTo: "/reset-password",
				},
				captcha: "token-for-site-key",
			},
		]);
	});

	it("sets the new password with the token from the link", async () =>
	{
		await open("/reset-password?token=tok-1");

		await type("password", "new password!");
		await submit();

		expect(calls).toStrictEqual([
			{
				path: "/api/auth/reset-password",
				body:
				{
					newPassword: "new password!",
					token: "tok-1",
				},
				captcha: null,
			},
		]);
	});
});

describe("Node host", () =>
{
	it("never shows login when auth-config says hosted: false", async () =>
	{
		config =
		{
			hosted: false,
		};
		await open("/login");

		expect([replaced, document.querySelector("form")]).toStrictEqual([["/"], null]);
	});
});
