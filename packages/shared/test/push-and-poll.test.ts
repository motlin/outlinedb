import {describe, expect, it} from "vite-plus/test";
import {WorkflowyInternalClient} from "../src/api/workflowy-internal-client.js";
import
{
	AccountBusy,
	CaptchaRequired,
	LoggedOut,
	OperationRejected,
	PushLockTimeout,
	TransportError,
} from "../src/internal/errors.js";
import {PushAndPoll} from "../src/internal/push-and-poll.js";
import type {InternalOp, PushResult} from "../src/internal/push-and-poll.js";
import {createFakeInternalApi, FAKE_CLIENT_ID, FAKE_SESSION_ID, json} from "./helpers/fake-internal-api.js";
import type {RecordedRequest} from "./helpers/fake-internal-api.js";

const TRANSIENT_ID = "6f1c1d1e-0000-4000-8000-000000000001";
const BASE_URL = "https://workflowy.test";
const NOW_MS = 1_800_000_000_000;

const EDIT_OP: InternalOp =
{
	type: "edit",
	data:
	{
		projectid: "c1",
		name: "Renamed",
		metadataPatches: [],
		metadataInversePatches: [],
	},
	client_timestamp: 300_000_000,
	undo_data:
	{
		previous_name: "Old",
		previous_last_modified: 299_999_000,
		previous_last_modified_by: null,
		metadataPatches: [],
	},
};

const SERVER_RUN = JSON.stringify(
	{
		ops: [
			{
				type: "edit",
				data:
				{
					projectid: "c1",
					name: "Renamed",
				},
			},
		],
		client_timestamp: 300_000_001,
	},
);

function pushOk(txId: string, extra: Record<string, unknown> = {})
{
	return () =>
		json(
			{
				results: [
					{
						new_most_recent_operation_transaction_id: txId,
						server_run_operation_transaction_json: SERVER_RUN,
						concurrent_remote_operation_transactions: [],
						...extra,
					},
				],
			},
		);
}

interface Setup
{
	fetch?: typeof fetch;
}

function setup({fetch: wrapFetch}: Setup = {})
{
	const api = createFakeInternalApi();
	const client = new WorkflowyInternalClient(
		{
			credentials:
			{
				username: "alice@example.com",
				password: "hunter2",
			},
			fetch: wrapFetch ?? api.fetch,
			baseUrl: BASE_URL,
			transientId: TRANSIENT_ID,
		},
	);
	return {
		api,
		client,
	};
}

function pusherFor(client: WorkflowyInternalClient)
{
	const sleeps: number[] = [];
	const ids = ["pollid01", "pollid02", "pollid03", "pollid04", "pollid05"];
	const pusher = new PushAndPoll(
		client,
		{
			now: () => NOW_MS,
			randomId: () => ids.shift() ?? "exhausted",
			timezone: "America/New_York",
			sleep: async (ms) =>
			{
				sleeps.push(ms);
				await Promise.resolve();
			},
		},
	);
	return {
		pusher,
		sleeps,
	};
}

function pushes(requests: RecordedRequest[])
{
	return requests.filter((r) => r.path === "/push_and_poll");
}

function form(request: RecordedRequest | undefined): Record<string, unknown>
{
	const fields = Object.fromEntries(new URLSearchParams(request?.body ?? ""));
	return {
		...fields,
		push_poll_data: JSON.parse(fields.push_poll_data ?? "null"),
	};
}

async function bootstrapped(api = createFakeInternalApi())
{
	const client = new WorkflowyInternalClient(
		{
			credentials:
			{
				username: "alice@example.com",
				password: "hunter2",
			},
			fetch: api.fetch,
			baseUrl: BASE_URL,
			transientId: TRANSIENT_ID,
		},
	);
	await client.bootstrap();
	return {
		api,
		client,
		...pusherFor(client),
	};
}

describe("PushAndPoll", () =>
{
	it("posts the exact upstream field set and advances the transaction id", async () =>
	{
		const {api, pusher} = await bootstrapped();
		api.respondOnce("/push_and_poll", pushOk("4568"));

		const result = await pusher.pushAndPoll(
			{
				ops: [EDIT_OP],
				expansionsDelta:
				{
					"1a2b3c4d": true,
				},
			},
		);

		expect(result).toStrictEqual(
			{
				txId: "4568",
				serverRun: [
					{
						type: "edit",
						data:
						{
							projectid: "c1",
							name: "Renamed",
						},
						client_timestamp: 300_000_001,
					},
				],
				remote: [],
				needsRefresh: false,
			},
		);
		expect(pusher.txId).toBe("4568");
		const [push] = pushes(api.requests);
		expect(push?.method).toBe("POST");
		expect(push?.url).toBe(`${BASE_URL}/push_and_poll?uti=123-${NOW_MS}-pollid01`);
		expect(push?.headers).toStrictEqual(
			{
				cookie: `sessionid=${FAKE_SESSION_ID}`,
				accept: "application/json",
				"content-type": "application/x-www-form-urlencoded; charset=UTF-8",
				"x-requested-with": "XMLHttpRequest",
				"wf-transient-id": TRANSIENT_ID,
			},
		);
		expect(form(push)).toStrictEqual(
			{
				client_id: FAKE_CLIENT_ID,
				client_version: "25",
				push_poll_id: "pollid01",
				push_poll_data: [
					{
						most_recent_operation_transaction_id: "4567",
						operations: [EDIT_OP],
						project_expansions_delta:
						{
							"1a2b3c4d": true,
						},
					},
				],
				timezone: "America/New_York",
				crosscheck_user_id: "123",
			},
		);
	});

	it("sends a pure poll with only the transaction id, and drops timezone after the first success", async () =>
	{
		const {api, pusher} = await bootstrapped();
		api.respondOnce("/push_and_poll", () =>
			json(
				{
					results: [
						{
							new_most_recent_operation_transaction_id: "4568",
						},
					],
				},
			),
		);
		api.respondOnce("/push_and_poll", () =>
			json(
				{
					results: [
						{
							new_most_recent_operation_transaction_id: "4569",
						},
					],
				},
			),
		);

		await pusher.pushAndPoll();
		await pusher.pushAndPoll();

		const [first, second] = pushes(api.requests);
		expect(form(first)).toStrictEqual(
			{
				client_id: FAKE_CLIENT_ID,
				client_version: "25",
				push_poll_id: "pollid01",
				push_poll_data: [
					{
						most_recent_operation_transaction_id: "4567",
					},
				],
				timezone: "America/New_York",
				crosscheck_user_id: "123",
			},
		);
		expect(form(second)).toStrictEqual(
			{
				client_id: FAKE_CLIENT_ID,
				client_version: "25",
				push_poll_id: "pollid02",
				push_poll_data: [
					{
						most_recent_operation_transaction_id: "4568",
					},
				],
				crosscheck_user_id: "123",
			},
		);
		expect(pusher.txId).toBe("4569");
	});

	it("parses concurrent remote transactions and the refresh flag", async () =>
	{
		const {api, pusher} = await bootstrapped();
		const remote = JSON.stringify(
			{
				id: 4569,
				ops: [
					{
						type: "complete",
						data:
						{
							projectid: "r1",
						},
						client_timestamp: 1,
					},
					{
						type: "edit",
						data:
						{
							projectid: "r2",
						},
						server_data:
						{
							was_noop: true,
						},
					},
				],
				client_timestamp: 42,
				ex: 456,
			},
		);
		api.respondOnce("/push_and_poll", () =>
			json(
				{
					results: [
						{
							new_most_recent_operation_transaction_id: 4570,
							concurrent_remote_operation_transactions: [remote],
							need_refreshed_project_tree: true,
						},
					],
				},
			),
		);

		const result = await pusher.pushAndPoll();

		expect(result).toStrictEqual(
			{
				txId: "4570",
				serverRun: [],
				remote: [
					{
						id: "4569",
						ops: [
							{
								type: "complete",
								data:
								{
									projectid: "r1",
								},
								client_timestamp: 42,
								executed_by: 456,
							},
						],
					},
				],
				needsRefresh: true,
			},
		);
	});

	it("reports the server-run transaction's id when the server sends one", async () =>
	{
		const {api, pusher} = await bootstrapped();
		api.respondOnce(
			"/push_and_poll",
			pushOk(
				"4568",
				{
					server_run_operation_transaction_json: JSON.stringify(
						{
							id: 4568,
							ops: [],
						},
					),
				},
			),
		);

		const result = await pusher.pushAndPoll(
			{
				ops: [EDIT_OP],
			},
		);

		expect(result).toStrictEqual(
			{
				txId: "4568",
				serverRunId: "4568",
				serverRun: [],
				remote: [],
				needsRefresh: false,
			},
		);
	});

	it("starts every push from the transaction log and hands it each accepted result before resolving", async () =>
	{
		const api = createFakeInternalApi();
		const client = new WorkflowyInternalClient(
			{
				credentials:
				{
					username: "alice@example.com",
					password: "hunter2",
				},
				fetch: api.fetch,
				baseUrl: BASE_URL,
				transientId: TRANSIENT_ID,
			},
		);
		await client.bootstrap();
		const starts = ["100", "250"];
		const accepted: PushResult[] = [];
		const pusher = new PushAndPoll(
			client,
			{
				now: () => NOW_MS,
				randomId: () => "pollid01",
				timezone: "America/New_York",
				transactionLog:
				{
					start: () => starts.shift() ?? "exhausted",
					accept: (result) =>
					{
						accepted.push(result);
					},
				},
			},
		);
		api.respondOnce("/push_and_poll", pushOk("200"));
		api.respondOnce("/push_and_poll", pushOk("300"));

		const first = await pusher.pushAndPoll(
			{
				ops: [EDIT_OP],
			},
		);
		await pusher.pushAndPoll();

		expect(pushes(api.requests).map((request) => form(request).push_poll_data)).toStrictEqual([
			[
				{
					most_recent_operation_transaction_id: "100",
					operations: [EDIT_OP],
				},
			],
			[
				{
					most_recent_operation_transaction_id: "250",
				},
			],
		]);
		expect(accepted.map((result) => result.txId)).toStrictEqual(["200", "300"]);
		expect(accepted[0]).toBe(first);
	});

	it("propagates a transaction-log refusal without retrying", async () =>
	{
		const {api, client} = await bootstrapped();
		const refusal = new Error("no seed");
		const pusher = new PushAndPoll(
			client,
			{
				now: () => NOW_MS,
				transactionLog:
				{
					start: () =>
					{
						throw refusal;
					},
					accept: () =>
					{
					},
				},
			},
		);

		await expect(
			pusher.pushAndPoll(
				{
					ops: [EDIT_OP],
				},
			),
		).rejects.toBe(refusal);
		expect(pushes(api.requests)).toStrictEqual([]);
	});

	it("serializes concurrent calls: the second request starts after the first resolves", async () =>
	{
		const api = createFakeInternalApi();
		const gates: (() => void)[] = [];
		const gatedFetch: typeof fetch = async (input, init) =>
		{
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			if (url.includes("/push_and_poll"))
			{
				await new Promise<void>((resolve) =>
				{
					gates.push(resolve);
				});
			}
			return api.fetch(input, init);
		};
		const {client} = setup(
			{
				fetch: gatedFetch,
			},
		);
		await client.bootstrap();
		const {pusher} = pusherFor(client);
		api.respondOnce("/push_and_poll", pushOk("4568"));
		api.respondOnce("/push_and_poll", pushOk("4569"));

		const first = pusher.pushAndPoll(
			{
				ops: [EDIT_OP],
			},
		);
		const second = pusher.pushAndPoll(
			{
				ops: [EDIT_OP],
			},
		);
		await new Promise<void>((resolve) =>
		{
			setTimeout(resolve, 0);
		});

		expect(gates).toHaveLength(1);
		gates.shift()?.();
		expect((await first).txId).toBe("4568");
		await new Promise<void>((resolve) =>
		{
			setTimeout(resolve, 0);
		});
		expect(gates).toHaveLength(1);
		gates.shift()?.();
		expect((await second).txId).toBe("4569");
		const [push1, push2] = pushes(api.requests).map(form);
		expect(push1?.push_poll_data).toStrictEqual([
			{
				most_recent_operation_transaction_id: "4567",
				operations: [EDIT_OP],
			},
		]);
		expect(push2?.push_poll_data).toStrictEqual([
			{
				most_recent_operation_transaction_id: "4568",
				operations: [EDIT_OP],
			},
		]);
	});

	it("redoes a transport failure with the same push_poll_id and is_redo=true", async () =>
	{
		const api = createFakeInternalApi();
		let failures = 1;
		const flakyFetch: typeof fetch = async (input, init) =>
		{
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			if (url.includes("/push_and_poll") && failures > 0)
			{
				failures -= 1;
				await api.fetch(input, init);
				throw new TypeError("fetch failed");
			}
			return api.fetch(input, init);
		};
		const {client} = setup(
			{
				fetch: flakyFetch,
			},
		);
		await client.bootstrap();
		const {pusher, sleeps} = pusherFor(client);
		api.respond("/push_and_poll", () =>
			json(
				{
					results: [
						{
							new_most_recent_operation_transaction_id: "4568",
						},
					],
				},
			),
		);

		const result = await pusher.pushAndPoll(
			{
				ops: [EDIT_OP],
			},
		);

		expect(result.txId).toBe("4568");
		const [first, second] = pushes(api.requests);
		expect(first?.url).toBe(`${BASE_URL}/push_and_poll?uti=123-${NOW_MS}-pollid01`);
		expect(second?.url).toBe(`${BASE_URL}/push_and_poll?uti=123-${NOW_MS}-pollid01`);
		expect(form(first)).toStrictEqual(
			{
				client_id: FAKE_CLIENT_ID,
				client_version: "25",
				push_poll_id: "pollid01",
				push_poll_data: [
					{
						most_recent_operation_transaction_id: "4567",
						operations: [EDIT_OP],
					},
				],
				timezone: "America/New_York",
				crosscheck_user_id: "123",
			},
		);
		expect(form(second)).toStrictEqual(
			{
				...form(first),
				is_redo: "true",
			},
		);
		expect(sleeps).toStrictEqual([5000]);
	});

	it("gives up with TransportError after two redos", async () =>
	{
		const {api, pusher, sleeps} = await bootstrapped();
		api.respond(
			"/push_and_poll",
			() =>
				new Response(
					"bad gateway",
					{
						status: 502,
					},
				),
		);

		await expect(
			pusher.pushAndPoll(
				{
					ops: [EDIT_OP],
				},
			),
		).rejects.toThrow(TransportError);
		expect(pushes(api.requests).map((r) => form(r).push_poll_id)).toStrictEqual([
			"pollid01",
			"pollid01",
			"pollid01",
		]);
		expect(pushes(api.requests).map((r) => form(r).is_redo)).toStrictEqual([undefined, "true", "true"]);
		expect(sleeps).toStrictEqual([5000, 5000]);
		expect(pusher.txId).toBe("4567");
	});

	it("retries account_is_busy as a fresh push after a 5s backoff", async () =>
	{
		const {api, pusher, sleeps} = await bootstrapped();
		api.respondOnce("/push_and_poll", () =>
			json(
				{
					results: [
						{
							error: "account_is_busy",
							new_most_recent_operation_transaction_id: "4567",
						},
					],
				},
			),
		);
		api.respondOnce("/push_and_poll", pushOk("4568"));

		const result = await pusher.pushAndPoll(
			{
				ops: [EDIT_OP],
			},
		);

		expect(result.txId).toBe("4568");
		expect(pushes(api.requests).map((r) => [form(r).push_poll_id, form(r).is_redo])).toStrictEqual([
			["pollid01", undefined],
			["pollid02", undefined],
		]);
		expect(sleeps).toStrictEqual([5000]);
	});

	it("throws AccountBusy after three busy retries", async () =>
	{
		const {api, pusher, sleeps} = await bootstrapped();
		api.respond("/push_and_poll", () =>
			json(
				{
					results: [
						{
							error: "account_is_busy",
							new_most_recent_operation_transaction_id: "4567",
						},
					],
				},
			),
		);

		await expect(
			pusher.pushAndPoll(
				{
					ops: [EDIT_OP],
				},
			),
		).rejects.toThrow(AccountBusy);
		expect(pushes(api.requests)).toHaveLength(4);
		expect(sleeps).toStrictEqual([5000, 5000, 5000]);
	});

	it("retries push_lock_timeout like account_is_busy", async () =>
	{
		const {api, pusher, sleeps} = await bootstrapped();
		api.respondOnce("/push_and_poll", () =>
			json(
				{
					push_lock_timeout: true,
					results: [],
				},
			),
		);
		api.respondOnce("/push_and_poll", pushOk("4568"));

		expect(
			(
				await pusher.pushAndPoll(
					{
						ops: [EDIT_OP],
					},
				)
			).txId,
		).toBe("4568");
		expect(pushes(api.requests).map((r) => form(r).push_poll_id)).toStrictEqual(["pollid01", "pollid02"]);
		expect(sleeps).toStrictEqual([5000]);
	});

	it("throws PushLockTimeout once retries run out", async () =>
	{
		const {api, pusher} = await bootstrapped();
		api.respond("/push_and_poll", () =>
			json(
				{
					push_lock_timeout: true,
					results: [],
				},
			),
		);

		await expect(
			pusher.pushAndPoll(
				{
					ops: [EDIT_OP],
				},
			),
		).rejects.toThrow(PushLockTimeout);
		expect(pushes(api.requests)).toHaveLength(4);
	});

	it("throws OperationRejected carrying the server error, with no retry", async () =>
	{
		const {api, pusher, sleeps} = await bootstrapped();
		api.respond("/push_and_poll", () =>
			json(
				{
					results: [
						{
							error: "anything",
							new_most_recent_operation_transaction_id: "4567",
						},
					],
				},
			),
		);

		const error: unknown = await pusher
			.pushAndPoll(
				{
					ops: [EDIT_OP],
				},
			)
			.catch((e: unknown) => e);

		expect(error).toBeInstanceOf(OperationRejected);
		expect((error as OperationRejected).serverError).toBe("anything");
		expect(pushes(api.requests)).toHaveLength(1);
		expect(sleeps).toStrictEqual([]);
	});

	it("throws OperationRejected for the live error-only result that carries no transaction id", async () =>
	{
		const {api, pusher} = await bootstrapped();
		api.respond("/push_and_poll", () =>
			json(
				{
					results: [
						{
							error: "error_encountered_running_operations",
						},
					],
				},
			),
		);

		const error: unknown = await pusher
			.pushAndPoll(
				{
					ops: [EDIT_OP],
				},
			)
			.catch((e: unknown) => e);

		expect(error).toBeInstanceOf(OperationRejected);
		expect((error as OperationRejected).serverError).toBe("error_encountered_running_operations");
		expect(pushes(api.requests)).toHaveLength(1);
	});

	it("rejects pushed ops when the server returns no server_run transaction", async () =>
	{
		const {api, pusher} = await bootstrapped();
		api.respond("/push_and_poll", () =>
			json(
				{
					results: [
						{
							new_most_recent_operation_transaction_id: "4568",
						},
					],
				},
			),
		);

		const error: unknown = await pusher
			.pushAndPoll(
				{
					ops: [EDIT_OP],
				},
			)
			.catch((e: unknown) => e);

		expect(error).toBeInstanceOf(OperationRejected);
		expect((error as OperationRejected).serverError).toBe("missing server_run");
		expect(pushes(api.requests)).toHaveLength(1);
		expect(pusher.txId).toBe("4567");
	});

	it("throws CaptchaRequired after one request and never retries", async () =>
	{
		const {api, pusher, sleeps} = await bootstrapped();
		api.respond("/push_and_poll", () =>
			json(
				{
					question: "do_androids_dream_of_electric_sheep?",
				},
			),
		);

		await expect(
			pusher.pushAndPoll(
				{
					ops: [EDIT_OP],
				},
			),
		).rejects.toThrow(CaptchaRequired);
		expect(pushes(api.requests)).toHaveLength(1);
		expect(sleeps).toStrictEqual([]);
	});

	it("re-logs in once on logged_out and redoes the same push", async () =>
	{
		const {api, pusher} = await bootstrapped();
		api.respondOnce("/push_and_poll", () =>
			json(
				{
					logged_out: true,
				},
			),
		);
		api.respondOnce("/push_and_poll", pushOk("4568"));

		expect(
			(
				await pusher.pushAndPoll(
					{
						ops: [EDIT_OP],
					},
				)
			).txId,
		).toBe("4568");
		expect(api.requests.map((r) => r.path)).toStrictEqual([
			"/ajax_login",
			"/get_initialization_data",
			"/push_and_poll",
			"/ajax_login",
			"/push_and_poll",
		]);
		expect(pushes(api.requests).map((r) => [form(r).push_poll_id, form(r).is_redo])).toStrictEqual([
			["pollid01", undefined],
			["pollid01", "true"],
		]);
	});

	it("throws LoggedOut when the session is rejected again after re-login", async () =>
	{
		const {api, pusher} = await bootstrapped();
		api.respond(
			"/push_and_poll",
			() =>
				new Response(
					"",
					{
						status: 302,
						headers:
						{
							location: "/login/",
						},
					},
				),
		);

		await expect(
			pusher.pushAndPoll(
				{
					ops: [EDIT_OP],
				},
			),
		).rejects.toThrow(LoggedOut);
		expect(api.requests.map((r) => r.path)).toStrictEqual([
			"/ajax_login",
			"/get_initialization_data",
			"/push_and_poll",
			"/ajax_login",
			"/push_and_poll",
		]);
	});

	it("refuses to push before the client has bootstrapped", async () =>
	{
		const {client} = setup();
		const {pusher} = pusherFor(client);

		await expect(pusher.pushAndPoll()).rejects.toThrow(
			new Error("PushAndPoll needs a bootstrapped session; call client.bootstrap() first"),
		);
	});
});
