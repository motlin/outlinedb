import {z} from "zod";
import {InternalApiError} from "../internal/errors.js";

/**
 * Workflowy internal API client for session-based authentication.
 *
 * This client is used to access internal Workflowy endpoints that are not
 * available through the official Bearer token API: the user's
 * `dateJoinedTimestampInSeconds` (for converting backup file timestamps to Unix
 * timestamps) and the session bootstrap a `/push_and_poll` write path needs.
 *
 * Authentication flow:
 * - Reuse the session cookie from the session store when one is saved
 * - Otherwise (or when the server rejects it) POST to /ajax_login with
 *   username/password once and save the new cookie back to the store
 */

const WORKFLOWY_URL = "https://workflowy.com";

/**
 * The subset of `/get_initialization_data` this client reads. Every other field
 * passes through untouched so upstream additions never break parsing.
 */
const TransactionIdSchema = z.union([z.string(), z.number()]).transform((value) => String(value));
const ClientVersionSchema = TransactionIdSchema;

const VisibleFeatureSchema = z
	.object({
		codename: z.string(),
		name: z.string(),
		label: z.string().nullish(),
		description: z.string().nullish(),
	})
	.loose();

/** One row of the server's visible feature list (Settings > Features). */
export interface VisibleFeature {
	codename: string;
	name: string;
	/** `"LABS"`, `"DEV"` or null. */
	label: string | null;
	description: string | null;
}

const InitializationDataSchema = z
	.object({
		projectTreeData: z
			.object({
				mainProjectTreeInfo: z
					.object({
						dateJoinedTimestampInSeconds: z.number(),
						initialMostRecentOperationTransactionId: TransactionIdSchema.optional(),
						serverExpandedProjectsList: z.array(z.string()).optional(),
						ownerId: z.number().nullable().optional(),
						isReadOnly: z.boolean().nullable().optional(),
					})
					.loose(),
				rootProjectMetadata: z.record(z.string(), z.unknown()).optional(),
			})
			.loose(),
		settings: z.record(z.string(), z.unknown()).optional(),
		user: z
			.object({id: z.number(), fullName: z.string().nullish(), avatarUrl: z.string().nullish()})
			.loose()
			.optional(),
		globals: z.array(z.tuple([z.string(), z.unknown()])).optional(),
		features: z.array(VisibleFeatureSchema).optional(),
	})
	.loose();

/** `/get_user_data/`: where the live server keeps the user, settings, globals and root metadata. */
const UserDataSchema = z
	.object({
		user: z.object({id: z.number(), fullName: z.string().nullish(), avatarUrl: z.string().nullish()}).loose(),
		settings: z.record(z.string(), z.unknown()).optional(),
		globals: z.array(z.tuple([z.string(), z.unknown()])).optional(),
		rootProjectMetadata: z.record(z.string(), z.unknown()).optional(),
		features: z.array(VisibleFeatureSchema).optional(),
	})
	.loose();

const TreeItemSchema = z
	.object({
		id: z.string(),
		metadata: z.record(z.string(), z.unknown()).optional(),
	})
	.loose();

const TreeSnapshotSchema = z
	.object({
		items: z.array(TreeItemSchema),
		most_recent_operation_transaction_id: TransactionIdSchema,
		server_expanded_projects_list: z.array(z.string()).optional(),
	})
	.loose();

/** One `/get_tree_data/` item, reduced to what the cache imports. */
export interface InternalTreeItem {
	id: string;
	metadata?: Record<string, unknown>;
}

/** One whole-tree `/get_tree_data/` read: its items, the transaction id they are current to, and the expanded keys. */
export interface TreeSnapshot {
	items: InternalTreeItem[];
	txId: string;
	expandedKeys: string[];
}

const SignedFileSchema = z.object({url: z.string().min(1)}).loose();

const LoggedOutSchema = z.object({logged_out: z.literal(true)}).loose();

/**
 * Schema for the login response.
 */
const LoginResponseSchema = z.object({
	success: z.boolean().optional(),
	errors: z.record(z.string(), z.array(z.string())).optional(),
});

export interface WorkflowyCredentials {
	username: string;
	password: string;
}

/** Both `WORKFLOWY_USERNAME` and `WORKFLOWY_PASSWORD` from the environment, or undefined if either is unset. */
export function readWorkflowyCredentials(env: NodeJS.ProcessEnv = process.env): WorkflowyCredentials | undefined {
	const username = env.WORKFLOWY_USERNAME;
	const password = env.WORKFLOWY_PASSWORD;
	return username && password ? {username, password} : undefined;
}

/** Where a Workflowy `sessionid=...` cookie persists between processes. */
export interface SessionCookieStore {
	read(): string | undefined;
	write(cookie: string): void;
	clear(): void;
}

/** How the internal client authenticates: a saved cookie, a password login, or both. */
export interface InternalAuth {
	credentials?: WorkflowyCredentials;
	sessionStore: SessionCookieStore;
}

export const MISSING_AUTH_MESSAGE =
	"Workflowy session cookie is missing or expired and WORKFLOWY_USERNAME/WORKFLOWY_PASSWORD are not set; set them in the environment (e.g. from .envrc), or run './bin/run.js internal login' with them set";

export interface WorkflowyInternalClientOptions {
	/** Password login; optional when `sessionStore` holds a valid cookie. */
	credentials?: WorkflowyCredentials;
	/** Reads the cookie to start from and saves each fresh login's cookie. */
	sessionStore?: SessionCookieStore;
	/** Defaults to the global `fetch`. */
	fetch?: typeof fetch;
	/** Defaults to `https://workflowy.com`. */
	baseUrl?: string;
	/** The `WF-TRANSIENT-ID` header value; defaults to a random UUID per client instance. */
	transientId?: string;
}

/** Everything a write path needs from `/get_initialization_data`, parsed once per bootstrap. */
export interface InternalSession {
	/** The `wfclientid` response header, sent back as `client_id` on `/push_and_poll`. */
	clientId: string;
	/** The `CLIENT_VERSION` global, sent back as `client_version`. */
	clientVersion: string;
	userId: number;
	ownerId: number;
	dateJoinedSec: number;
	/** The main tree's most recent operation transaction id: an integer string, `"None"` meaning -1. */
	txId: string;
	/** Root (Home) metadata: stars, tag colors, date formats. */
	rootMetadata: Record<string, unknown>;
	settings: Record<string, unknown>;
	/** The server's visible feature list, in server order. */
	visibleFeatures: VisibleFeature[];
	/** Short ids of the nodes the server records as expanded. */
	expandedKeys: string[];
	/** The per-account salt upstream's `WF.Id.uuidv5` prefixes to every deterministic id; absent when the server sends none. */
	entropyKey?: string;
	/** The account's display name, which upstream shows in a self-mention pill; absent when the server sends none. */
	fullName?: string;
}

/** The `client_version` sent before the server has told us its `CLIENT_VERSION`. */
const DEFAULT_CLIENT_VERSION = "21";
const CLIENT_VERSION_V2 = "28";

function initializationPath(clientVersion: string): string {
	const query = new URLSearchParams({
		client_version: clientVersion,
		client_version_v2: CLIENT_VERSION_V2,
		no_root_children: "1",
	});
	return `/get_initialization_data?${query.toString()}`;
}

/** The server refused the session cookie (a redirect to the login page, or a `logged_out` body). */
export class SessionRejectedError extends Error {
	constructor(readonly reason: string) {
		super(`Workflowy session rejected (${reason})`);
	}
}

/**
 * Client for Workflowy's internal API (session-based authentication).
 */
export class WorkflowyInternalClient {
	private sessionCookie: string | null;
	private readonly credentials: WorkflowyCredentials | undefined;
	private readonly sessionStore: SessionCookieStore | undefined;
	private readonly fetchImpl: typeof fetch;
	private readonly baseUrl: string;
	private readonly transientId: string;
	private currentSession: InternalSession | undefined;

	constructor(options: WorkflowyInternalClientOptions) {
		this.credentials = options.credentials;
		this.sessionStore = options.sessionStore;
		this.sessionCookie = options.sessionStore?.read() ?? null;
		this.fetchImpl = options.fetch ?? (async (input, init) => fetch(input, init));
		this.baseUrl = options.baseUrl ?? WORKFLOWY_URL;
		this.transientId = options.transientId ?? crypto.randomUUID();
	}

	/** The session parsed by the most recent `bootstrap()`, if any. */
	get session(): InternalSession | undefined {
		return this.currentSession;
	}

	/**
	 * Authenticate with Workflowy using username/password.
	 * Stores the session cookie for subsequent requests and in the session store.
	 */
	async login(): Promise<void> {
		if (!this.credentials) {
			throw new Error(MISSING_AUTH_MESSAGE);
		}
		const url = `${this.baseUrl}/ajax_login`;

		const formData = new URLSearchParams();
		formData.append("username", this.credentials.username);
		formData.append("password", this.credentials.password);

		this.sessionCookie = null;
		const response = await this.fetchImpl(url, {
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
			},
			body: formData.toString(),
			redirect: "manual",
		});

		// Extract session cookie from Set-Cookie header
		const setCookie = response.headers.get("set-cookie");
		if (setCookie) {
			// Parse the session cookie (sessionid=...)
			const sessionMatch = setCookie.match(/sessionid=([^;]+)/u);
			if (sessionMatch) {
				this.sessionCookie = `sessionid=${sessionMatch[1]}`;
			}
		}

		// Check response for errors
		if (response.ok || response.status === 302) {
			const text = await response.text();
			if (text) {
				try {
					const data: unknown = JSON.parse(text);
					const parsed = LoginResponseSchema.safeParse(data);
					if (parsed.success && parsed.data.errors) {
						const errorMessages = Object.values(parsed.data.errors).flat().join(", ");
						throw new Error(`Login failed: ${errorMessages}`);
					}
				} catch {
					// Response might not be JSON on success redirect
				}
			}
		}

		if (!this.sessionCookie) {
			throw new Error("Login failed: No session cookie received");
		}
		this.sessionStore?.write(this.sessionCookie);
	}

	/**
	 * Run `request` with a session: log in first only when no cookie is held,
	 * and on a rejected session (302 to login, or `logged_out`) log in exactly
	 * once and retry. A second rejection right after a fresh login propagates.
	 */
	private async withSession<T>(request: () => Promise<T>): Promise<T> {
		if (!this.sessionCookie) {
			await this.login();
		}
		try {
			return await request();
		} catch (error) {
			if (!(error instanceof SessionRejectedError)) {
				throw error;
			}
			await this.login();
			return request();
		}
	}

	/**
	 * Fetch initialization data (logging in per {@link withSession}). Throws
	 * `InternalApiError` when init omits the transaction id; it never falls back
	 * to a whole-tree `/get_tree_data/` download.
	 */
	async bootstrap(): Promise<InternalSession> {
		const session = await this.withSession(async () => this.fetchSession());
		this.currentSession = session;
		return session;
	}

	private async fetchSession(): Promise<InternalSession> {
		const clientVersion = this.currentSession?.clientVersion ?? DEFAULT_CLIENT_VERSION;
		const {response, body} = await this.getJson(initializationPath(clientVersion));
		const init = InitializationDataSchema.parse(body);
		const tree = init.projectTreeData.mainProjectTreeInfo;

		const txId = tree.initialMostRecentOperationTransactionId;
		if (txId === undefined) {
			throw new InternalApiError(
				"get_initialization_data omitted projectTreeData.mainProjectTreeInfo.initialMostRecentOperationTransactionId",
			);
		}

		// The live server sends only tree info in init; the rest comes from /get_user_data/.
		const account =
			init.user === undefined
				? UserDataSchema.parse((await this.getJson("/get_user_data/")).body)
				: {
						user: init.user,
						settings: init.settings,
						globals: init.globals,
						features: init.features,
						rootProjectMetadata: init.projectTreeData.rootProjectMetadata,
					};
		const userId = account.user.id;
		const entropyKey = z.string().min(1).safeParse(account.user.entropyKey);
		const fullName = z.string().min(1).safeParse(account.user.fullName);
		// CLIENT_VERSION is a page global (`var CLIENT_VERSION = 21;` in the HTML), absent from both JSON globals lists live.
		const globalVersion = ClientVersionSchema.safeParse(
			account.globals?.find(([name]) => name === "CLIENT_VERSION")?.[1],
		);

		return {
			clientId: response.headers.get("wfclientid") ?? "",
			clientVersion: globalVersion.success ? globalVersion.data : clientVersion,
			userId,
			ownerId: tree.ownerId ?? userId,
			dateJoinedSec: tree.dateJoinedTimestampInSeconds,
			txId,
			rootMetadata: account.rootProjectMetadata ?? {},
			settings: account.settings ?? {},
			visibleFeatures: (account.features ?? []).map(({codename, name, label, description}) => ({
				codename,
				name,
				label: label ?? null,
				description: description ?? null,
			})),
			expandedKeys: tree.serverExpandedProjectsList ?? [],
			...(entropyKey.success ? {entropyKey: entropyKey.data} : {}),
			...(fullName.success ? {fullName: fullName.data} : {}),
		};
	}

	/**
	 * The whole main tree from one `/get_tree_data/` (about 54 MB live): every
	 * item's id and, when it has any, its metadata, plus the transaction id and
	 * expanded keys of that same read. Only batch imports and the explicit
	 * Cloudflare seed call it (guarded by `tree-download-guard.test.ts`).
	 */
	async getTreeSnapshot(): Promise<TreeSnapshot> {
		const {body} = await this.withSession(async () => this.getJson("/get_tree_data/"));
		const snapshot = TreeSnapshotSchema.parse(body);
		return {
			items: snapshot.items.map(({id, metadata}) => (metadata === undefined ? {id} : {id, metadata})),
			txId: snapshot.most_recent_operation_transaction_id,
			expandedKeys: snapshot.server_expanded_projects_list ?? [],
		};
	}

	/**
	 * The short-lived signed S3 URL behind one of workflowy.com's `/file-proxy/signed-preview|signed-original/...` paths
	 * (logging in per {@link withSession}).
	 */
	async signedFileUrl(path: string): Promise<string> {
		const {body} = await this.withSession(async () => this.getJson(path));
		return SignedFileSchema.parse(body).url;
	}

	/** An authenticated GET; throws `SessionRejectedError` on a login redirect or `logged_out` body. */
	private async getJson(pathAndQuery: string): Promise<{response: Response; body: unknown}> {
		if (!this.sessionCookie) {
			throw new Error("Not authenticated. Call login() first.");
		}
		const response = await this.fetchImpl(`${this.baseUrl}${pathAndQuery}`, {
			headers: {
				Cookie: this.sessionCookie,
				Accept: "application/json",
				"X-Requested-With": "XMLHttpRequest",
				"WF-TRANSIENT-ID": this.transientId,
			},
			redirect: "manual",
		});
		if (response.status >= 300 && response.status < 400) {
			throw new SessionRejectedError(`redirect to ${response.headers.get("location") ?? "unknown"}`);
		}
		if (!response.ok) {
			throw new Error(`Failed to GET ${pathAndQuery}: ${response.status} ${response.statusText}`);
		}
		const body: unknown = await response.json();
		if (LoggedOutSchema.safeParse(body).success) {
			throw new SessionRejectedError("logged_out");
		}
		return {response, body};
	}

	/**
	 * An authenticated form POST, returning the raw response (redirects are not
	 * followed). Like upstream's HTTP layer, it appends `crosscheck_user_id` once
	 * a bootstrap has learned the user id.
	 */
	async postForm(pathAndQuery: string, form: URLSearchParams): Promise<Response> {
		if (!this.sessionCookie) {
			throw new Error("Not authenticated. Call login() first.");
		}
		const body = new URLSearchParams(form);
		if (this.currentSession) {
			body.append("crosscheck_user_id", String(this.currentSession.userId));
		}
		return this.fetchImpl(`${this.baseUrl}${pathAndQuery}`, {
			method: "POST",
			headers: {
				Cookie: this.sessionCookie,
				Accept: "application/json",
				"Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
				"X-Requested-With": "XMLHttpRequest",
				"WF-TRANSIENT-ID": this.transientId,
			},
			body: body.toString(),
			redirect: "manual",
		});
	}
}
