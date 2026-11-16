import
{
	ApiResponseSchema,
	CompletionStatusResponseSchema,
	CreateMirrorResponseSchema,
	CreateNodeResponseSchema,
	GetNodeResponseSchema,
} from "../types/workflowy.js";
import type {WorkflowyNode} from "../types/workflowy.js";

/**
 * Optional logger interface for API request/response logging.
 * Implement this interface to enable verbose logging.
 */
export interface ApiLogger
{
	logRequest(url: string, method: string, body?: unknown): void;
	logResponse(url: string, method: string, status: number, statusText: string, data: unknown, duration: number): void;
	logError(url: string, method: string, error: unknown, duration: number): void;
}

/**
 * Each address undici reports in a connect failure's cause ("attempted
 * address: 75.2.70.75:443" or "attempted addresses: 2600::1:443, 99.83.1.1:443"),
 * labelled with its family. Empty when the cause names no address.
 */
function dialedAddresses(causeMessage: string): string[]
{
	const listed = /attempted address(?:es)?: (?<list>.*?)(?:, timeout: |\)|$)/u.exec(causeMessage)?.groups?.list;
	if (!listed)
	{
		return [];
	}
	return listed.split(", ").map((address) =>
	{
		const host = address.replace(/:\d+$/u, "").replaceAll(/^\[|\]$/gu, "");
		return `${address} (${host.includes(":") ? "IPv6" : "IPv4"})`;
	});
}

/**
 * Replace fetch's bare "fetch failed" with the request, the elapsed time, and
 * the undici cause (its code, message, and the dialed addresses with their
 * family), keeping the original as `cause`. A connect timeout curl cannot
 * reproduce is only diagnosable from which address and family Node dialed.
 */
function describeFetchError(method: string, url: string, elapsedMs: number, error: unknown): Error
{
	const cause = error instanceof Error ? error.cause : undefined;
	const detail = cause instanceof Error ? cause : error instanceof Error ? error : new Error(String(error));
	const code = "code" in detail && typeof detail.code === "string" ? `${detail.code} ` : "";
	const dialed = dialedAddresses(detail.message);
	const suffix = dialed.length > 0 ? ` [dialed ${dialed.join(", ")}]` : "";
	return new Error(
		`${method} ${url} failed after ${Math.round(elapsedMs)}ms: ${code}${detail.message}${suffix}`,
		{
			cause: error,
		},
	);
}

/**
 * Cap on how much of an error response body is quoted back. Enough for
 * Workflowy's block notice, short of pasting an HTML error page into a stack
 * trace.
 */
const MAX_ERROR_BODY_CHARS = 500;

function retryAfterSeconds(value: unknown): number | undefined
{
	if (value === null || value === undefined || value === "")
	{
		return undefined;
	}
	const seconds = Number(value);
	return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

/** The `retry_after` seconds in a throttled response's JSON body, if any. */
async function bodyRetryAfterSeconds(response: Response): Promise<number | undefined>
{
	try
	{
		const body: unknown = await response.json();
		return typeof body === "object" && body !== null && "retry_after" in body
			? retryAfterSeconds(body.retry_after)
			: undefined;
	}
	catch
	{
		return undefined;
	}
}

/**
 * Request object for creating a new node.
 */
export interface CreateNodeRequest
{
	/**
	 * The parent node ID. Can be either:
	 * - A UUID (e.g., "a5408f02-03aa-4735-a886-4ccd128d1ad7")
	 * - A system target key (e.g., "inbox")
	 * - `null` for Home (the top level), sent by omitting `parent_id`
	 *
	 * Use isSystemTarget() to check if a string is a valid target key.
	 */
	parent_id: string | null;
	name: string;
	note?: string;
	layoutMode?: string;
	position?: "top" | "bottom";
}

/**
 * Request object for updating an existing node.
 */
export interface UpdateNodeRequest
{
	name?: string;
	note?: string;
	layoutMode?: string;
}

/**
 * Result of creating a mirror. `originId` is the true origin, which differs
 * from the requested node when that node was itself a mirror.
 */
export interface CreateMirrorResult
{
	mirrorId: string;
	originId: string;
}

/**
 * Unified Workflowy API client for interacting with the Workflowy API.
 *
 * Supports optional logging via dependency injection.
 */
export class WorkflowyApiClient
{
	private readonly logger?: ApiLogger;
	private readonly baseUrl: string;

	constructor(
		private readonly apiKey: string,
		logger?: ApiLogger,
		baseUrl?: string,
	)
	{
		this.logger = logger;
		this.baseUrl = baseUrl ?? "https://workflowy.com";
	}

	/**
	 * Build an error carrying the server's own explanation, not just the status
	 * line. Workflowy puts the only actionable detail in the response body -- an
	 * abuse-protection 403 names the support address, the blocked IP, and a
	 * reference code. Reporting a bare "403" makes an IP block indistinguishable
	 * from a bad key, an expired token, or an exhausted quota.
	 */
	private async describeFailure(prefix: string, response: Response): Promise<Error>
	{
		const statusLine = `${prefix}: ${response.status} ${response.statusText}`;

		let body: string;
		try
		{
			body = (await response.text()).trim();
		}
		catch
		{
			return new Error(statusLine);
		}

		if (!body)
		{
			return new Error(statusLine);
		}

		return new Error(`${statusLine}\n${body.slice(0, MAX_ERROR_BODY_CHARS)}`);
	}

	/** A fetch whose network failures name the request, elapsed time, and dialed address. */
	private async send(url: string, init?: RequestInit): Promise<Response>
	{
		const startTime = performance.now();
		try
		{
			return await fetch(url, init);
		}
		catch (error)
		{
			throw describeFetchError(init?.method ?? "GET", url, performance.now() - startTime, error);
		}
	}

	private getHeaders(): Record<string, string>
	{
		return {
			Authorization: `Bearer ${this.apiKey}`,
			"Content-Type": "application/json",
		};
	}

	/**
	 * Perform a fetch once. A 429 throws an error naming the wait Workflowy asked
	 * for (the Retry-After header, else the body's `retry_after` seconds, e.g.
	 * `{"retry_after": 9}`), so the caller sees the throttle instead of stalling
	 * through hidden backoff. Other responses are returned as-is for the caller
	 * to validate.
	 */
	private async fetchOnce(url: string, init?: RequestInit): Promise<Response>
	{
		const response = await this.send(url, init);
		if (response.status !== 429)
		{
			return response;
		}
		const seconds =
			retryAfterSeconds(response.headers.get("retry-after")) ?? (await bodyRetryAfterSeconds(response));
		const wait = seconds === undefined ? "it named no wait time" : `wait ${seconds}s before trying again`;
		throw new Error(
			`Workflowy rate limit: ${init?.method ?? "GET"} ${url} answered ${response.status} ${response.statusText}; ${wait}`,
		);
	}

	private async fetchNodes(url: string): Promise<WorkflowyNode[]>
	{
		const startTime = performance.now();
		this.logger?.logRequest(url, "GET");

		try
		{
			const response = await this.fetchOnce(
				url,
				{
					headers: this.getHeaders(),
				},
			);

			if (!response.ok)
			{
				throw await this.describeFailure("API request failed", response);
			}

			const data: unknown = await response.json();
			const duration = performance.now() - startTime;
			this.logger?.logResponse(url, "GET", response.status, response.statusText, data, duration);

			const validatedResponse = ApiResponseSchema.parse(data);
			return validatedResponse.nodes ?? [];
		}
		catch (error)
		{
			const duration = performance.now() - startTime;
			this.logger?.logError(url, "GET", error, duration);
			throw error;
		}
	}

	/**
	 * Get all root-level nodes.
	 */
	async getRootNodes(): Promise<WorkflowyNode[]>
	{
		return this.fetchNodes(`${this.baseUrl}/api/v1/nodes`);
	}

	/**
	 * Get all child nodes of a given parent.
	 *
	 * @param parentId - The parent ID (UUID or system target key like "inbox")
	 */
	async getChildNodes(parentId: string): Promise<WorkflowyNode[]>
	{
		return this.fetchNodes(`${this.baseUrl}/api/v1/nodes?parent_id=${parentId}`);
	}

	/**
	 * Get a single child node by exact name match.
	 * Note: API still fetches all children (no server-side filtering available),
	 * but filters with exact match for consistency with CacheService.
	 * @param parentId The parent ID (null for root nodes)
	 * @param name The exact name to match
	 */
	async getChildByName(parentId: string | null, name: string): Promise<WorkflowyNode | null>
	{
		const children = parentId ? await this.getChildNodes(parentId) : await this.getRootNodes();

		return children.find((child) => child.name === name) ?? null;
	}

	/**
	 * Get a single node by ID.
	 */
	async getNode(nodeId: string): Promise<WorkflowyNode>
	{
		const node = await this.findNode(nodeId);
		if (node === null)
		{
			throw new Error(`Failed to get node: 404 Not Found (${nodeId})`);
		}
		return node;
	}

	/**
	 * Get a single node by ID, or `null` when Workflowy answers 404 (the node
	 * is deleted or never existed). Use it to check liveness against a cache
	 * that may be stale.
	 */
	async findNode(nodeId: string): Promise<WorkflowyNode | null>
	{
		const url = `${this.baseUrl}/api/v1/nodes/${nodeId}`;
		const startTime = performance.now();
		this.logger?.logRequest(url, "GET");

		try
		{
			const response = await this.fetchOnce(
				url,
				{
					headers: this.getHeaders(),
				},
			);

			if (response.status === 404)
			{
				this.logger?.logResponse(
					url,
					"GET",
					response.status,
					response.statusText,
					null,
					performance.now() - startTime,
				);
				return null;
			}
			if (!response.ok)
			{
				throw await this.describeFailure("Failed to get node", response);
			}

			const data: unknown = await response.json();
			const duration = performance.now() - startTime;
			this.logger?.logResponse(url, "GET", response.status, response.statusText, data, duration);

			const getResponse = GetNodeResponseSchema.parse(data);
			return getResponse.node;
		}
		catch (error)
		{
			const duration = performance.now() - startTime;
			this.logger?.logError(url, "GET", error, duration);
			throw error;
		}
	}

	/**
	 * Create a new node.
	 *
	 * @param request - The node creation request. The parent_id can be a UUID or
	 *   a system target key like "inbox". Use isSystemTarget() to check if a
	 *   string is a valid target key.
	 * @returns The created node, constructed from request data without a GET, so its
	 *   `priority` is a placeholder; read the node back for the one Workflowy assigned
	 */
	async createNode(request: CreateNodeRequest): Promise<WorkflowyNode>
	{
		const url = `${this.baseUrl}/api/v1/nodes/`;
		const {parent_id: parentId, ...rest} = request;
		// The API has no key for Home: a top-level create omits parent_id.
		const body = parentId === null ? rest : request;
		const startTime = performance.now();
		this.logger?.logRequest(url, "POST", body);

		try
		{
			const response = await this.send(
				url,
				{
					method: "POST",
					headers: this.getHeaders(),
					body: JSON.stringify(body),
				},
			);

			if (!response.ok)
			{
				throw await this.describeFailure("Failed to create node", response);
			}

			const data: unknown = await response.json();
			const duration = performance.now() - startTime;
			this.logger?.logResponse(url, "POST", response.status, response.statusText, data, duration);

			const createResponse = CreateNodeResponseSchema.parse(data);
			const now = Math.floor(Date.now() / 1000);

			// Construct node from request data (no GET needed)
			// For multiline input, API creates parent + children; we return the parent info
			const nodeName = (request.name.split("\n")[0] ?? "").replace(/^- /u, "");

			return {
				id: createResponse.item_id,
				name: nodeName,
				note: request.note ?? null,
				parent_id: request.parent_id,
				priority: request.position === "top" ? -1 : 0,
				completed: false,
				data: request.layoutMode
					?
						{
							layoutMode: request.layoutMode,
						}
					: undefined,
				createdAt: now,
				modifiedAt: now,
				completedAt: null,
			};
		}
		catch (error)
		{
			const duration = performance.now() - startTime;
			this.logger?.logError(url, "POST", error, duration);
			throw error;
		}
	}

	/**
	 * Update an existing node.
	 *
	 * @param id - The node ID to update
	 * @param request - The fields to update (name, note, layoutMode)
	 */
	async updateNode(id: string, request: UpdateNodeRequest): Promise<void>
	{
		const url = `${this.baseUrl}/api/v1/nodes/${id}`;
		const startTime = performance.now();
		this.logger?.logRequest(url, "POST", request);

		try
		{
			const response = await this.send(
				url,
				{
					method: "POST",
					headers: this.getHeaders(),
					body: JSON.stringify(request),
				},
			);

			if (!response.ok)
			{
				throw await this.describeFailure("Failed to update node", response);
			}

			const data: unknown = await response.json();
			const duration = performance.now() - startTime;
			this.logger?.logResponse(url, "POST", response.status, response.statusText, data, duration);

			CompletionStatusResponseSchema.parse(data);
		}
		catch (error)
		{
			const duration = performance.now() - startTime;
			this.logger?.logError(url, "POST", error, duration);
			throw error;
		}
	}

	/**
	 * Delete a node.
	 *
	 * @param id - The node ID to delete
	 */
	async deleteNode(id: string): Promise<void>
	{
		const url = `${this.baseUrl}/api/v1/nodes/${id}`;
		const startTime = performance.now();
		this.logger?.logRequest(url, "DELETE");

		try
		{
			const response = await this.send(
				url,
				{
					method: "DELETE",
					headers: this.getHeaders(),
				},
			);

			if (!response.ok)
			{
				throw await this.describeFailure("Failed to delete node", response);
			}

			const duration = performance.now() - startTime;
			this.logger?.logResponse(url, "DELETE", response.status, response.statusText, null, duration);
		}
		catch (error)
		{
			const duration = performance.now() - startTime;
			this.logger?.logError(url, "DELETE", error, duration);
			throw error;
		}
	}

	/**
	 * Mark a node as completed.
	 *
	 * @param id - The node ID to complete
	 */
	async completeNode(id: string): Promise<void>
	{
		const url = `${this.baseUrl}/api/v1/nodes/${id}/complete`;
		const startTime = performance.now();
		this.logger?.logRequest(url, "POST");

		try
		{
			const response = await this.send(
				url,
				{
					method: "POST",
					headers: this.getHeaders(),
				},
			);

			if (!response.ok)
			{
				throw await this.describeFailure("Failed to complete node", response);
			}

			const data: unknown = await response.json();
			const duration = performance.now() - startTime;
			this.logger?.logResponse(url, "POST", response.status, response.statusText, data, duration);

			CompletionStatusResponseSchema.parse(data);
		}
		catch (error)
		{
			const duration = performance.now() - startTime;
			this.logger?.logError(url, "POST", error, duration);
			throw error;
		}
	}

	/**
	 * Mark a node as not completed.
	 *
	 * @param id - The node ID to uncomplete
	 */
	async uncompleteNode(id: string): Promise<void>
	{
		const url = `${this.baseUrl}/api/v1/nodes/${id}/uncomplete`;
		const startTime = performance.now();
		this.logger?.logRequest(url, "POST");

		try
		{
			const response = await this.send(
				url,
				{
					method: "POST",
					headers: this.getHeaders(),
				},
			);

			if (!response.ok)
			{
				throw await this.describeFailure("Failed to uncomplete node", response);
			}

			const data: unknown = await response.json();
			const duration = performance.now() - startTime;
			this.logger?.logResponse(url, "POST", response.status, response.statusText, data, duration);

			CompletionStatusResponseSchema.parse(data);
		}
		catch (error)
		{
			const duration = performance.now() - startTime;
			this.logger?.logError(url, "POST", error, duration);
			throw error;
		}
	}

	/**
	 * Move a node to a new parent.
	 *
	 * @param id - The node ID to move
	 * @param newParentId - The target parent ID (null for Home, sent by omitting parent_id)
	 * @param position - Optional position ('top' for -1, 'bottom' for >= 0)
	 */
	async moveNode(id: string, newParentId: string | null, position?: number): Promise<void>
	{
		const url = `${this.baseUrl}/api/v1/nodes/${id}/move`;
		const body:
		{
			parent_id?: string;
			position?: string;
		} =
			newParentId === null
				? {}
				:
					{
						parent_id: newParentId,
					};
		if (position !== undefined)
		{
			body.position = position < 0 ? "top" : "bottom";
		}

		const startTime = performance.now();
		this.logger?.logRequest(url, "POST", body);

		try
		{
			const response = await this.send(
				url,
				{
					method: "POST",
					headers: this.getHeaders(),
					body: JSON.stringify(body),
				},
			);

			if (!response.ok)
			{
				throw await this.describeFailure("Failed to move node", response);
			}

			const data = await response.text();
			const duration = performance.now() - startTime;
			this.logger?.logResponse(url, "POST", response.status, response.statusText, data, duration);
		}
		catch (error)
		{
			const duration = performance.now() - startTime;
			this.logger?.logError(url, "POST", error, duration);
			throw error;
		}
	}

	/**
	 * Create a live mirror of a node under a new parent.
	 *
	 * @param originId - The node to mirror (a mirror resolves to its true origin)
	 * @param parentId - The parent to place the mirror under. The endpoint requires one,
	 *   so a mirror cannot be placed at Home (the top level)
	 * @param position - Where among the parent's children to place the mirror
	 */
	async createMirror(originId: string, parentId: string, position: "top" | "bottom"): Promise<CreateMirrorResult>
	{
		const url = `${this.baseUrl}/api/v1/nodes/${originId}/mirror`;
		const body =
		{
			parent_id: parentId,
			position,
		};
		const startTime = performance.now();
		this.logger?.logRequest(url, "POST", body);

		try
		{
			const response = await this.fetchOnce(
				url,
				{
					method: "POST",
					headers: this.getHeaders(),
					body: JSON.stringify(body),
				},
			);

			if (!response.ok)
			{
				throw await this.describeFailure("Failed to create mirror", response);
			}

			const data: unknown = await response.json();
			const duration = performance.now() - startTime;
			this.logger?.logResponse(url, "POST", response.status, response.statusText, data, duration);

			const parsed = CreateMirrorResponseSchema.parse(data);
			return {
				mirrorId: parsed.item_id,
				originId: parsed.origin_id,
			};
		}
		catch (error)
		{
			const duration = performance.now() - startTime;
			this.logger?.logError(url, "POST", error, duration);
			throw error;
		}
	}

	/**
	 * Remove a mirror root. The origin and its other mirrors are untouched.
	 *
	 * @param mirrorId - The mirror node to remove
	 */
	async deleteMirror(mirrorId: string): Promise<void>
	{
		const url = `${this.baseUrl}/api/v1/nodes/${mirrorId}/mirror`;
		const startTime = performance.now();
		this.logger?.logRequest(url, "DELETE");

		try
		{
			const response = await this.fetchOnce(
				url,
				{
					method: "DELETE",
					headers: this.getHeaders(),
				},
			);

			if (!response.ok)
			{
				throw await this.describeFailure("Failed to delete mirror", response);
			}

			const data = await response.text();
			const duration = performance.now() - startTime;
			this.logger?.logResponse(url, "DELETE", response.status, response.statusText, data, duration);
		}
		catch (error)
		{
			const duration = performance.now() - startTime;
			this.logger?.logError(url, "DELETE", error, duration);
			throw error;
		}
	}

	/**
	 * Export all nodes from Workflowy.
	 *
	 * This endpoint returns a flat list of all nodes with their parent_id field populated.
	 * Note: This endpoint has a rate limit of 1 request per minute.
	 *
	 * @returns Array of all nodes in the user's Workflowy account
	 */
	async exportAllNodes(): Promise<WorkflowyNode[]>
	{
		const url = `${this.baseUrl}/api/v1/nodes-export`;
		const startTime = performance.now();
		this.logger?.logRequest(url, "GET");

		try
		{
			const response = await this.fetchOnce(
				url,
				{
					headers: this.getHeaders(),
				},
			);

			if (!response.ok)
			{
				throw await this.describeFailure("API request failed", response);
			}

			const data: unknown = await response.json();
			const duration = performance.now() - startTime;
			this.logger?.logResponse(url, "GET", response.status, response.statusText, data, duration);

			const validatedResponse = ApiResponseSchema.parse(data);
			return validatedResponse.nodes ?? [];
		}
		catch (error)
		{
			const duration = performance.now() - startTime;
			this.logger?.logError(url, "GET", error, duration);
			throw error;
		}
	}

	/**
	 * Find a node by following a path of exact node names from root or a parent.
	 * Uses exact name matching for consistency with CacheService.
	 *
	 * @param path - Array of exact node names to traverse
	 * @param parentId - Optional starting parent ID (null for root)
	 * @returns The found node or null if not found
	 */
	async findNodeByPath(path: string[], parentId: string | null = null): Promise<WorkflowyNode | null>
	{
		let currentParent = parentId;
		let lastFoundNode: WorkflowyNode | null = null;

		for (const nodeName of path)
		{
			const node = await this.getChildByName(currentParent, nodeName);

			if (!node)
			{
				return null;
			}

			lastFoundNode = node;
			currentParent = node.id;
		}

		return lastFoundNode;
	}
}
