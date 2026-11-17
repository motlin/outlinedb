/**
 * Fetch a response's text in one attempt, naming the answers that would otherwise surface as
 * "Unexpected end of JSON input".
 *
 * `tsx watch` restarts the dev API whenever a source file changes, and for a moment the Vite proxy
 * answers with an empty body or a dropped connection. Those fail loudly with a message the page
 * shows, instead of being retried out of sight. Answers with a body, 4xx and 5xx included, return
 * to the caller, which shows the server's `{error}`.
 */

export interface FetchedText
{
	status: number;
	ok: boolean;
	text: string;
}

/** The hint for an answer that only a restarting or stopped dev API gives. */
export const RESTARTING = "the API may be restarting. Reload to try again.";

export async function fetchText(
	url: string,
	init: RequestInit,
	fetchImpl: (url: string, init: RequestInit) => Promise<Response> = fetch,
): Promise<FetchedText>
{
	let response: Response;
	try
	{
		response = await fetchImpl(url, init);
	}
	catch (error)
	{
		if (error instanceof DOMException && error.name === "AbortError")
		{
			throw error;
		}
		const reason = error instanceof Error ? error.message : String(error);
		throw new Error(
			`Could not reach the server (${reason}); ${RESTARTING}`,
			{
				cause: error,
			},
		);
	}
	const text = await response.text();
	if (text === "")
	{
		throw new Error(`The server answered HTTP ${response.status} with an empty body; ${RESTARTING}`);
	}
	return {
		status: response.status,
		ok: response.ok,
		text,
	};
}
