import {createServer} from "node:http";
import type {ServerResponse} from "node:http";
import type {AddressInfo} from "node:net";

export interface FakeNode
{
	id: string;
	name: string;
	note: string | null;
	parent_id: string | null;
	priority: number;
	createdAt: number;
	modifiedAt: number;
}

export interface RecordedRequest
{
	method: string | undefined;
	path: string;
	body: unknown;
}

export interface FakeUpstream
{
	url: string;
	nodes: Map<string, FakeNode>;
	requests: RecordedRequest[];
	close(): Promise<void>;
}

const homeId = "00000000-0000-4000-8000-000000000001";

function seedNodes(): Map<string, FakeNode>
{
	const base =
	{
		note: null,
		createdAt: 1000,
		modifiedAt: 2000,
	};
	const nodes: FakeNode[] = [
		{
			...base,
			id: homeId,
			name: "Smoke home",
			parent_id: null,
			priority: 0,
		},
		{
			...base,
			id: "00000000-0000-4000-8000-000000000002",
			name: "Alpha task",
			parent_id: homeId,
			priority: 0,
		},
		{
			...base,
			id: "00000000-0000-4000-8000-000000000003",
			name: "Beta task",
			parent_id: homeId,
			priority: 1,
		},
	];
	return new Map(nodes.map((n) => [n.id, n]));
}

function send(res: ServerResponse, value: unknown, status = 200): void
{
	res.writeHead(
		status,
		{
			"content-type": "application/json",
		},
	);
	res.end(JSON.stringify(value));
}

/** An in-memory stand-in for the Workflowy API: the export, node reads and node updates the Worker calls. Never contacts the real service. */
export async function startFakeUpstream(): Promise<FakeUpstream>
{
	const nodes = seedNodes();
	const requests: RecordedRequest[] = [];
	const server = createServer((req, res) =>
	{
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) =>
		{
			chunks.push(chunk);
		});
		req.on("end", () =>
		{
			const url = new URL(req.url ?? "/", "http://fake");
			const text = Buffer.concat(chunks).toString("utf8");
			const body: unknown = text === "" ? undefined : JSON.parse(text);
			requests.push(
				{
					method: req.method,
					path: url.pathname,
					body,
				},
			);
			if (url.pathname === "/api/v1/nodes-export")
			{
				send(
					res,
					{
						nodes: [...nodes.values()],
					},
				);
				return;
			}
			const id = /^\/api\/v1\/nodes\/([^/]+)$/u.exec(url.pathname)?.[1];
			const node = id === undefined ? undefined : nodes.get(id);
			if (node === undefined)
			{
				send(
					res,
					{
						error: `unexpected ${req.method} ${url.pathname}`,
					},
					404,
				);
			}
			else if (req.method === "POST")
			{
				Object.assign(
					node,
					body,
					{
						modifiedAt: node.modifiedAt + 1,
					},
				);
				send(
					res,
					{
						status: "ok",
					},
				);
			}
			else
			{
				send(
					res,
					{
						node,
					},
				);
			}
		});
	});
	await new Promise<void>((resolve) =>
	{
		server.listen(0, "127.0.0.1", resolve);
	});
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- listening on a TCP port yields an AddressInfo
	const {port} = server.address() as AddressInfo;
	return {
		url: `http://127.0.0.1:${port}`,
		nodes,
		requests,
		close: async () =>
			new Promise<void>((resolve) =>
			{
				server.close(() =>
				{
					resolve();
				});
			}),
	};
}
