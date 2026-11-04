import {AuthorizationError, CimdFetchError, OAuthProvider, insufficientScope} from "@cloudflare/workers-oauth-provider";
import type {ConsentDescription, OAuthHelpers, OAuthResourceContext} from "@cloudflare/workers-oauth-provider";
import {isAllowedEmail, resolveIdentity} from "./access";
import type {AccessEnv} from "./access";
import {mcpHandler} from "./mcp";

const READ_SCOPE = "mcp:read";
const WRITE_SCOPE = "mcp:write";
const OFFLINE_SCOPE = "offline_access";

/** What a grant stores: the Access email whose Durable Object the token reads and writes. */
interface McpProps {
	email: string;
}

type OAuthEnv = Env & AccessEnv;

const escapeHtml = (value: string): string => value.replaceAll(/[&<>"']/gu, (char) => `&#${char.codePointAt(0)};`);

function consentPage(details: ConsentDescription, handle: string, email: string): string {
	const name = escapeHtml(details.clientName);
	const origin = details.clientDomain
		? `Published by <strong>${escapeHtml(details.clientDomain)}</strong>.`
		: "This app registered itself; its name is not verified.";
	const loopback = details.redirectIsLoopback
		? "<p><strong>This sends access to an app on your computer.</strong> Continue only if you just started signing in from it.</p>"
		: "";
	const write = details.scope.includes(WRITE_SCOPE) || !details.scope.includes(READ_SCOPE);
	return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Authorize ${name}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem}label{display:block;margin:.5rem 0}</style>
<h1>Allow ${name} to access your Workflowy outline?</h1>
<p>${origin} Access will be sent to <strong>${escapeHtml(details.redirectHost)}</strong>, acting as ${escapeHtml(email)}.</p>
${loopback}
<form method="post">
<input type="hidden" name="handle" value="${escapeHtml(handle)}">
<label><input type="radio" name="access" value="read"${write ? "" : " checked"}> Read only: search and read nodes</label>
<label><input type="radio" name="access" value="write"${write ? " checked" : ""}> Read and write: also create, edit, move and delete nodes</label>
<p><button name="decision" value="approve">Allow</button> <button name="decision" value="deny">Deny</button></p>
</form>`;
}

/** The scopes a consent form grants: read-only, or read and write. */
function grantedScopes(form: FormData): string[] {
	return form.get("access") === "write" ? [READ_SCOPE, WRITE_SCOPE] : [READ_SCOPE];
}

function textResponse(message: string, status: number): Response {
	return new Response(message, {status, headers: {"content-type": "text/plain; charset=utf-8"}});
}

async function authorizeSteps(request: Request, oauth: OAuthHelpers, email: string): Promise<Response> {
	if (request.method === "GET") {
		const authRequest = await oauth.parseAuthRequest(request);
		const details = await oauth.describeConsent(authRequest);
		const consent = await oauth.beginConsent(authRequest);
		consent.headers.set("content-type", "text/html; charset=utf-8");
		return new Response(consentPage(details, consent.handle, email), {headers: consent.headers});
	}
	if (request.method !== "POST") {
		return textResponse("Method not allowed", 405);
	}
	const form = await request.formData();
	const handle = form.get("handle");
	if (typeof handle !== "string") {
		return textResponse("Missing consent handle", 400);
	}
	if (form.get("decision") !== "approve") {
		const denied = await oauth.denyConsent(request, handle);
		return new Response(null, {status: 302, headers: denied.headers});
	}
	const approved = await oauth.approveConsent(request, handle, {scope: grantedScopes(form)});
	const {redirectTo} = await oauth.completeAuthorization({
		request: approved.request,
		userId: email,
		metadata: {},
		scope: approved.request.scope,
		props: {email} satisfies McpProps,
	});
	approved.headers.set("location", redirectTo);
	return new Response(null, {status: 302, headers: approved.headers});
}

/**
 * The consent page at `/authorize`. It sits behind Access like the rest of the app, so the browser that starts the
 * connection has already signed in; the grant acts as that Access email.
 */
export async function authorize(request: Request, env: OAuthEnv & {OAUTH_PROVIDER: OAuthHelpers}): Promise<Response> {
	const identity = await resolveIdentity(request, env);
	if ("status" in identity) {
		return textResponse(identity.status === 401 ? "Unauthorized" : "Forbidden", identity.status);
	}
	try {
		return await authorizeSteps(request, env.OAUTH_PROVIDER, identity.email);
	} catch (error) {
		if (error instanceof AuthorizationError && error.redirectTo) {
			return Response.redirect(error.redirectTo, 302);
		}
		if (error instanceof AuthorizationError) {
			return textResponse(error.description, 400);
		}
		if (error instanceof CimdFetchError) {
			return textResponse("This app could not be verified.", 400);
		}
		throw error;
	}
}

/**
 * `/mcp` behind a bearer token. The email is re-checked against the allowlist on every request, so removing it
 * cuts off live tokens; a token without `mcp:write` gets the read tools only.
 */
const mcpApiHandler = {
	async fetch(request: Request, env: OAuthEnv, ctx: OAuthResourceContext<McpProps>): Promise<Response> {
		const {email} = ctx.props;
		if (!isAllowedEmail(email, env)) {
			return textResponse("Forbidden", 403);
		}
		if (!ctx.auth.scope.includes(READ_SCOPE)) {
			return insufficientScope(ctx.auth, [READ_SCOPE]);
		}
		return mcpHandler(request, email, env, {readOnly: !ctx.auth.scope.includes(WRITE_SCOPE)});
	},
};

const providers = new Map<string, OAuthProvider<OAuthEnv>>();

/**
 * The OAuth provider for one origin. The resource URL must equal what the user types into the connector, so it is
 * built from the request's origin rather than configured; each origin gets its own provider and its own tokens.
 */
export function oauthProviderFor(origin: string, defaultHandler: ExportedHandler<OAuthEnv>): OAuthProvider<OAuthEnv> {
	let provider = providers.get(origin);
	if (!provider) {
		provider = new OAuthProvider<OAuthEnv>({
			apiRoute: "/mcp",
			// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- OAuthProvider types its handler's ctx as a plain ExecutionContext, though it sets ctx.props and ctx.auth
			apiHandler: mcpApiHandler as unknown as ExportedHandler<OAuthEnv> &
				Pick<Required<ExportedHandler<OAuthEnv>>, "fetch">,
			defaultHandler,
			authorizeEndpoint: "/authorize",
			tokenEndpoint: "/oauth/token",
			clientRegistrationEndpoint: "/oauth/register",
			scopesSupported: [READ_SCOPE, WRITE_SCOPE, OFFLINE_SCOPE],
			requiredScopes: [READ_SCOPE],
			resourceMetadata: {
				resource: `${origin}/mcp`,
				authorization_servers: [origin],
				resource_name: "Workflowy",
			},
			clientIdMetadataDocumentEnabled: true,
		});
		providers.set(origin, provider);
	}
	return provider;
}
