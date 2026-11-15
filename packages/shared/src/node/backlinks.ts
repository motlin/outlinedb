import {WorkflowyInternalClient} from "../api/workflowy-internal-client.js";
import type {WorkflowyWriteThroughClient} from "../cache/workflowy-write-through-client.js";
import {WorkflowyInternalAdapter} from "../internal/adapter.js";
import type {WorkflowyInternalAdapterOptions} from "../internal/adapter.js";
import {readInternalAuth} from "./session-store.js";

type Database = WorkflowyInternalAdapterOptions["db"];

/** An internal-API adapter over the cache, or undefined without configured internal auth. */
export function internalAdapter(
	database: Database,
	writeThrough: WorkflowyWriteThroughClient,
): WorkflowyInternalAdapter | undefined
{
	const auth = readInternalAuth();
	return auth
		? new WorkflowyInternalAdapter(
				{
					client: new WorkflowyInternalClient(auth),
					db: database,
					writeThrough,
				},
			)
		: undefined;
}
