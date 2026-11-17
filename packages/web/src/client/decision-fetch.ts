/** Error text for the decision pages' fetches. */

import {readJson} from "./read-json.js";
import {RESTARTING} from "./fetch-text.js";
import type {FetchedText} from "./fetch-text.js";

/**
 * The server's `{error}` message from a failed response, or its HTTP status. A 5xx without one
 * comes from the dev proxy when the API behind it is down, so it says so.
 */
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
		return response.status >= 500 ? `HTTP ${response.status}; ${RESTARTING}` : `HTTP ${response.status}`;
	}
}

export function messageOf(error: unknown): string
{
	return error instanceof Error ? error.message : String(error);
}
