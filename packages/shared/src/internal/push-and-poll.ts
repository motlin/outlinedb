import {z} from "zod";
import type {InternalSession, WorkflowyInternalClient} from "../api/workflowy-internal-client.js";
import
{
	AccountBusy,
	CaptchaRequired,
	InternalApiError,
	LoggedOut,
	OperationRejected,
	PushLockTimeout,
	TransportError,
} from "./errors.js";

/** One upstream operation envelope: `{type, data, client_timestamp, undo_data, executed_by?}`. */
export interface InternalOp
{
	type: string;
	data: Record<string, unknown>;
	client_timestamp?: number;
	undo_data?: Record<string, unknown>;
	executed_by?: number;
	[key: string]: unknown;
}

export interface PushInput
{
	ops?: InternalOp[];
	/** Expansion changes keyed by the first 8 chars of the node id. */
	expansionsDelta?: Record<string, boolean>;
}

/** One logged transaction: its tree transaction id, when the server sent one, and its ops. */
export interface Transaction
{
	id?: string;
	ops: InternalOp[];
}

export interface PushResult
{
	txId: string;
	/** The transaction id of {@link serverRun}, when the server sent one. */
	serverRunId?: string;
	/** The ops the server ran for this push (empty for a pure poll or a redo the server already ran). */
	serverRun: InternalOp[];
	/** Transactions since the push's starting transaction id (other clients', and possibly our own). */
	remote: Transaction[];
	needsRefresh: boolean;
}

/**
 * Where pushes start from and where their results go. Both hooks run inside
 * the single-flight queue, so the next push starts only after `accept`
 * returns. A throw from either fails the push without a retry.
 */
export interface TransactionLog
{
	/** The tree transaction id the next push starts from. */
	start(): string;
	/** Called with every accepted result, before the push resolves. */
	accept(result: PushResult): void;
}

export interface PushAndPollOptions
{
	/** Defaults to `Date.now`. */
	now?: () => number;
	/** Defaults to 8 random alphanumeric chars, like upstream's `WF.Urls.random(8)`. */
	randomId?: () => string;
	/** IANA zone sent until the first successful push; defaults to the runtime's zone. */
	timezone?: string;
	/** Defaults to a `setTimeout` delay. */
	sleep?: (ms: number) => Promise<void>;
	/** Defaults to starting from the session's id, then each previous push's result. */
	transactionLog?: TransactionLog;
}

const RETRY_BACKOFF_MS = 5000;
const MAX_REDOS = 2;
const MAX_BUSY_RETRIES = 3;
const CAPTCHA_QUESTION = "do_androids_dream_of_electric_sheep?";
const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

const TransactionIdSchema = z.union([z.string(), z.number()]).transform((value) => String(value));

const OpSchema = z
	.object(
		{
			type: z.string(),
			data: z.record(z.string(), z.unknown()),
			server_data: z
				.object(
					{
						was_noop: z.boolean().optional(),
					},
				)
				.loose()
				.optional(),
		},
	)
	.loose();

const TransactionSchema = z
	.object(
		{
			id: TransactionIdSchema.optional(),
			ops: z.array(OpSchema),
			client_timestamp: z.number().optional(),
			ex: z.number().nullable().optional(),
		},
	)
	.loose();

const ErrorResultSchema = z
	.object(
		{
			error: z.string(),
		},
	)
	.loose();

const TreeResultSchema = z
	.object(
		{
			new_most_recent_operation_transaction_id: TransactionIdSchema,
			server_run_operation_transaction_json: z.string().nullable().optional(),
			concurrent_remote_operation_transactions: z.array(z.string()).nullable().optional(),
			need_refreshed_project_tree: z.boolean().optional(),
		},
	)
	.loose();

const ResponseSchema = z
	.object(
		{
			results: z.array(z.unknown()).optional(),
			logged_out: z.boolean().optional(),
			push_lock_timeout: z.boolean().optional(),
			question: z.string().optional(),
		},
	)
	.loose();

function defaultRandomId(): string
{
	const bytes = crypto.getRandomValues(new Uint8Array(8));
	return Array.from(bytes, (byte) => ID_ALPHABET[byte % ID_ALPHABET.length]).join("");
}

/** Upstream `pq`: the transaction timestamp overrides each op's; `ex` becomes `executed_by`; no-ops are skipped. */
function flattenTransaction(json: string): Transaction
{
	const transaction = TransactionSchema.parse(JSON.parse(json));
	const ops: InternalOp[] = [];
	for (const {server_data: serverData, ...op} of transaction.ops)
	{
		if (serverData?.was_noop === true)
		{
			continue;
		}
		const flattened: InternalOp =
		{
			...op,
		};
		if (transaction.client_timestamp !== undefined)
		{
			flattened.client_timestamp = transaction.client_timestamp;
		}
		if (transaction.ex !== undefined && transaction.ex !== null)
		{
			flattened.executed_by = transaction.ex;
		}
		ops.push(flattened);
	}
	return transaction.id === undefined
		?
			{
				ops,
			}
		:
			{
				id: transaction.id,
				ops,
			};
}

interface Attempt
{
	pushPollId: string;
	isRedo: boolean;
}

/**
 * The single-flight `/push_and_poll` transport. One push is in flight at a
 * time; transport failures and session rejections redo the same batch
 * (`push_poll_id` reused, `is_redo=true`), busy/lock responses re-push it
 * fresh after a backoff, and captcha or operation errors are terminal.
 */
export class PushAndPoll
{
	private readonly now: () => number;
	private readonly randomId: () => string;
	private readonly sleep: (ms: number) => Promise<void>;
	private readonly transactionLog: TransactionLog | undefined;
	private timezone: string | undefined;
	private currentTxId: string | undefined;
	private tail: Promise<unknown> = Promise.resolve();

	constructor(
		private readonly client: WorkflowyInternalClient,
		options: PushAndPollOptions = {},
	)
	{
		this.now = options.now ?? Date.now;
		this.randomId = options.randomId ?? defaultRandomId;
		this.transactionLog = options.transactionLog;
		this.timezone = options.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
		this.sleep =
			options.sleep ??
			(async (ms) =>
				new Promise<void>((resolve) =>
				{
					setTimeout(resolve, ms);
				}));
	}

	/** The main tree's most recent transaction id: the last push's result, else the bootstrap value. */
	get txId(): string | undefined
	{
		return this.currentTxId ?? this.client.session?.txId;
	}

	async pushAndPoll(input: PushInput = {}): Promise<PushResult>
	{
		const run = this.tail.then(async () => this.pushWithRetries(input));
		this.tail = run.catch(() => {});
		return run;
	}

	private async pushWithRetries(input: PushInput): Promise<PushResult>
	{
		const session = this.client.session;
		if (!session)
		{
			throw new Error("PushAndPoll needs a bootstrapped session; call client.bootstrap() first");
		}
		const hasOps = (input.ops?.length ?? 0) > 0;
		let attempt: Attempt =
		{
			pushPollId: this.randomId(),
			isRedo: false,
		};
		// Without ops in flight there is nothing to make idempotent, so a retry is just a new poll.
		const redo = (): Attempt =>
			hasOps
				?
					{
						pushPollId: attempt.pushPollId,
						isRedo: true,
					}
				:
					{
						pushPollId: this.randomId(),
						isRedo: false,
					};
		let redos = 0;
		let busyRetries = 0;
		let reloggedIn = false;
		for (;;)
		{
			try
			{
				return await this.send(session, input, attempt);
			}
			catch (error)
			{
				if (error instanceof TransportError && redos < MAX_REDOS)
				{
					redos += 1;
					await this.sleep(RETRY_BACKOFF_MS);
					attempt = redo();
				}
				else if (error instanceof LoggedOut && !reloggedIn)
				{
					reloggedIn = true;
					await this.client.login();
					attempt = redo();
				}
				else if (
					(error instanceof AccountBusy || error instanceof PushLockTimeout) &&
					busyRetries < MAX_BUSY_RETRIES
				)
				{
					busyRetries += 1;
					await this.sleep(RETRY_BACKOFF_MS);
					attempt =
					{
						pushPollId: this.randomId(),
						isRedo: false,
					};
				}
				else
				{
					throw error;
				}
			}
		}
	}

	private async send(session: InternalSession, input: PushInput, {pushPollId, isRedo}: Attempt): Promise<PushResult>
	{
		const ops = input.ops ?? [];
		const startTxId = this.transactionLog === undefined ? this.txId : this.transactionLog.start();
		const tree: Record<string, unknown> =
		{
			most_recent_operation_transaction_id: startTxId,
		};
		if (ops.length > 0)
		{
			tree.operations = ops;
		}
		if (input.expansionsDelta && Object.keys(input.expansionsDelta).length > 0)
		{
			tree.project_expansions_delta = input.expansionsDelta;
		}

		const form = new URLSearchParams();
		form.append("client_id", session.clientId);
		form.append("client_version", session.clientVersion);
		form.append("push_poll_id", pushPollId);
		form.append("push_poll_data", JSON.stringify([tree]));
		if (this.timezone !== undefined)
		{
			form.append("timezone", this.timezone);
		}
		if (isRedo)
		{
			form.append("is_redo", "true");
		}

		const body = await this.post(`/push_and_poll?uti=${session.userId}-${this.now()}-${pushPollId}`, form);
		const response = ResponseSchema.parse(body);
		if (response.question === CAPTCHA_QUESTION)
		{
			throw new CaptchaRequired();
		}
		if (response.logged_out === true)
		{
			throw new LoggedOut("logged_out");
		}
		if (response.push_lock_timeout === true)
		{
			throw new PushLockTimeout();
		}
		// Live, a failed batch answers `{error}` alone, with no transaction id, so check the error first.
		const failed = ErrorResultSchema.safeParse(response.results?.[0]);
		if (failed.success && failed.data.error === "account_is_busy")
		{
			throw new AccountBusy();
		}
		if (failed.success)
		{
			throw new OperationRejected(failed.data.error);
		}
		const parsed = TreeResultSchema.safeParse(response.results?.[0]);
		if (!parsed.success)
		{
			throw new InternalApiError(
				"Invalid /push_and_poll response: no main-tree result",
				{
					cause: parsed.error,
				},
			);
		}
		const result = parsed.data;
		const serverRunJson = result.server_run_operation_transaction_json ?? undefined;
		if (ops.length > 0 && !isRedo && serverRunJson === undefined)
		{
			throw new OperationRejected("missing server_run");
		}

		const serverRun = serverRunJson === undefined ? undefined : flattenTransaction(serverRunJson);
		const pushResult: PushResult =
		{
			txId: result.new_most_recent_operation_transaction_id,
			...(serverRun?.id === undefined
				? {}
				:
					{
						serverRunId: serverRun.id,
					}),
			serverRun: serverRun?.ops ?? [],
			remote: (result.concurrent_remote_operation_transactions ?? []).map(flattenTransaction),
			needsRefresh: result.need_refreshed_project_tree === true,
		};
		this.currentTxId = pushResult.txId;
		this.timezone = undefined;
		this.transactionLog?.accept(pushResult);
		return pushResult;
	}

	/** POST through the client, mapping every way the request itself can fail onto the error taxonomy. */
	private async post(pathAndQuery: string, form: URLSearchParams): Promise<unknown>
	{
		let response: Response;
		try
		{
			response = await this.client.postForm(pathAndQuery, form);
		}
		catch (error)
		{
			throw new TransportError(
				`POST ${pathAndQuery.split("?")[0]} failed`,
				{
					cause: error,
				},
			);
		}
		if (response.status >= 300 && response.status < 400)
		{
			throw new LoggedOut(`redirect to ${response.headers.get("location") ?? "unknown"}`);
		}
		if (!response.ok)
		{
			throw new TransportError(`POST /push_and_poll returned ${response.status} ${response.statusText}`);
		}
		try
		{
			return (await response.json()) as unknown;
		}
		catch (error)
		{
			throw new TransportError(
				"POST /push_and_poll returned a non-JSON body",
				{
					cause: error,
				},
			);
		}
	}
}
