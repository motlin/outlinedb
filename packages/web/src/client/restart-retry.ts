/**
 * Fetch through a dev-server restart.
 *
 * `tsx watch` restarts the API whenever a file changes, and for a moment the Vite proxy answers
 * with an empty body, a 5xx, or a dropped connection. A page that loads during that window must
 * retry instead of showing "Unexpected end of JSON input". 4xx answers are real and return at once.
 */

export interface RestartRetryOptions
{
	fetch?: (url: string, init: RequestInit) => Promise<Response>;
	sleep?: (ms: number) => Promise<void>;
	attempts?: number;
}

export interface FetchedText
{
	status: number;
	ok: boolean;
	text: string;
}

const BACKOFF_MS = [250, 500, 1000, 2000];

async function defaultSleep(ms: number): Promise<void>
{
	return new Promise((resolve) =>
	{
		setTimeout(resolve, ms);
	});
}

function abortError(): Error
{
	return new DOMException("The operation was aborted.", "AbortError");
}

export async function fetchThroughRestarts(
	url: string,
	init: RequestInit,
	{fetch: fetchImpl = fetch, sleep = defaultSleep, attempts = 20}: RestartRetryOptions = {},
): Promise<FetchedText>
{
	let lastFailure = "";
	for (let attempt = 0; attempt < attempts; attempt++)
	{
		if (init.signal?.aborted === true)
		{
			throw abortError();
		}
		try
		{
			const response = await fetchImpl(url, init);
			const text = await response.text();
			const transient = response.status >= 500 || (response.ok && text === "");
			if (!transient)
			{
				return {
					status: response.status,
					ok: response.ok,
					text,
				};
			}
			lastFailure = text === "" ? `HTTP ${response.status} with an empty body` : `HTTP ${response.status}`;
		}
		catch (error)
		{
			if (error instanceof DOMException && error.name === "AbortError")
			{
				throw error;
			}
			lastFailure = error instanceof Error ? error.message : String(error);
		}
		if (attempt < attempts - 1)
		{
			await sleep(BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)] ?? 2000);
		}
	}
	throw new Error(`The server did not answer after ${attempts} attempts (${lastFailure}); it may be restarting.`);
}
