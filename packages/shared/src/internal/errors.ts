/**
 * Failures of Workflowy's internal `/push_and_poll` write path. Each subclass
 * maps to one retry rule in `PushAndPoll`; callers outside `internal/` should
 * only ever need `instanceof InternalApiError` plus `message`.
 */
export class InternalApiError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = new.target.name;
	}
}

/** The server answered with its bot challenge. A Node client cannot solve it, so this is never retried. */
export class CaptchaRequired extends InternalApiError {
	constructor() {
		super("Workflowy demanded a captcha; stop pushing and use the web app");
	}
}

/** The session cookie was rejected (a `logged_out` body or a login redirect). */
export class LoggedOut extends InternalApiError {
	constructor(reason: string) {
		super(`Workflowy session rejected (${reason})`);
	}
}

/** The result reported `account_is_busy`; the batch was not run and may be pushed again. */
export class AccountBusy extends InternalApiError {
	constructor() {
		super("Workflowy account is busy");
	}
}

/** The response carried `push_lock_timeout`; the batch was not run and may be pushed again. */
export class PushLockTimeout extends InternalApiError {
	constructor() {
		super("Workflowy push lock timed out");
	}
}

/** The server refused the pushed operations. Never retried: upstream drops the batch too. */
export class OperationRejected extends InternalApiError {
	constructor(readonly serverError: string) {
		super(`Workflowy rejected the operations: ${serverError}`);
	}
}

/** The request never produced a usable response (network failure, non-2xx status, unparseable body). */
export class TransportError extends InternalApiError {}

const RESEED = "run './bin/run.js cache import-api' to";

/**
 * The cache cannot follow the tree's transaction log, so no push can start.
 * Never retried and never reseeded automatically: a whole-tree read is 54 MB,
 * so only an explicit `cache import-api` (or an admin endpoint) reseeds.
 * The web host answers it with a 503 carrying this message.
 */
export class TreeResyncRequired extends InternalApiError {}

/** No whole-tree import has stored a transaction id yet. */
export class TreeNotSeeded extends TreeResyncRequired {
	constructor() {
		super(`The local cache has no Workflowy transaction id to sync from; ${RESEED} seed it`);
	}
}

/** No whole-tree import has stored the account's expanded keys yet. */
export class ExpansionNotSeeded extends TreeResyncRequired {
	constructor() {
		super(`The local cache has no expanded keys; ${RESEED} seed them`);
	}
}

/** The server answered `need_refreshed_project_tree`: the stored id is not (or no longer) in the tree's log. */
export class TreeRefreshRequired extends TreeResyncRequired {
	constructor(readonly txId: string) {
		super(
			`Workflowy answered need_refreshed_project_tree: the cache's transaction id ${txId} is no longer in the tree's log; ${RESEED} reseed it`,
		);
	}
}

/** A logged op carries relationship data the replay cannot parse; skipping it would let the cache diverge silently. */
export class UnreplayableTransaction extends TreeResyncRequired {
	constructor(
		readonly txId: string,
		readonly opType: string,
	) {
		super(
			`Workflowy transaction ${txId} has a ${opType} op the cache cannot parse, so the cache would diverge from the tree; ${RESEED} reseed it`,
		);
	}
}

/** Connected to workflowy.com, which has no Inbox either: neither root metadata `inbox_id` nor a Home child named Inbox. */
export class InboxMissing extends Error {
	constructor() {
		super("Workflowy has no Inbox: root metadata inbox_id names no live node and Home has no node named Inbox");
		this.name = "InboxMissing";
	}
}
