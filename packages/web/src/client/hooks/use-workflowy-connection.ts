/**
 * The signed-in account's workflowy.com connection and import, over the Worker's `/api/v1/workflowy-connection` and
 * `/api/v1/workflowy-import`. The import is polled while it runs; its end refetches every other query, so the imported
 * outline replaces the tutorial without a reload.
 */

import {useQuery, useQueryClient} from "@tanstack/react-query";
import {useEffect, useRef} from "react";
import type {WorkflowyConnection, WorkflowyImport, WorkflowyLoginStep, WorkflowyRefusal} from "../../node-types.js";
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

export function useWorkflowyConnection()
{
	const queryClient = useQueryClient();
	const connection = useQuery(
		{
			queryKey: connectionKeys.connection,
			queryFn: async () => getJson<WorkflowyConnection>("/api/v1/workflowy-connection"),
		},
	);
	const imported = useQuery(
		{
			queryKey: connectionKeys.import,
			queryFn: async () => getJson<WorkflowyImport>("/api/v1/workflowy-import"),
			refetchInterval: (query) => (query.state.data?.run?.status === "running" ? POLL_MS : false),
		},
	);

	// A run that stops running changed the outline and the connection (its last sync, or an expired session).
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

	const setConnection = (next: WorkflowyConnection) =>
	{
		queryClient.setQueryData(connectionKeys.connection, next);
	};
	return {
		connection: connection.data,
		connectionError: connection.isError,
		run: imported.data?.run ?? null,
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
		startImport: async () =>
		{
			queryClient.setQueryData(
				connectionKeys.import,
				await send<WorkflowyImport>("/api/v1/workflowy-import", "POST"),
			);
		},
		disconnect: async () =>
		{
			setConnection(await send<WorkflowyConnection>("/api/v1/workflowy-connection", "DELETE"));
		},
	};
}
