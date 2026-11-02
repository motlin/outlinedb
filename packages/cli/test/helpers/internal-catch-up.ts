/** Internal-API answers for tests whose backlink sync only catches up from the transaction log. */

const INIT_BODY =
{
	projectTreeData:
	{
		mainProjectTreeInfo:
		{
			dateJoinedTimestampInSeconds: 1_300_000_000,
			initialMostRecentOperationTransactionId: "1234567",
			ownerId: 42,
		},
		rootProjectMetadata: {},
	},
	settings: {},
	user:
	{
		id: 42,
	},
	globals: [["CLIENT_VERSION", 25]],
};

/** The internal init and an empty catch-up poll a backlink sync starts with, or `undefined` for any other path. */
export function catchUpResponse(pathname: string): Response | undefined
{
	if (pathname === "/get_initialization_data")
	{
		return Response.json(
			INIT_BODY,
			{
				headers:
				{
					wfclientid: "2026-10-18 12:00:00.123456",
				},
			},
		);
	}
	if (pathname === "/push_and_poll")
	{
		return Response.json(
			{
				results: [
					{
						new_most_recent_operation_transaction_id: "1234568",
						server_run_operation_transaction_json: JSON.stringify(
							{
								ops: [],
								client_timestamp: 492_324_800,
							},
						),
						concurrent_remote_operation_transactions: [],
						error_encountered_in_remote_operations: false,
					},
				],
			},
		);
	}
	return undefined;
}
