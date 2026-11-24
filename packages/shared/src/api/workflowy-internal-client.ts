import {z} from "zod";
import {InternalApiError, LOGIN_HINT} from "../internal/errors.js";
import {readTreeDataBody} from "./tree-data-stream.js";

/**
 * Workflowy internal API client for session-based authentication.
 *
 * This client is used to access internal Workflowy endpoints that are not
 * available through the official Bearer token API: the user's
 * `dateJoinedTimestampInSeconds` (for converting backup file timestamps to Unix
 * timestamps) and the session bootstrap a `/push_and_poll` write path needs.
 *
 * Authentication: the session cookie the session store holds, which `./bin/run.js internal login` (or the Worker's
 * Connect) saves after a person logs in through workflowy.com's `/login/` form. Nothing here logs in: a missing or
 * refused cookie fails and the person logs in again.
 */

export const WORKFLOWY_URL = "https://workflowy.com";

/**
 * The subset of `/get_initialization_data` this client reads. Every other field
 * passes through untouched so upstream additions never break parsing.
 */
const TransactionIdSchema = z.union([z.string(), z.number()]).transform((value) => String(value));
const ClientVersionSchema = TransactionIdSchema;

const VisibleFeatureSchema = z
	.object(
		{
			codename: z.string(),
			name: z.string(),
			label: z.string().nullish(),
			description: z.string().nullish(),
		},
	)
	.loose();

/** One row of the server's visible feature list (Settings > Features). */
export interface VisibleFeature
{
	codename: string;
	name: string;
	/** `"LABS"`, `"DEV"` or null. */
	label: string | null;
	description: string | null;
}

const InitializationDataSchema = z
	.object(
		{
			projectTreeData: z
				.object(
					{
						mainProjectTreeInfo: z
							.object(
								{
									dateJoinedTimestampInSeconds: z.number(),
									initialMostRecentOperationTransactionId: TransactionIdSchema.optional(),
									serverExpandedProjectsList: z.array(z.string()).optional(),
									ownerId: z.number().nullable().optional(),
									isReadOnly: z.boolean().nullable().optional(),
								},
							)
							.loose(),
						rootProjectMetadata: z.record(z.string(), z.unknown()).optional(),
					},
				)
				.loose(),
			settings: z.record(z.string(), z.unknown()).optional(),
			user: z
				.object(
					{
						id: z.number(),
						fullName: z.string().nullish(),
						avatarUrl: z.string().nullish(),
					},
				)
				.loose()
				.optional(),
			globals: z.array(z.tuple([z.string(), z.unknown()])).optional(),
			features: z.array(VisibleFeatureSchema).optional(),
		},
	)
	.loose();

/** `/get_user_data/`: where the live server keeps the user, settings, globals and root metadata. */
const UserDataSchema = z
	.object(
		{
			user: z
				.object(
					{
						id: z.number(),
						fullName: z.string().nullish(),
						avatarUrl: z.string().nullish(),
					},
				)
				.loose(),
			settings: z.record(z.string(), z.unknown()).optional(),
			globals: z.array(z.tuple([z.string(), z.unknown()])).optional(),
			rootProjectMetadata: z.record(z.string(), z.unknown()).optional(),
			features: z.array(VisibleFeatureSchema).optional(),
		},
	)
	.loose();

const TreeItemSchema = z
	.object(
		{
			id: z.string(),
			metadata: z.record(z.string(), z.unknown()).optional(),
		},
	)
	.loose();

const ExpandedKeysSchema = z.array(z.string()).optional();

/** One `/get_tree_data/` item, reduced to what the cache imports. */
export interface InternalTreeItem
{
	id: string;
	metadata?: Record<string, unknown>;
}

/**
 * One `/get_tree_data/` item with its node fields, for an import that builds the tree from it. Timestamps (`ct`, `lm`,
 * `cp`) are seconds since the account's join date; `prnt` is the parent's id (null at the top) and `pr` orders siblings.
 * A field upstream sent with the wrong type is left out.
 */
export interface TreeDataItem extends InternalTreeItem
{
	nm?: string;
	no?: string | null;
	prnt?: string | null;
	pr?: number;
	ct?: number;
	cp?: number | null;
	lm?: number;
}

/** What one whole-tree `/get_tree_data/` read holds besides its items: the transaction id they are current to, and the expanded keys. */
export interface TreeDataTail
{
	txId: string;
	expandedKeys: string[];
}

/** One whole-tree `/get_tree_data/` read: its items, the transaction id they are current to, and the expanded keys. */
export interface TreeSnapshot<Item extends InternalTreeItem = InternalTreeItem> extends TreeDataTail
{
	items: Item[];
}

const SignedFileSchema = z
	.object(
		{
			url: z.string().min(1),
		},
	)
	.loose();

const LoggedOutSchema = z
	.object(
		{
			logged_out: z.literal(true),
		},
	)
	.loose();

/** Where a Workflowy `sessionid=...` cookie persists between processes. */
export interface SessionCookieStore
{
	read(): string | undefined;
	write(cookie: string): void;
	clear(): void;
}

/** How the internal client authenticates: the saved session cookie. */
export interface InternalAuth
{
	sessionStore: SessionCookieStore;
}

/** No session cookie is saved: the person must log in again. */
export class MissingCredentialsError extends Error
{
	constructor()
	{
		super(MISSING_AUTH_MESSAGE);
	}
}

export const MISSING_AUTH_MESSAGE = `No Workflowy session cookie is saved; ${LOGIN_HINT}`;

export interface WorkflowyInternalClientOptions
{
	/** Holds the session cookie every request sends. */
	sessionStore?: SessionCookieStore;
	/** Defaults to the global `fetch`. */
	fetch?: typeof fetch;
	/** Defaults to `https://workflowy.com`. */
	baseUrl?: string;
	/** The `WF-TRANSIENT-ID` header value; defaults to a random UUID per client instance. */
	transientId?: string;
}

/** Everything a write path needs from `/get_initialization_data`, parsed once per bootstrap. */
export interface InternalSession
{
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

/** The init data read every import and bootstrap starts with, which Connect also sends to check a fresh login. */
export function initializationPath(clientVersion = DEFAULT_CLIENT_VERSION): string
{
	const query = new URLSearchParams(
		{
			client_version: clientVersion,
			client_version_v2: CLIENT_VERSION_V2,
			no_root_children: "1",
		},
	);
	return `/get_initialization_data?${query.toString()}`;
}

const LOGIN_DETAIL_MAX = 500;
const REDACTED = "[redacted]";
const SECRET_KEY = /cookie|passw|email|username|session|token|secret|csrf/iu;

/**
 * A login reply for a person to read: the HTTP status and the body (every JSON key kept, so an unexpected field shows),
 * with secret-looking keys and every one of `secrets` (the email, the password, a code) redacted wherever it appears,
 * truncated to {@link LOGIN_DETAIL_MAX} characters. Cookies are never part of it.
 */
export function loginReplyDetail(status: number, body: string, reply: unknown, secrets: readonly string[]): string
{
	const patterns = secrets
		.filter((secret) => secret !== "")
		.map((secret) => new RegExp(secret.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`), "giu"));
	const redact = (text: string): string =>
		patterns.reduce((redacted, secret) => redacted.replace(secret, REDACTED), text);
	const scrub = (value: unknown): unknown =>
	{
		if (typeof value === "string")
		{
			return redact(value);
		}
		if (Array.isArray(value))
		{
			return value.map(scrub);
		}
		if (typeof value === "object" && value !== null)
		{
			return Object.fromEntries(
				Object.entries(value).map(([key, inner]) => [
					redact(key),
					SECRET_KEY.test(key) ? REDACTED : scrub(inner),
				]),
			);
		}
		return value;
	};
	const shown = reply === undefined ? redact(body.replaceAll(/\s+/gu, " ").trim()) : JSON.stringify(scrub(reply));
	const detail = `HTTP ${String(status)}: ${shown === "" ? "(empty body)" : shown}`;
	return detail.length > LOGIN_DETAIL_MAX ? `${detail.slice(0, LOGIN_DETAIL_MAX - 3)}...` : detail;
}

/**
 * Whether a reply is workflowy.com's HTML 404 page, which is how it answers an internal API request without a valid
 * session (not with a login redirect or `logged_out`).
 */
export function isNotFoundPage(response: Response): boolean
{
	return response.status === 404 && (response.headers.get("content-type") ?? "").includes("text/html");
}

/** Whether a parsed JSON reply is workflowy.com's `{"logged_out": true}`. */
export function isLoggedOutReply(body: unknown): boolean
{
	return LoggedOutSchema.safeParse(body).success;
}

/** The server refused the session cookie (a redirect to the login page, its 404 page, or a `logged_out` body). */
export class SessionRejectedError extends Error
{
	constructor(readonly reason: string)
	{
		super(`Workflowy session rejected (${reason}); ${LOGIN_HINT}`);
	}
}

/**
 * Client for Workflowy's internal API (session-based authentication).
 */
export class WorkflowyInternalClient
{
	private readonly sessionCookie: string | null;
	private readonly fetchImpl: typeof fetch;
	private readonly baseUrl: string;
	private readonly transientId: string;
	private currentSession: InternalSession | undefined;

	constructor(options: WorkflowyInternalClientOptions)
	{
		this.sessionCookie = options.sessionStore?.read() ?? null;
		this.fetchImpl = options.fetch ?? (async (input, init) => fetch(input, init));
		this.baseUrl = options.baseUrl ?? WORKFLOWY_URL;
		this.transientId = options.transientId ?? crypto.randomUUID();
	}

	/** The session parsed by the most recent `bootstrap()`, if any. */
	get session(): InternalSession | undefined
	{
		return this.currentSession;
	}

	/**
	 * Run `request` with the saved session; throws {@link MissingCredentialsError} when none is saved. A refused
	 * session throws `SessionRejectedError`: nothing logs in again, since a login may ask a person for a code.
	 */
	private async withSession<T>(request: () => Promise<T>): Promise<T>
	{
		if (!this.sessionCookie)
		{
			throw new MissingCredentialsError();
		}
		return request();
	}

	/**
	 * Fetch initialization data (with the session per {@link withSession}). Throws
	 * `InternalApiError` when init omits the transaction id; it never falls back
	 * to a whole-tree `/get_tree_data/` download.
	 */
	async bootstrap(): Promise<InternalSession>
	{
		const session = await this.withSession(async () => this.fetchSession());
		this.currentSession = session;
		return session;
	}

	private async fetchSession(): Promise<InternalSession>
	{
		const clientVersion = this.currentSession?.clientVersion ?? DEFAULT_CLIENT_VERSION;
		const {response, body} = await this.getJson(initializationPath(clientVersion));
		const init = InitializationDataSchema.parse(body);
		const tree = init.projectTreeData.mainProjectTreeInfo;

		const txId = tree.initialMostRecentOperationTransactionId;
		if (txId === undefined)
		{
			throw new InternalApiError(
				"get_initialization_data omitted projectTreeData.mainProjectTreeInfo.initialMostRecentOperationTransactionId",
			);
		}

		// The live server sends only tree info in init; the rest comes from /get_user_data/.
		const account =
			init.user === undefined
				? UserDataSchema.parse((await this.getJson("/get_user_data/")).body)
				:
					{
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
			visibleFeatures: (account.features ?? []).map(({codename, name, label, description}) => (
			{
				codename,
				name,
				label: label ?? null,
				description: description ?? null,
			})),
			expandedKeys: tree.serverExpandedProjectsList ?? [],
			...(entropyKey.success
				?
					{
						entropyKey: entropyKey.data,
					}
				: {}),
			...(fullName.success
				?
					{
						fullName: fullName.data,
					}
				: {}),
		};
	}

	/**
	 * The whole main tree from one `/get_tree_data/` (about 54 MB live), held in memory: every item's id and, when it
	 * has any, its metadata, plus the transaction id and expanded keys of that same read. With `nodeFields`, each item
	 * also keeps its name, note, parent, priority and timestamps, for an import that builds the tree from this read
	 * alone. Only the CLI's batch imports and manual probe call it; the Worker streams instead (guarded by
	 * `tree-download-guard.test.ts`).
	 */
	async getTreeSnapshot(): Promise<TreeSnapshot>;
	async getTreeSnapshot(options: {nodeFields: true}): Promise<TreeSnapshot<TreeDataItem>>;
	async getTreeSnapshot(options?: {nodeFields: true}): Promise<TreeSnapshot<TreeDataItem>>
	{
		const items: TreeDataItem[] = [];
		const tail = await this.streamTreeData((item) =>
		{
			items.push(
				options?.nodeFields === true
					? item
					:
						{
							id: item.id,
							...(item.metadata === undefined
								? {}
								:
									{
										metadata: item.metadata,
									}),
						},
			);
		});
		return {
			items,
			...tail,
		};
	}

	/**
	 * The whole main tree from one `/get_tree_data/`, read as it arrives (with the session per {@link withSession}): each
	 * item, with its node fields and metadata, goes to `onItem`, which is awaited before the next is read, so the body
	 * is never held whole. Resolves with the read's transaction id and expanded keys once the body ends. `onBytes` hears
	 * each network chunk's size as it arrives, so a download that fails part way still reports what it read.
	 */
	async streamTreeData(
		onItem: (item: TreeDataItem) => void | Promise<void>,
		onBytes?: (byteLength: number) => void,
	): Promise<TreeDataTail>
	{
		return this.withSession(async () =>
		{
			const response = await this.get("/get_tree_data/");
			if (response.body === null)
			{
				throw new InternalApiError("get_tree_data answered with no body");
			}
			const body =
				onBytes === undefined
					? response.body
					: response.body.pipeThrough(
							new TransformStream<Uint8Array, Uint8Array>(
								{
									transform(chunk, controller)
									{
										onBytes(chunk.byteLength);
										controller.enqueue(chunk);
									},
								},
							),
						);
			const rest = await readTreeDataBody(body, async (raw) =>
			{
				const item = TreeItemSchema.parse(raw);
				const kept = treeDataFields(item);
				if (item.metadata !== undefined)
				{
					kept.metadata = item.metadata;
				}
				await onItem(kept);
			});
			if (rest.loggedOut === true)
			{
				throw new SessionRejectedError("logged_out");
			}
			return {
				txId: TransactionIdSchema.parse(rest.txId),
				expandedKeys: ExpandedKeysSchema.parse(rest.expandedKeys) ?? [],
			};
		});
	}

	/**
	 * The short-lived signed S3 URL behind one of workflowy.com's `/file-proxy/signed-preview|signed-original/...` paths
	 * (with the session per {@link withSession}).
	 */
	async signedFileUrl(path: string): Promise<string>
	{
		// A 404 here can mean a file workflowy.com no longer holds, so it is not read as a refused session.
		const {body} = await this.withSession(async () => this.getJson(path, false));
		return SignedFileSchema.parse(body).url;
	}

	/**
	 * An authenticated GET, its body unread; throws `SessionRejectedError` on a login redirect or, unless
	 * `notFoundRefuses` is false, workflowy.com's HTML 404 page.
	 */
	private async get(pathAndQuery: string, notFoundRefuses = true): Promise<Response>
	{
		if (!this.sessionCookie)
		{
			throw new MissingCredentialsError();
		}
		const response = await this.fetchImpl(
			`${this.baseUrl}${pathAndQuery}`,
			{
				headers:
				{
					Cookie: this.sessionCookie,
					Accept: "application/json",
					"X-Requested-With": "XMLHttpRequest",
					"WF-TRANSIENT-ID": this.transientId,
				},
				redirect: "manual",
			},
		);
		if (response.status >= 300 && response.status < 400)
		{
			throw new SessionRejectedError(`redirect to ${response.headers.get("location") ?? "unknown"}`);
		}
		if (notFoundRefuses && isNotFoundPage(response))
		{
			throw new SessionRejectedError("404 page");
		}
		if (!response.ok)
		{
			throw new Error(`Failed to GET ${pathAndQuery}: ${response.status} ${response.statusText}`);
		}
		return response;
	}

	/** An authenticated GET of a JSON reply, as {@link get}; a `logged_out` body also throws `SessionRejectedError`. */
	private async getJson(
		pathAndQuery: string,
		notFoundRefuses = true,
	): Promise<
	{
		response: Response;
		body: unknown;
	}>
	{
		const response = await this.get(pathAndQuery, notFoundRefuses);
		const body: unknown = await response.json();
		if (isLoggedOutReply(body))
		{
			throw new SessionRejectedError("logged_out");
		}
		return {
			response,
			body,
		};
	}

	/**
	 * An authenticated form POST, returning the raw response (redirects are not
	 * followed). Like upstream's HTTP layer, it appends `crosscheck_user_id` once
	 * a bootstrap has learned the user id.
	 */
	async postForm(pathAndQuery: string, form: URLSearchParams): Promise<Response>
	{
		if (!this.sessionCookie)
		{
			throw new MissingCredentialsError();
		}
		const body = new URLSearchParams(form);
		if (this.currentSession)
		{
			body.append("crosscheck_user_id", String(this.currentSession.userId));
		}
		return this.fetchImpl(
			`${this.baseUrl}${pathAndQuery}`,
			{
				method: "POST",
				headers:
				{
					Cookie: this.sessionCookie,
					Accept: "application/json",
					"Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
					"X-Requested-With": "XMLHttpRequest",
					"WF-TRANSIENT-ID": this.transientId,
				},
				body: body.toString(),
				redirect: "manual",
			},
		);
	}
}

const text = (value: unknown): value is string => typeof value === "string";
const count = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** An item's id and the node fields of the type {@link TreeDataItem} expects; a mistyped field is left out. */
function treeDataFields(
	item: Record<string, unknown> &
	{
		id: string;
	},
): TreeDataItem
{
	const kept: TreeDataItem =
	{
		id: item.id,
	};
	const {nm, no, prnt, pr, ct, cp, lm} = item;
	if (text(nm))
	{
		kept.nm = nm;
	}
	if (text(no) || no === null)
	{
		kept.no = no;
	}
	if (text(prnt) || prnt === null)
	{
		kept.prnt = prnt;
	}
	if (count(pr))
	{
		kept.pr = pr;
	}
	if (count(ct))
	{
		kept.ct = ct;
	}
	if (count(cp) || cp === null)
	{
		kept.cp = cp;
	}
	if (count(lm))
	{
		kept.lm = lm;
	}
	return kept;
}
