import {text} from "node:stream/consumers";
/**
 * Lightweight mock Workflowy HTTP server for behavioral evals.
 *
 * Handles create/delete/update/move/complete/uncomplete endpoints,
 * returning plausible success responses with generated UUIDs.
 * This allows eval bash commands that use write-through CLI commands
 * to succeed without a real Workflowy API key.
 */

import {randomUUID} from "node:crypto";
import http from "node:http";

export interface MockServerRequest
{
	method: string;
	url: string;
	body: unknown;
}

export interface MockWorkflowyServer
{
	port: number;
	requests: MockServerRequest[];
	start(): Promise<void>;
	stop(): Promise<void>;
}

export function createMockWorkflowyServer(): MockWorkflowyServer
{
	const requests: MockServerRequest[] = [];
	let server: http.Server | null = null;
	let port = 0;

	const handle = async (req: http.IncomingMessage, res: http.ServerResponse) =>
	{
		const url = req.url ?? "/";
		const method = req.method ?? "GET";

		// Read request body
		let body: unknown = null;
		if (method === "POST" || method === "PUT")
		{
			const raw = await text(req);
			try
			{
				body = JSON.parse(raw);
			}
			catch
			{
				body = raw;
			}
		}

		requests.push(
			{
				method,
				url,
				body,
			},
		);

		res.setHeader("Content-Type", "application/json");

		// Route handling
		if (method === "POST" && url === "/api/v1/nodes/")
		{
			// Create node
			const id = randomUUID();
			res.writeHead(200);
			res.end(
				JSON.stringify(
					{
						item_id: id,
					},
				),
			);
		}
		else if (method === "DELETE" && url.startsWith("/api/v1/nodes/"))
		{
			// Delete node
			res.writeHead(200);
			res.end(
				JSON.stringify(
					{
						status: "ok",
					},
				),
			);
		}
		else if (method === "POST" && url.match(/^\/api\/v1\/nodes\/[^/]+\/complete$/u))
		{
			// Complete node
			res.writeHead(200);
			res.end(
				JSON.stringify(
					{
						status: "ok",
					},
				),
			);
		}
		else if (method === "POST" && url.match(/^\/api\/v1\/nodes\/[^/]+\/uncomplete$/u))
		{
			// Uncomplete node
			res.writeHead(200);
			res.end(
				JSON.stringify(
					{
						status: "ok",
					},
				),
			);
		}
		else if (method === "POST" && url.match(/^\/api\/v1\/nodes\/[^/]+\/move$/u))
		{
			// Move node
			res.writeHead(200);
			res.end(
				JSON.stringify(
					{
						status: "ok",
					},
				),
			);
		}
		else if (method === "POST" && url.match(/^\/api\/v1\/nodes\/[^/]+$/u))
		{
			// Update node
			res.writeHead(200);
			res.end(
				JSON.stringify(
					{
						status: "ok",
					},
				),
			);
		}
		else if (method === "GET" && url.match(/^\/api\/v1\/nodes\/[^/]+$/u))
		{
			// Get node - return a plausible node response
			const nodeId = url.slice(url.lastIndexOf("/") + 1);
			const now = Math.floor(Date.now() / 1000);
			res.writeHead(200);
			res.end(
				JSON.stringify(
					{
						node:
						{
							id: nodeId,
							name: "Mock node",
							note: null,
							parent_id: null,
							priority: 0,
							completed: false,
							createdAt: now,
							modifiedAt: now,
							completedAt: null,
						},
					},
				),
			);
		}
		else if (method === "GET" && url === "/api/v1/targets")
		{
			// Get targets
			res.writeHead(200);
			res.end(
				JSON.stringify(
					{
						targets: [
							{
								name: "inbox",
								id: randomUUID(),
							},
						],
					},
				),
			);
		}
		else if (method === "GET" && url.startsWith("/api/v1/nodes"))
		{
			// List nodes
			res.writeHead(200);
			res.end(
				JSON.stringify(
					{
						nodes: [],
					},
				),
			);
		}
		else
		{
			res.writeHead(404);
			res.end(
				JSON.stringify(
					{
						error: "Not found",
					},
				),
			);
		}
	};

	async function start(): Promise<void>
	{
		return new Promise((resolve, reject) =>
		{
			const created = http.createServer((req, res) =>
			{
				void handle(req, res);
			});

			server = created;
			created.on("error", reject);

			// Listen on port 0 to get a random available port
			created.listen(0, "127.0.0.1", () =>
			{
				const addr = created.address();
				if (typeof addr === "object" && addr !== null)
				{
					port = addr.port;
				}
				resolve();
			});
		});
	}

	async function stop(): Promise<void>
	{
		return new Promise((resolve) =>
		{
			if (server)
			{
				server.close(() =>
				{
					resolve();
				});
			}
			else
			{
				resolve();
			}
		});
	}

	return {
		get port()
		{
			return port;
		},
		requests,
		start,
		stop,
	};
}
