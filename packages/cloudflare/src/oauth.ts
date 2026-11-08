import {AuthorizationError, CimdFetchError, OAuthProvider, insufficientScope} from "@cloudflare/workers-oauth-provider";
import type {ConsentDescription, OAuthHelpers, OAuthResourceContext} from "@cloudflare/workers-oauth-provider";
import type {AccessEnv} from "./access";
import type {ProvisionEnv} from "./auth/provision";
import {mcpHandler} from "./mcp";
import {resolvePrincipal} from "./principal";
import type {SessionReader} from "./principal";

const READ_SCOPE = "mcp:read";
const WRITE_SCOPE = "mcp:write";
const OFFLINE_SCOPE = "offline_access";

/** What a grant stores: the OutlineDB user whose Durable Object the token reads and writes. */
interface McpProps {
	userId: string;
}

type OAuthEnv = Env & AccessEnv & ProvisionEnv;

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
<h1>Allow ${name} to access your OutlineDB outline?</h1>
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

async function authorizeSteps(
	request: Request,
	oauth: OAuthHelpers,
	user: {userId: string; email: string},
): Promise<Response> {
	if (request.method === "GET") {
		const authRequest = await oauth.parseAuthRequest(request);
		const details = await oauth.describeConsent(authRequest);
		const consent = await oauth.beginConsent(authRequest);
		consent.headers.set("content-type", "text/html; charset=utf-8");
		return new Response(consentPage(details, consent.handle, user.email), {headers: consent.headers});
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
		userId: user.userId,
		metadata: {},
		scope: approved.request.scope,
		props: {userId: user.userId} satisfies McpProps,
	});
	approved.headers.set("location", redirectTo);
	return new Response(null, {status: 302, headers: approved.headers});
}

/** `/login`, coming back to this `/authorize` request (path and query) once signed in. */
function loginRedirect(request: Request): Response {
	const url = new URL(request.url);
	const next = encodeURIComponent(`${url.pathname}${url.search}`);
	return new Response(null, {status: 302, headers: {location: `/login?next=${next}`}});
}

/**
 * The consent page at `/authorize`, for the signed-in OutlineDB user: a Better Auth session, or an Access identity
 * whose email has a verified user. With no sign-in it sends the browser to `/login` and back; the grant acts as that
 * user.
 */
export async function authorize(
	request: Request,
	env: OAuthEnv & {OAUTH_PROVIDER: OAuthHelpers},
	auth: () => SessionReader | undefined,
): Promise<Response> {
	const principal = await resolvePrincipal(request, {...env, ACCESS_DEV_IDENTITY: undefined}, auth);
	if ("status" in principal) {
		return principal.status === 401 ? loginRedirect(request) : textResponse("Forbidden", 403);
	}
	if (principal.userId === null) {
		return textResponse(`Sign up for OutlineDB as ${principal.email} before connecting an app.`, 403);
	}
	try {
		return await authorizeSteps(request, env.OAUTH_PROVIDER, {userId: principal.userId, email: principal.email});
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

/** Whether `userId` is still a verified D1 user. */
async function isVerifiedUser(env: Pick<ProvisionEnv, "AUTH_DB">, userId: string): Promise<boolean> {
	const row = await env.AUTH_DB.prepare('SELECT 1 AS ok FROM "user" WHERE id = ? AND emailVerified = 1')
		.bind(userId)
		.first<{ok: number}>();
	return row !== null;
}

/**
 * `/mcp` behind a bearer token. The user is re-checked in D1 on every request, so deleting or unverifying them cuts
 * off live tokens; a token without `mcp:write` gets the read tools only.
 */
const mcpApiHandler = {
	async fetch(request: Request, env: OAuthEnv, ctx: OAuthResourceContext<McpProps>): Promise<Response> {
		const {userId} = ctx.props;
		if (typeof userId !== "string" || !(await isVerifiedUser(env, userId))) {
			return textResponse("Forbidden", 403);
		}
		if (!ctx.auth.scope.includes(READ_SCOPE)) {
			return insufficientScope(ctx.auth, [READ_SCOPE]);
		}
		return mcpHandler(request, userId, env, {readOnly: !ctx.auth.scope.includes(WRITE_SCOPE)});
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
				resource_name: "OutlineDB",
			},
			clientIdMetadataDocumentEnabled: true,
		});
		providers.set(origin, provider);
	}
	return provider;
}
