import {redirectToLogin} from "./auth/login-redirect.js";

/**
 * Read a response body typed as the shape the API route promises.
 *
 * Like Hono's `c.req.json<T>()`, the type parameter is a contract with our own
 * server, not a runtime check. Parse with zod instead when the body comes from
 * somewhere we do not control. A 401 (signed out) sends the user to login.
 */
export async function readJson<T>(response: Response): Promise<T> {
	if (response.status === 401) {
		redirectToLogin();
	}
	// oxlint-disable-next-line typescript/no-unsafe-assignment -- T is a compile-time contract with our own API route, as documented above
	const body: T = await response.json();
	return body;
}
