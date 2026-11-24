/** Workflowy's internal API as a CLI write's outbox drain meets it, and the outbox rows the write left. */
import fs from "node:fs";
import path from "node:path";
import {readPendingOutbox, storeTreeTxId} from "@outlinedb/shared/cache";
import type {OutboxAspect} from "@outlinedb/shared/cache";
import type {MockInstance} from "vite-plus/test";
import type {TestDatabase} from "../db/migration-helper.js";
import {catchUpResponse} from "./internal-catch-up.js";

/** One pushed op, reduced to what a test asserts on. */
export interface PushedOp
{
	type: string;
	data: Record<string, unknown>;
}

export interface UpstreamFake
{
	/** Every request, as `METHOD /path`. */
	paths: string[];
	/** The ops of each `/push_and_poll` that carried any, in order. */
	pushes: PushedOp[][];
}

/** No internal-API session: the shell's saved session never reaches a test. */
export function isolateInternalAuth(tempDir: string): void
{
	process.env.OUTLINEDB_SESSION_FILE = path.join(tempDir, "workflowy-session");
}

/**
 * Save an internal-API session cookie and answer `fetch` as workflowy.com does: init, and a `/push_and_poll`
 * that echoes the pushed ops as the server run, so the drain closes the rows it carried. With `failPush`, every push
 * is rejected instead. Any other request fails the test.
 */
export function fakeUpstream(
	fetchStub: MockInstance<typeof fetch>,
	testDatabase: TestDatabase,
	tempDir: string,
	options:
	{
		failPush?: boolean;
	} = {},
): UpstreamFake
{
	process.env.OUTLINEDB_SESSION_FILE = path.join(tempDir, "workflowy-session");
	fs.writeFileSync(process.env.OUTLINEDB_SESSION_FILE, "sessionid=abc\n");
	storeTreeTxId(testDatabase.db, "1234567");
	const fake: UpstreamFake =
	{
		paths: [],
		pushes: [],
	};
	fetchStub.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) =>
	{
		const url = new URL(input instanceof Request ? input.url : String(input));
		fake.paths.push(`${init?.method ?? "GET"} ${url.pathname}`);
		if (url.pathname === "/push_and_poll")
		{
			return Promise.resolve(pushResponse(fake, init, options.failPush === true));
		}
		const internal = catchUpResponse(url.pathname);
		if (internal !== undefined)
		{
			return Promise.resolve(internal);
		}
		throw new Error(`unexpected request: ${init?.method ?? "GET"} ${url.href}`);
	});
	return fake;
}

function pushResponse(fake: UpstreamFake, init: RequestInit | undefined, fail: boolean): Response
{
	if (fail)
	{
		return Response.json(
			{
				results: [
					{
						error: "upstream_rejected",
					},
				],
			},
		);
	}
	// oxlint-disable-next-line typescript/no-base-to-string -- the internal client posts a string body
	const form = new URLSearchParams(String(init?.body ?? ""));
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the client's own push_poll_data shape
	const [tree] = JSON.parse(form.get("push_poll_data") ?? "[]") as [
		{
			operations?: PushedOp[];
		}?,
	];
	const ops = tree?.operations ?? [];
	if (ops.length > 0)
	{
		fake.pushes.push(
			ops.map(({type, data}) => (
			{
				type,
				data,
			})),
		);
	}
	return Response.json(
		{
			results: [
				{
					new_most_recent_operation_transaction_id: String(1_234_568 + fake.pushes.length),
					server_run_operation_transaction_json: JSON.stringify(
						{
							ops,
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

/** The current outbox rows, oldest first. */
export function pendingOutbox(testDatabase: TestDatabase):
{
	nodeId: string;
	aspect: OutboxAspect;
	lastError: string | null;
}[]
{
	return readPendingOutbox(testDatabase.db, 1000).map(({nodeId, aspect, lastError}) => (
	{
		nodeId,
		aspect,
		lastError,
	}));
}
