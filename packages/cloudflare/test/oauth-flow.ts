import type {Miniflare} from "miniflare";

export const origin = "http://localhost";
export const callback = "https://claude.ai/api/mcp/auth_callback";

const mcpHeaders = {
	"content-type": "application/json",
	accept: "application/json, text/event-stream",
	"mcp-protocol-version": "2025-06-18",
};

function base64url(bytes: Uint8Array): string {
	return btoa(String.fromCodePoint(...bytes))
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replace(/=+$/u, "");
}

function stringField(value: unknown, key: string): string | undefined {
	if (typeof value !== "object" || value === null) {
		return undefined;
	}
	const field: unknown = Reflect.get(value, key);
	return typeof field === "string" ? field : undefined;
}

async function readBody(response: {text(): Promise<string>}): Promise<unknown> {
	const body: unknown = JSON.parse(await response.text());
	return body;
}

/** Register a public client the way claude.ai does when the server offers dynamic registration. */
async function registerClient(mf: Miniflare): Promise<string> {
	const response = await mf.dispatchFetch(`${origin}/oauth/register`, {
		method: "POST",
		headers: {"content-type": "application/json"},
		body: JSON.stringify({
			client_name: "Claude",
			redirect_uris: [callback],
			token_endpoint_auth_method: "none",
			grant_types: ["authorization_code", "refresh_token"],
			response_types: ["code"],
		}),
	});
	if (response.status !== 201) {
		throw new Error(`register: ${response.status} ${await response.text()}`);
	}
	return stringField(await readBody(response), "client_id") ?? "";
}

export interface ConsentPage {
	status: number;
	html: string;
	handle: string;
	cookie: string;
	verifier: string;
	clientId: string;
}

/** Start an authorization with PKCE and return the consent page with its form handle and binding cookie. */
export async function openConsent(mf: Miniflare, scope = "mcp:read mcp:write offline_access"): Promise<ConsentPage> {
	const clientId = await registerClient(mf);
	const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
	const challenge = base64url(
		new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))),
	);
	const query = new URLSearchParams({
		response_type: "code",
		client_id: clientId,
		redirect_uri: callback,
		scope,
		state: "state-1",
		code_challenge: challenge,
		code_challenge_method: "S256",
		resource: `${origin}/mcp`,
	});
	const response = await mf.dispatchFetch(`${origin}/authorize?${query}`);
	const html = await response.text();
	const handle = /name="handle" value="([^"]+)"/u.exec(html)?.[1] ?? "";
	const cookie = (response.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
	return {status: response.status, html, handle, cookie, verifier, clientId};
}

/** Approve the consent page with `access` and return the redirect back to the client. */
export async function approve(mf: Miniflare, page: ConsentPage, access: "read" | "write"): Promise<URL> {
	const response = await mf.dispatchFetch(`${origin}/authorize`, {
		method: "POST",
		redirect: "manual",
		headers: {"content-type": "application/x-www-form-urlencoded", cookie: page.cookie},
		body: new URLSearchParams({handle: page.handle, access, decision: "approve"}).toString(),
	});
	if (response.status !== 302) {
		throw new Error(`approve: ${response.status} ${await response.text()}`);
	}
	return new URL(response.headers.get("location") ?? "");
}

export interface TokenResponse {
	access_token: string;
	refresh_token: string | undefined;
	scope: string | undefined;
}

/** Exchange the redirect's code for tokens with the PKCE verifier. */
export async function exchange(mf: Miniflare, page: ConsentPage, redirect: URL): Promise<TokenResponse> {
	const response = await mf.dispatchFetch(`${origin}/oauth/token`, {
		method: "POST",
		headers: {"content-type": "application/x-www-form-urlencoded"},
		body: new URLSearchParams({
			grant_type: "authorization_code",
			code: redirect.searchParams.get("code") ?? "",
			redirect_uri: callback,
			client_id: page.clientId,
			code_verifier: page.verifier,
			resource: `${origin}/mcp`,
		}).toString(),
	});
	if (response.status !== 200) {
		throw new Error(`token: ${response.status} ${await response.text()}`);
	}
	const body = await readBody(response);
	return {
		access_token: stringField(body, "access_token") ?? "",
		refresh_token: stringField(body, "refresh_token"),
		scope: stringField(body, "scope"),
	};
}

/** The whole browser flow: register, consent with `access`, and exchange the code for an access token. */
export async function accessToken(mf: Miniflare, access: "read" | "write"): Promise<TokenResponse> {
	const page = await openConsent(mf);
	return exchange(mf, page, await approve(mf, page, access));
}

/** One JSON-RPC request to /mcp with a bearer token. */
export async function mcpRpc(
	mf: Miniflare,
	token: string | undefined,
	id: number,
	method: string,
	params: Record<string, unknown>,
): Promise<{status: number; type: string | null; encoding: string | null; body: string}> {
	const response = await mf.dispatchFetch(`${origin}/mcp`, {
		method: "POST",
		headers: {
			...mcpHeaders,
			"accept-encoding": "gzip",
			...(token === undefined ? {} : {authorization: `Bearer ${token}`}),
		},
		body: JSON.stringify({jsonrpc: "2.0", id, method, params}),
	});
	return {
		status: response.status,
		type: response.headers.get("content-type"),
		encoding: response.headers.get("content-encoding"),
		body: await response.text(),
	};
}
