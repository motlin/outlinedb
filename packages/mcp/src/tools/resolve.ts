import type {CallToolResult} from "@modelcontextprotocol/sdk/types.js";
import type {OpInput, StoreClient} from "@outlinedb/web/server-app";
import {opError} from "./results.js";

export type Resolved =
	|
	  {
			ok: true;
			id: string | null;
	  }
	|
	  {
			ok: false;
			error: CallToolResult;
	  };

/** A node (or with `parent`, a parent: `null` for Home) from an id, short id or comma path, through `nodes.resolve`. */
export async function resolve(store: StoreClient, input: OpInput<"nodes.resolve">): Promise<Resolved>
{
	const result = await store.call("nodes.resolve", input);
	return result.ok
		?
			{
				ok: true,
				id: result.value.id,
			}
		:
			{
				ok: false,
				error: opError(result),
			};
}
