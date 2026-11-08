import {redirectToLogin} from "./auth/login-redirect.js";

/** A failed API request that keeps its HTTP status, so callers can branch on it. */
export class RequestStatusError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
		this.name = "RequestStatusError";
	}
}

/**
 * Builds the error for a failed response, preferring the server's `{error}` message over the status text. A 401 (signed
 * out) also sends the user to login.
 */
export async function toRequestStatusError(prefix: string, response: Response): Promise<RequestStatusError> {
	if (response.status === 401) {
		redirectToLogin();
	}
	let detail = response.statusText;
	try {
		const body: unknown = await response.json();
		if (typeof body === "object" && body !== null && "error" in body && typeof body.error === "string") {
			detail = body.error;
		}
	} catch {
		// Non-JSON body: keep the status text.
	}
	return new RequestStatusError(response.status, `${prefix}: ${detail}`);
}
