import {describe, expect, it} from "vite-plus/test";
import {SessionRejectedError, WorkflowyInternalClient} from "../src/api/workflowy-internal-client.js";
import {InternalApiError} from "../src/internal/errors.js";
import
{
	createFakeInternalApi,
	FAKE_CLIENT_ID,
	FAKE_SESSION_ID,
	initializationData,
	json,
} from "./helpers/fake-internal-api.js";

const TRANSIENT_ID = "6f1c1d1e-0000-4000-8000-000000000001";
const BASE_URL = "https://workflowy.test";

function clientWith(api = createFakeInternalApi())
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
	return {
		api,
		client,
	};
}

const EXPECTED_SESSION =
{
	clientId: FAKE_CLIENT_ID,
	clientVersion: "25",
	userId: 123,
	ownerId: 123,
	dateJoinedSec: 1_500_000_000,
	txId: "4567",
	rootMetadata:
	{
		starring:
		{
			locations:
			{
				abc: "None",
			},
		},
	},
	settings:
	{
		theme: "dark",
		show_completed: true,
	},
	expandedKeys: ["1a2b3c4d"],
	visibleFeatures: [],
};

const INIT_HEADERS =
{
	cookie: `sessionid=${FAKE_SESSION_ID}`,
	accept: "application/json",
	"x-requested-with": "XMLHttpRequest",
	"wf-transient-id": TRANSIENT_ID,
};

describe("WorkflowyInternalClient.bootstrap", () =>
{
	it("logs in, then fetches initialization data once and parses the session", async () =>
	{
		const {api, client} = clientWith();

		const session = await client.bootstrap();

		expect(session).toStrictEqual(EXPECTED_SESSION);
		expect(api.requests.map((r) => [r.method, r.path])).toStrictEqual([
			["POST", "/ajax_login"],
			["GET", "/get_initialization_data"],
		]);
		const init = api.requests[1];
		expect(init?.url).toBe(
			`${BASE_URL}/get_initialization_data?client_version=21&client_version_v2=28&no_root_children=1`,
		);
		expect(init?.headers).toStrictEqual(INIT_HEADERS);
	});

	it("fails loudly, without downloading the tree, when init has no transaction id", async () =>
	{
		const api = createFakeInternalApi();
		const data = initializationData();
		const tree = (
			data.projectTreeData as
			{
				mainProjectTreeInfo: Record<string, unknown>;
			}
		).mainProjectTreeInfo;
		delete tree.initialMostRecentOperationTransactionId;
		api.respond("/get_initialization_data", () =>
			json(
				data,
				{
					headers:
					{
						wfclientid: FAKE_CLIENT_ID,
					},
				},
			),
		);
		const {client} = clientWith(api);

		const error = await client.bootstrap().catch((thrown: unknown) => thrown);

		expect(error).toStrictEqual(
			new InternalApiError(
				"get_initialization_data omitted projectTreeData.mainProjectTreeInfo.initialMostRecentOperationTransactionId",
			),
		);
		expect(error).toBeInstanceOf(InternalApiError);
		expect(api.requests.map((r) => [r.method, r.path])).toStrictEqual([
			["POST", "/ajax_login"],
			["GET", "/get_initialization_data"],
		]);
	});

	it("reads user, settings, root metadata and globals from /get_user_data/ when init omits them (live shape)", async () =>
	{
		const api = createFakeInternalApi();
		const data = initializationData(
			{
				isReadOnly: null,
			},
		);
		const treeData = data.projectTreeData as Record<string, unknown>;
		delete treeData.rootProjectMetadata;
		delete data.settings;
		delete data.user;
		delete data.globals;
		delete data.features;
		api.respond("/get_initialization_data", () =>
			json(
				data,
				{
					headers:
					{
						wfclientid: FAKE_CLIENT_ID,
					},
				},
			),
		);
		api.respond("/get_user_data/", () =>
			json(
				{
					user:
					{
						id: 123,
						email: "alice@example.com",
					},
					globals: [["SHOW_COMPLETED_DEFAULT", true]],
					settings:
					{
						theme: "dark",
						show_completed: true,
					},
					features: [],
					rootProjectMetadata:
					{
						starring:
						{
							locations:
							{
								abc: "None",
							},
						},
					},
				},
			),
		);
		const {client} = clientWith(api);

		const session = await client.bootstrap();

		expect(session).toStrictEqual(
			{
				...EXPECTED_SESSION,
				clientVersion: "21",
			},
		);
		expect(api.requests.map((r) => [r.method, r.path])).toStrictEqual([
			["POST", "/ajax_login"],
			["GET", "/get_initialization_data"],
			["GET", "/get_user_data/"],
		]);
		expect(api.requests[2]?.headers).toStrictEqual(INIT_HEADERS);
	});

	it("parses the visible feature list from the init data, keeping only codename, name, label and description", async () =>
	{
		const api = createFakeInternalApi();
		const data = initializationData();
		data.features = [
			{
				codename: "bdl",
				name: "Backlinks",
				label: null,
				description: "d",
				beta: true,
				workflowy_dev: false,
			},
			{
				codename: "dashboards",
				name: "Dashboard layout",
				label: "LABS",
				description: "x",
			},
			{
				codename: "bare",
				name: "Bare",
			},
		];
		api.respond("/get_initialization_data", () =>
			json(
				data,
				{
					headers:
					{
						wfclientid: FAKE_CLIENT_ID,
					},
				},
			),
		);
		const {client} = clientWith(api);

		const session = await client.bootstrap();

		expect(session.visibleFeatures).toStrictEqual([
			{
				codename: "bdl",
				name: "Backlinks",
				label: null,
				description: "d",
			},
			{
				codename: "dashboards",
				name: "Dashboard layout",
				label: "LABS",
				description: "x",
			},
			{
				codename: "bare",
				name: "Bare",
				label: null,
				description: null,
			},
		]);
	});

	it("parses the visible feature list from /get_user_data/ on the live shape, and gives [] without one", async () =>
	{
		const api = createFakeInternalApi();
		const data = initializationData();
		delete data.user;
		api.respond("/get_initialization_data", () =>
			json(
				data,
				{
					headers:
					{
						wfclientid: FAKE_CLIENT_ID,
					},
				},
			),
		);
		api.respond("/get_user_data/", () =>
			json(
				{
					user:
					{
						id: 123,
					},
					features: [
						{
							codename: "dates",
							name: "Dates",
							label: null,
							description: "d",
						},
					],
				},
			),
		);
		const {client} = clientWith(api);

		const session = await client.bootstrap();

		expect(session.visibleFeatures).toStrictEqual([
			{
				codename: "dates",
				name: "Dates",
				label: null,
				description: "d",
			},
		]);
		const bare = createFakeInternalApi();
		const noFeatures = initializationData();
		delete noFeatures.features;
		bare.respond("/get_initialization_data", () =>
			json(
				noFeatures,
				{
					headers:
					{
						wfclientid: FAKE_CLIENT_ID,
					},
				},
			),
		);
		await expect(clientWith(bare).client.bootstrap()).resolves.toMatchObject(
			{
				visibleFeatures: [],
			},
		);
	});

	it("carries the user's entropyKey (salt of upstream's deterministic ids) when the server sends one", async () =>
	{
		const api = createFakeInternalApi();
		const data = initializationData();
		data.user =
		{
			id: 123,
			email: "alice@example.com",
			entropyKey: "k".repeat(64),
		};
		api.respond("/get_initialization_data", () =>
			json(
				data,
				{
					headers:
					{
						wfclientid: FAKE_CLIENT_ID,
					},
				},
			),
		);
		const {client} = clientWith(api);

		const session = await client.bootstrap();

		expect(session).toStrictEqual(
			{
				...EXPECTED_SESSION,
				entropyKey: "k".repeat(64),
			},
		);
	});

	it("carries the user's fullName, and parses a null one", async () =>
	{
		const named = createFakeInternalApi();
		const data = initializationData();
		data.user =
		{
			id: 123,
			email: "alice@example.com",
			fullName: "Alice Smith",
		};
		named.respond("/get_initialization_data", () =>
			json(
				data,
				{
					headers:
					{
						wfclientid: FAKE_CLIENT_ID,
					},
				},
			),
		);
		const unnamed = createFakeInternalApi();
		const nullData = initializationData();
		nullData.user =
		{
			id: 123,
			email: "alice@example.com",
			fullName: null,
		};
		unnamed.respond("/get_initialization_data", () =>
			json(
				nullData,
				{
					headers:
					{
						wfclientid: FAKE_CLIENT_ID,
					},
				},
			),
		);

		await expect(clientWith(named).client.bootstrap()).resolves.toStrictEqual(
			{
				...EXPECTED_SESSION,
				fullName: "Alice Smith",
			},
		);
		await expect(clientWith(unnamed).client.bootstrap()).resolves.toStrictEqual(EXPECTED_SESSION);
	});

	it("accepts a null isReadOnly (sent live) and a null ownerId", async () =>
	{
		const api = createFakeInternalApi();
		const data = initializationData();
		const tree = (
			data.projectTreeData as
			{
				mainProjectTreeInfo: Record<string, unknown>;
			}
		).mainProjectTreeInfo;
		tree.isReadOnly = null;
		tree.ownerId = null;
		api.respond("/get_initialization_data", () =>
			json(
				data,
				{
					headers:
					{
						wfclientid: FAKE_CLIENT_ID,
					},
				},
			),
		);
		const {client} = clientWith(api);

		const session = await client.bootstrap();

		expect(session).toStrictEqual(EXPECTED_SESSION);
	});

	it("reuses the session cookie on a second bootstrap and sends the learned client version", async () =>
	{
		const {api, client} = clientWith();

		await client.bootstrap();
		const second = await client.bootstrap();

		expect(second).toStrictEqual(EXPECTED_SESSION);
		expect(api.requests.map((r) => [r.method, r.path])).toStrictEqual([
			["POST", "/ajax_login"],
			["GET", "/get_initialization_data"],
			["GET", "/get_initialization_data"],
		]);
		expect(api.requests[2]?.url).toBe(
			`${BASE_URL}/get_initialization_data?client_version=25&client_version_v2=28&no_root_children=1`,
		);
		expect(client.session).toStrictEqual(EXPECTED_SESSION);
	});

	it("re-logs in exactly once when init redirects to the login page", async () =>
	{
		const {api, client} = clientWith();
		api.respondOnce(
			"/get_initialization_data",
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

		const session = await client.bootstrap();

		expect(session).toStrictEqual(EXPECTED_SESSION);
		expect(api.requests.map((r) => [r.method, r.path])).toStrictEqual([
			["POST", "/ajax_login"],
			["GET", "/get_initialization_data"],
			["POST", "/ajax_login"],
			["GET", "/get_initialization_data"],
		]);
	});

	it("re-logs in exactly once when init reports logged_out", async () =>
	{
		const {api, client} = clientWith();
		api.respondOnce("/get_initialization_data", () =>
			json(
				{
					logged_out: true,
				},
			),
		);

		const session = await client.bootstrap();

		expect(session).toStrictEqual(EXPECTED_SESSION);
		expect(api.requests.map((r) => [r.method, r.path])).toStrictEqual([
			["POST", "/ajax_login"],
			["GET", "/get_initialization_data"],
			["POST", "/ajax_login"],
			["GET", "/get_initialization_data"],
		]);
	});

	it("gives up after one re-login when the session keeps being rejected", async () =>
	{
		const {api, client} = clientWith();
		api.respond("/get_initialization_data", () =>
			json(
				{
					logged_out: true,
				},
			),
		);

		await expect(client.bootstrap()).rejects.toThrow(new SessionRejectedError("logged_out"));
		expect(api.requests.map((r) => [r.method, r.path])).toStrictEqual([
			["POST", "/ajax_login"],
			["GET", "/get_initialization_data"],
			["POST", "/ajax_login"],
			["GET", "/get_initialization_data"],
		]);
	});
});
