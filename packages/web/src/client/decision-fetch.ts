/** Error text for the decision pages' fetches. */

import {readJson} from "./read-json.js";
import type {FetchedText} from "./restart-retry.js";

/** The server's `{error}` message from a failed response, or its HTTP status. */
export async function errorOf(response: FetchedText): Promise<string>
{
	try
	{
		return (
			await readJson<
			{
				error: string;
			}>(new Response(response.text))
		).error;
	}
	catch
	{
		return `HTTP ${response.status}`;
	}
}

export function messageOf(error: unknown): string
{
	return error instanceof Error ? error.message : String(error);
}
