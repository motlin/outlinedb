/** Helpers for tests that drive a fake workflowy.com. */

export const sleep = async (ms: number): Promise<void> =>
	new Promise((resolve) =>
	{
		setTimeout(resolve, ms);
	});

// Status polls are cheap in-process fetches, so poll often; each loop keeps its overall wait budget.
export const POLL_MS = 10;

export function uuid(n: number): string
{
	return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

/** One `/push_and_poll` result, as the server sends it. */
export function pollResult(txId: string, extra: Record<string, unknown> = {}): Response
{
	return Response.json(
		{
			results: [
				{
					new_most_recent_operation_transaction_id: txId,
					...extra,
				},
			],
		},
	);
}
