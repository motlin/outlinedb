import {newSystemTimestamp} from "@outlinedb/shared/cache";
import {FAR_FUTURE_DATE} from "@outlinedb/shared/temporal";
import type {SealedSecret} from "./credentials-crypto";

/**
 * The account's sign-in to workflowy.com in progress, between the steps of its login form: at most one live version,
 * holding the attempt's id, the email, when it expires, and the sealed state (workflowy.com's cookies and the form's
 * hidden values, never a password or a code). Every write strips the sealed state from the versions it closes, so
 * history keeps who signed in when, never an old cookie jar.
 */
const ATTEMPT_TABLE = `
CREATE TABLE IF NOT EXISTS workflowy_login_attempt (
	attempt_id TEXT NOT NULL,
	workflowy_email TEXT NOT NULL,
	state_iv BLOB,
	state_ciphertext BLOB,
	expires_at INTEGER NOT NULL,
	system_from INTEGER NOT NULL,
	system_to INTEGER NOT NULL,
	PRIMARY KEY (system_from)
);
CREATE UNIQUE INDEX IF NOT EXISTS workflowy_login_attempt_system_to_idx ON workflowy_login_attempt (system_to);
CREATE INDEX IF NOT EXISTS workflowy_login_attempt_closed_at_idx ON workflowy_login_attempt (system_to)
	WHERE system_to < ${String(FAR_FUTURE_DATE)};
`;

/** How long an attempt waits for its next step. */
const LOGIN_ATTEMPT_TTL_MS = 10 * 60 * 1000;

export interface LiveLoginAttempt
{
	attemptId: string;
	email: string;
	state: SealedSecret;
}

/** The login attempt record in a Durable Object's SQLite; the caller seals and opens the state. */
export class WorkflowyLoginAttempt
{
	constructor(private readonly sql: SqlStorage)
	{
		sql.exec(ATTEMPT_TABLE);
	}

	/** The live attempt with this id, unless it expired; an expired one is ended on the way. */
	live(attemptId: string, now = Date.now()): LiveLoginAttempt | undefined
	{
		const row = this.sql
			.exec(
				"SELECT attempt_id, workflowy_email, state_iv, state_ciphertext, expires_at FROM workflowy_login_attempt WHERE system_to = ?",
				FAR_FUTURE_DATE,
			)
			.toArray()[0];
		if (row === undefined)
		{
			return undefined;
		}
		const {state_iv: iv, state_ciphertext: ciphertext} = row;
		if (Number(row.expires_at) <= now || !(iv instanceof ArrayBuffer) || !(ciphertext instanceof ArrayBuffer))
		{
			this.end();
			return undefined;
		}
		if (row.attempt_id !== attemptId)
		{
			return undefined;
		}
		return {
			attemptId,
			email: typeof row.workflowy_email === "string" ? row.workflowy_email : "",
			state:
			{
				iv: new Uint8Array(iv),
				ciphertext: new Uint8Array(ciphertext),
			},
		};
	}

	/** Keep the attempt's state after a step, replacing any other attempt, for another {@link LOGIN_ATTEMPT_TTL_MS}. */
	save(attempt: LiveLoginAttempt, now = Date.now()): void
	{
		const systemTime = newSystemTimestamp();
		this.closeLive(systemTime);
		this.sql.exec(
			"INSERT INTO workflowy_login_attempt (attempt_id, workflowy_email, state_iv, state_ciphertext, expires_at, system_from, system_to) VALUES (?, ?, ?, ?, ?, ?, ?)",
			attempt.attemptId,
			attempt.email,
			attempt.state.iv,
			attempt.state.ciphertext,
			now + LOGIN_ATTEMPT_TTL_MS,
			systemTime,
			FAR_FUTURE_DATE,
		);
	}

	/** End the live attempt, if any; no version keeps its sealed state afterwards. */
	end(): void
	{
		this.closeLive(newSystemTimestamp());
	}

	private closeLive(systemTime: number): void
	{
		this.sql.exec(
			"DELETE FROM workflowy_login_attempt WHERE system_to = ? AND system_from >= ?",
			FAR_FUTURE_DATE,
			systemTime,
		);
		this.sql.exec(
			"UPDATE workflowy_login_attempt SET system_to = ? WHERE system_to = ?",
			systemTime,
			FAR_FUTURE_DATE,
		);
		this.sql.exec(
			"UPDATE workflowy_login_attempt SET state_iv = NULL, state_ciphertext = NULL WHERE system_to < ? AND state_iv IS NOT NULL",
			FAR_FUTURE_DATE,
		);
	}
}
