import {createAuthClient} from "better-auth/react";

/** Better Auth on this origin (`/api/auth`). Only the Worker serves it; the Node host has no sign-in. */
export const authClient = createAuthClient(
	{
		basePath: "/api/auth",
		// Looked up per call rather than captured at load, so the page's current `fetch` (a test's stub included) is used.
		fetchOptions:
		{
			customFetchImpl: async (input, init) => globalThis.fetch(input, init),
		},
	},
);

/** Passes a Turnstile token the way Better Auth's captcha plugin reads it. */
export function captchaHeaders(token: string):
{
	headers: Record<string, string>;
}
{
	return {
		headers:
		{
			"x-captcha-response": token,
		},
	};
}
