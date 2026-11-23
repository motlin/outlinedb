/**
 * The signed-in account's workflowy.com connection and import, over the Worker's `/api/v1/workflowy-connection` and
 * `/api/v1/workflowy-import`. The import is polled while it runs; its end refetches every other query, so the imported
 * outline replaces the tutorial without a reload.
 */

import {useQuery, useQueryClient} from "@tanstack/react-query";
import {useEffect, useRef} from "react";
import type
{
	WorkflowyConnection,
	WorkflowyImport,
	WorkflowyImportRun,
	WorkflowyLoginStep,
	WorkflowyRefusal,
} from "../../node-types.js";
import {readJson} from "../read-json.js";

/** A refused connection request: the Worker's `{error, message?, detail?}` body and its status. */
export class WorkflowyRequestError extends Error
{
	constructor(
		readonly status: number,
		readonly code: string,
		message: string,
		readonly detail?: string,
	)
	{
		super(message);
		this.name = "WorkflowyRequestError";
	}
}

/** A refused request in the user's words, by the Worker's error code. */
export function requestErrorMessage(error: unknown): string
{
	if (error instanceof WorkflowyRequestError)
	{
		if (error.code === "workflowy-login-failed")
		{
			return "workflowy.com didn't accept that sign-in.";
		}
		if (error.code === "workflowy-login-unverified")
		{
			return "workflowy.com finished the sign-in but didn't accept the session. Try again.";
		}
		if (error.code === "workflowy-captcha")
		{
			return "workflowy.com wants to check you're human. Try again later.";
		}
		if (error.code === "workflowy-login-expired")
		{
			return "That sign-in took too long. Start again.";
		}
		if (error.code === "workflowy-login-code-expired")
		{
			return "That code expired. Start again to get a new one.";
		}
		if (error.code === "credentials-key-not-configured")
		{
			return "Connecting to workflowy.com isn't available yet.";
		}
		if (error.code === "workflowy-session-expired")
		{
			return "Your workflowy.com session expired. Sign in again first.";
		}
	}
	return "Something went wrong. Try again.";
}

const connectionKeys =
{
	connection: ["workflowy-connection"] as const,
	import: ["workflowy-import"] as const,
};

const POLL_MS = 1000;

async function getJson<T>(path: string): Promise<T>
{
	const response = await fetch(path);
	if (!response.ok)
	{
		throw new Error(`${path} answered ${response.status}`);
	}
	return readJson<T>(response);
}

/** Send a write; resolves with the body on success and rejects with a {@link WorkflowyRequestError} otherwise. */
async function send<T>(path: string, method: string, body?: unknown): Promise<T>
{
	const response = await fetch(
		path,
		{
			method,
			headers:
			{
				"content-type": "application/json",
			},
			body: body === undefined ? undefined : JSON.stringify(body),
		},
	);
	if (!response.ok)
	{
		const refused = await readJson<WorkflowyRefusal>(response).catch(() => null);
		throw new WorkflowyRequestError(
			response.status,
			refused?.error ?? "",
			refused?.message ?? `${path} answered ${response.status}`,
			refused?.detail,
		);
	}
	return readJson<T>(response);
}

/** A run just asked for, before the Worker answers: queued, with nothing found or done yet. */
function queuedRun(startedAt: number): WorkflowyImportRun
{
	return {
		phase: "queued",
		status: "running",
		message: null,
		startedAt,
		finishedAt: null,
		applied: 0,
		found:
		{
			nodes: 0,
			completed: 0,
			mirrors: 0,
			backlinks: 0,
			expandedKeys: 0,
			stars: 0,
			starOrder: 0,
			tagColors: 0,
			savedViews: 0,
			settings: 0,
		},
		nodes:
		{
			added: 0,
			updated: 0,
			unchanged: 0,
			phasedOut: 0,
			metadataWritten: 0,
		},
		failures:
		{
			invalidNodes: 0,
			metadataSkipped: 0,
		},
		files:
		{
			found: 0,
			copied: 0,
			alreadyCopied: 0,
			failed: 0,
			bytes: 0,
			failures: [],
		},
	};
}

/**
 * The account's newest import run, or null: polled while it runs, wherever it was started, so every view of it (the
 * outline's banner, the import dialog, Settings) reads the same live run. A run that stops running changed the outline
 * and the connection (its last sync, or an expired session), so its end refetches every other query.
 */
export function useWorkflowyImportRun(): WorkflowyImportRun | null
{
	const queryClient = useQueryClient();
	const imported = useQuery(
		{
			queryKey: connectionKeys.import,
			queryFn: async () => getJson<WorkflowyImport>("/api/v1/workflowy-import"),
			refetchInterval: (query) => (query.state.data?.run?.status === "running" ? POLL_MS : false),
		},
	);
	const status = imported.data?.run?.status;
	const previous = useRef(status);
	useEffect(() =>
	{
		const was = previous.current;
		previous.current = status;
		if (was === "running" && status !== "running")
		{
			void queryClient.invalidateQueries(
				{
					predicate: (query) => query.queryKey[0] !== connectionKeys.import[0],
				},
			);
		}
	}, [queryClient, status]);
	return imported.data?.run ?? null;
}

export function useWorkflowyConnection()
{
	const queryClient = useQueryClient();
	const connection = useQuery(
		{
			queryKey: connectionKeys.connection,
			queryFn: async () => getJson<WorkflowyConnection>("/api/v1/workflowy-connection"),
		},
	);
	const run = useWorkflowyImportRun();

	const setConnection = (next: WorkflowyConnection) =>
	{
		queryClient.setQueryData(connectionKeys.connection, next);
	};
	return {
		connection: connection.data,
		connectionError: connection.isError,
		run,
		/**
		 * One step of signing in to workflowy.com: `{email}` starts, `{attemptId, values}` answers the fields the last
		 * step asked for. Resolves with the next step, or with null once the account is connected.
		 */
		signIn: async (
			step:
				|
				  {
						email: string;
				  }
				|
				  {
						attemptId: string;
						values: Record<string, string>;
				  },
		): Promise<WorkflowyLoginStep | null> =>
		{
			const reply = await send<WorkflowyConnection | WorkflowyLoginStep>(
				"/api/v1/workflowy-connection",
				"POST",
				step,
			);
			if ("attemptId" in reply)
			{
				return reply;
			}
			setConnection(reply);
			return null;
		},
		/** Start over: end the sign-in attempt in progress, if any. */
		cancelSignIn: async () =>
		{
			setConnection(await send<WorkflowyConnection>("/api/v1/workflowy-connection/attempt", "DELETE"));
		},
		setMirror: async (mirror: boolean) =>
		{
			setConnection(
				await send<WorkflowyConnection>(
					"/api/v1/workflowy-connection",
					"PATCH",
					{
						mirror,
					},
				),
			);
		},
		/**
		 * Start an import. The run shows as queued at once, never the previous run's report, until the Worker's answer
		 * replaces it; a refused start reads the newest run back, so a run that failed meanwhile shows its failure.
		 */
		startImport: async () =>
		{
			await queryClient.cancelQueries(
				{
					queryKey: connectionKeys.import,
				},
			);
			queryClient.setQueryData<WorkflowyImport>(
				connectionKeys.import,
				{
					run: queuedRun(Date.now()),
				},
			);
			try
			{
				queryClient.setQueryData(
					connectionKeys.import,
					await send<WorkflowyImport>("/api/v1/workflowy-import", "POST"),
				);
			}
			catch (error)
			{
				await queryClient.invalidateQueries(
					{
						queryKey: connectionKeys.import,
					},
				);
				throw error;
			}
		},
		disconnect: async () =>
		{
			setConnection(await send<WorkflowyConnection>("/api/v1/workflowy-connection", "DELETE"));
		},
	};
}
