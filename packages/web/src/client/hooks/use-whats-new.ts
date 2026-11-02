/**
 * Our What's New read state over `/api/v1/whats-new`, stored in our own database rather than upstream's root
 * metadata `changelog.read`, which belongs to upstream's entries.
 */

import {useQuery} from "@tanstack/react-query";
import type {QueryClient} from "@tanstack/react-query";
import type {WhatsNewRead} from "../../node-types.js";
import {changelogUnread, unreadChangelogEntries} from "../changelog.js";
import {readJson} from "../read-json.js";

/** The ids of our entries that were read. */
export type WhatsNewState = WhatsNewRead;

export const whatsNewKeys =
{
	all: ["whats-new"] as const,
};

async function fetchWhatsNew(): Promise<WhatsNewState>
{
	const response = await fetch("/api/v1/whats-new");
	if (!response.ok)
	{
		throw new Error(`Failed to fetch What's New read state: ${response.status}`);
	}
	return readJson<WhatsNewRead>(response);
}

/** Whether one of our entries is unread (the Help blue dot); false while loading so the dot never flashes. */
export function whatsNewUnreadFrom(state: WhatsNewState | undefined): boolean
{
	return state !== undefined && changelogUnread(state.read);
}

/** Whether What's New has unread entries; false while loading or on error. */
export function useChangelogUnread(): boolean
{
	const {data} = useQuery(
		{
			queryKey: whatsNewKeys.all,
			queryFn: fetchWhatsNew,
		},
	);
	return whatsNewUnreadFrom(data);
}

/** Mark every unread entry read once the dialog shows them, and store the server's answer. */
export async function markWhatsNewRead(queryClient: QueryClient): Promise<void>
{
	const state = queryClient.getQueryData<WhatsNewState>(whatsNewKeys.all);
	if (state === undefined)
	{
		return;
	}
	const entries = unreadChangelogEntries(state.read);
	if (entries.length === 0)
	{
		return;
	}
	const response = await fetch(
		"/api/v1/whats-new/read",
		{
			method: "POST",
			headers:
			{
				"Content-Type": "application/json",
			},
			body: JSON.stringify(
				{
					entries,
				},
			),
		},
	);
	if (!response.ok)
	{
		throw new Error(`Failed to mark What's New read: ${response.status}`);
	}
	queryClient.setQueryData<WhatsNewState>(whatsNewKeys.all, await readJson<WhatsNewRead>(response));
}
