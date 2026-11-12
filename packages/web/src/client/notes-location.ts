// Upstream's default create-and-move location: a `Notes` node at the bottom of Home, created on
// first use and recorded as the account-global `notesRootId` (shared with workflowy.com).

import type {QueryClient} from "@tanstack/react-query";
import type {NodeEnvelope} from "../node-types.js";
import {setPreferences} from "./hooks/use-preferences.js";
import type {Preferences} from "./hooks/use-preferences.js";
import {nodeKeys} from "./node-cache.js";
import {readJson} from "./read-json.js";

/** Notes created this session whose `notesRootId` could not be saved (503). */
let sessionNotesRootId: string | null = null;

/** The account's Notes node, else the one this session created without persisting. */
export function notesRootIdFor(preferences: Pick<Preferences, "notesRootId">): string | null
{
	return preferences.notesRootId ?? sessionNotesRootId;
}

/** Create `Notes` at the bottom of Home and record it as `notesRootId`; returns its id. */
export async function ensureNotesLocation(queryClient: QueryClient): Promise<string>
{
	const response = await fetch(
		"/api/v1/nodes",
		{
			method: "POST",
			headers:
			{
				"Content-Type": "application/json",
			},
			body: JSON.stringify(
				{
					parent_id: null,
					name: "Notes",
				},
			),
		},
	);
	if (!response.ok)
	{
		throw new Error(`Failed to create Notes: ${response.statusText}`);
	}
	const {node} = await readJson<NodeEnvelope>(response);
	sessionNotesRootId = node.id;
	void queryClient.invalidateQueries(
		{
			queryKey: nodeKeys.children(null),
		},
	);
	try
	{
		await setPreferences(
			queryClient,
			{
				notesRootId: node.id,
			},
		);
	}
	catch
	{
		// Without the internal API (503) the node serves as Notes for this session only.
	}
	return node.id;
}
