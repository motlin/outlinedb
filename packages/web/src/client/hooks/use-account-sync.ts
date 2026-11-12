/**
 * The signed-in account's import state over `GET /api/v1/sync-status`: whether its first sync is still fetching or
 * importing, and how many items it has applied. Polled only while a run is in progress; each poll that sees more
 * items applied, and the run's end, invalidates every other query so the imported outline appears without a reload.
 */

import {useQuery, useQueryClient} from "@tanstack/react-query";
import {useEffect, useRef} from "react";
import type {AccountSync} from "../../node-types.js";
import {readJson} from "../read-json.js";

const accountSyncKeys =
{
	all: ["account-sync"] as const,
};

const IDLE: AccountSync =
{
	phase: "idle",
	applied: 0,
};
const POLL_MS = 2000;

/** The status, or idle when the host has no sync (the Node host answers 404) or the read fails. */
async function fetchAccountSync(): Promise<AccountSync>
{
	try
	{
		const response = await fetch("/api/v1/sync-status");
		return response.ok ? await readJson<AccountSync>(response) : IDLE;
	}
	catch
	{
		return IDLE;
	}
}

/** The account's sync state, or undefined until the first read answers. */
export function useAccountSync(): AccountSync | undefined
{
	const queryClient = useQueryClient();
	const {data} = useQuery(
		{
			queryKey: accountSyncKeys.all,
			queryFn: fetchAccountSync,
			refetchInterval: (query) =>
				query.state.data === undefined || query.state.data.phase === "idle" ? false : POLL_MS,
		},
	);
	// What the outline last re-read at: a finished run, or more items applied, refetches everything else.
	const seen = useRef<AccountSync | undefined>(undefined);
	useEffect(() =>
	{
		const previous = seen.current;
		seen.current = data;
		if (previous === undefined || data === undefined)
		{
			return;
		}
		const finished = previous.phase !== "idle" && data.phase === "idle";
		if (finished || data.applied > previous.applied)
		{
			void queryClient.invalidateQueries(
				{
					predicate: (query) => query.queryKey[0] !== accountSyncKeys.all[0],
				},
			);
		}
	}, [queryClient, data]);
	return data;
}
