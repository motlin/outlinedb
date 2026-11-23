import {newSystemTimestamp} from "@outlinedb/shared/cache";
import {FAR_FUTURE_DATE} from "@outlinedb/shared/temporal";
import type {SealedSecret} from "./credentials-crypto";

/**
 * This account's link to workflowy.com, temporal like every other table: one live version while connected, none once
 * disconnected. Only the live version ever holds the sealed session cookie; every write strips it from the versions it
 * closes, so history keeps when the account was connected and as whom, never an old cookie. The password is never a
 * column: connect logs in once and keeps only the cookie jar that login produced, which every internal API request
 * sends as its `Cookie` header.
 */
const CONNECTION_TABLE = `
CREATE TABLE IF NOT EXISTS workflowy_connection (
	status TEXT NOT NULL,
	workflowy_email TEXT NOT NULL,
	session_iv BLOB,
	session_ciphertext BLOB,
	mirror INTEGER NOT NULL,
	system_from INTEGER NOT NULL,
	system_to INTEGER NOT NULL,
	PRIMARY KEY (system_from)
);
CREATE UNIQUE INDEX IF NOT EXISTS workflowy_connection_system_to_idx ON workflowy_connection (system_to);
CREATE INDEX IF NOT EXISTS workflowy_connection_closed_at_idx ON workflowy_connection (system_to)
	WHERE system_to < ${String(FAR_FUTURE_DATE)};
`;

/** `expired` once workflowy.com refused the stored session: sync pauses until the user signs in again. */
type ConnectionStatus = "connected" | "expired";

/** What the account sees of its connection; never the cookie. */
export type WorkflowyConnectionView =
	|
	  {
			connected: false;
	  }
	|
	  {
			connected: true;
			status: ConnectionStatus;
			email: string;
			/** Whether the account keeps syncing with workflowy.com (two-way mirror); off means a one-time import. */
			mirror: boolean;
	  };

/** What the account's Settings > Workflowy page reads: the connection plus when it last synced with workflowy.com. */
export type WorkflowyConnectionStatus =
	| Extract<
			WorkflowyConnectionView,
			{
				connected: false;
			}
	  >
	| (Extract<
			WorkflowyConnectionView,
			{
				connected: true;
			}
	  > &
	  {
			/** When an import or a keep-syncing catch-up last finished without error; null before either did. */
			lastSyncAt: number | null;
	  });

interface LiveConnection
{
	status: ConnectionStatus;
	email: string;
	session: SealedSecret | undefined;
	mirror: boolean;
}

/** The connection record in a Durable Object's SQLite; the caller seals and opens the session. */
export class WorkflowyConnection
{
	constructor(private readonly sql: SqlStorage)
	{
		sql.exec(CONNECTION_TABLE);
	}

	view(): WorkflowyConnectionView
	{
		const live = this.live();
		return live === undefined
			?
				{
					connected: false,
				}
			:
				{
					connected: true,
					status: live.status,
					email: live.email,
					mirror: live.mirror,
				};
	}

	/** The live sealed session cookie jar (a `Cookie` header), if connected with one. */
	session(): SealedSecret | undefined
	{
		return this.live()?.session;
	}

	/** Record a fresh login; a reconnect keeps the mirror choice, a first connect starts with it off. */
	connect(email: string, session: SealedSecret): void
	{
		this.write(
			{
				status: "connected",
				email,
				session,
				mirror: this.live()?.mirror ?? false,
			},
		);
	}

	/** Turn keep-syncing on or off; false when not connected. */
	setMirror(mirror: boolean): boolean
	{
		const live = this.live();
		if (live === undefined)
		{
			return false;
		}
		this.write(
			{
				...live,
				mirror,
			},
		);
		return true;
	}

	/**
	 * Mark the connection expired once workflowy.com refused its session, dropping the dead cookie; the account keeps
	 * its email and keep-syncing choice until the user signs in again.
	 */
	expire(): void
	{
		const live = this.live();
		if (live !== undefined)
		{
			this.write(
				{
					...live,
					status: "expired",
					session: undefined,
				},
			);
		}
	}

	/** Phase the connection out; no version, live or closed, keeps a cookie afterwards. */
	disconnect(): void
	{
		this.closeLive(newSystemTimestamp());
	}

	private live(): LiveConnection | undefined
	{
		const row = this.sql
			.exec(
				"SELECT status, workflowy_email, session_iv, session_ciphertext, mirror FROM workflowy_connection WHERE system_to = ?",
				FAR_FUTURE_DATE,
			)
			.toArray()[0];
		if (row === undefined)
		{
			return undefined;
		}
		const {session_iv: iv, session_ciphertext: ciphertext} = row;
		return {
			status: row.status === "expired" ? "expired" : "connected",
			email: typeof row.workflowy_email === "string" ? row.workflowy_email : "",
			session:
				iv instanceof ArrayBuffer && ciphertext instanceof ArrayBuffer
					?
						{
							iv: new Uint8Array(iv),
							ciphertext: new Uint8Array(ciphertext),
						}
					: undefined,
			mirror: row.mirror === 1,
		};
	}

	private write(connection: LiveConnection): void
	{
		const systemTime = newSystemTimestamp();
		this.closeLive(systemTime);
		this.sql.exec(
			"INSERT INTO workflowy_connection (status, workflowy_email, session_iv, session_ciphertext, mirror, system_from, system_to) VALUES (?, ?, ?, ?, ?, ?, ?)",
			connection.status,
			connection.email,
			connection.session?.iv ?? null,
			connection.session?.ciphertext ?? null,
			connection.mirror ? 1 : 0,
			systemTime,
			FAR_FUTURE_DATE,
		);
	}

	/** Close the live version at `systemTime` and strip the cookie from every closed one. */
	private closeLive(systemTime: number): void
	{
		this.sql.exec(
			"DELETE FROM workflowy_connection WHERE system_to = ? AND system_from >= ?",
			FAR_FUTURE_DATE,
			systemTime,
		);
		this.sql.exec("UPDATE workflowy_connection SET system_to = ? WHERE system_to = ?", systemTime, FAR_FUTURE_DATE);
		this.sql.exec(
			"UPDATE workflowy_connection SET session_iv = NULL, session_ciphertext = NULL WHERE system_to < ? AND session_iv IS NOT NULL",
			FAR_FUTURE_DATE,
		);
	}
}
