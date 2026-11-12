import {vi} from "vite-plus/test";
import {z} from "zod";

const status = () =>
	Response.json(
		{
			status: "ok",
		},
	);

const BodySchema = z.record(z.string(), z.unknown());

export interface FakeNode
{
	id: string;
	name: string;
	note: string | null;
	parent_id: string | null;
	priority: number;
	createdAt: number;
	modifiedAt: number;
	completedAt: number | null;
}

/**
 * A public Workflowy API over an in-memory outline, installed as `globalThis.fetch`. Creates get ids `created-1`,
 * `created-2`, ... Returns the outline so a test can seed it and read what the writes left.
 */
export function stubPublicApi(seedNodes: FakeNode[] = []): Map<string, FakeNode>
{
	const nodes = new Map(
		seedNodes.map((node) => [
			node.id,
			{
				...node,
			},
		]),
	);
	let created = 0;
	const childrenOf = (parentId: string | null) =>
		[...nodes.values()].filter((node) => node.parent_id === parentId).toSorted((a, b) => a.priority - b.priority);
	vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) =>
	{
		const url = new URL(input instanceof Request ? input.url : String(input));
		const method = init?.method ?? "GET";
		const body = typeof init?.body === "string" ? BodySchema.parse(JSON.parse(init.body)) : {};
		const [, id, action] = /^\/api\/v1\/nodes\/?([^/]*)\/?([^/]*)$/u.exec(url.pathname) ?? [];
		if (id === undefined)
		{
			return Promise.resolve(
				new Response(
					"not found",
					{
						status: 404,
					},
				),
			);
		}
		if (id === "" && method === "GET")
		{
			return Promise.resolve(
				Response.json(
					{
						nodes: childrenOf(url.searchParams.get("parent_id")),
					},
				),
			);
		}
		if (id === "" && method === "POST")
		{
			created += 1;
			const parentId = typeof body.parent_id === "string" ? body.parent_id : null;
			const node: FakeNode =
			{
				id: `created-${created}`,
				name: String(body.name),
				note: typeof body.note === "string" ? body.note : null,
				parent_id: parentId,
				priority: body.position === "top" ? -1 : childrenOf(parentId).length,
				createdAt: 1_700_000_000,
				modifiedAt: 1_700_000_000,
				completedAt: null,
			};
			nodes.set(node.id, node);
			return Promise.resolve(
				Response.json(
					{
						item_id: node.id,
					},
				),
			);
		}
		const node = nodes.get(id);
		if (node === undefined)
		{
			return Promise.resolve(
				new Response(
					"not found",
					{
						status: 404,
					},
				),
			);
		}
		if (method === "GET")
		{
			return Promise.resolve(
				Response.json(
					{
						node,
					},
				),
			);
		}
		if (method === "DELETE")
		{
			nodes.delete(id);
			return Promise.resolve(status());
		}
		if (action === "complete" || action === "uncomplete")
		{
			node.completedAt = action === "complete" ? 1_700_000_100 : null;
			return Promise.resolve(status());
		}
		if (action === "move")
		{
			node.parent_id = typeof body.parent_id === "string" ? body.parent_id : null;
			node.priority = body.position === "top" ? -1 : childrenOf(node.parent_id).length;
			return Promise.resolve(
				Response.json(
					{
						status: "ok",
					},
				),
			);
		}
		if (typeof body.name === "string")
		{
			node.name = body.name;
		}
		if (typeof body.note === "string")
		{
			node.note = body.note;
		}
		return Promise.resolve(status());
	});
	return nodes;
}

/** A fake node with fixed timestamps. */
export function fakeNode(id: string, name: string, parentId: string | null, priority = 0): FakeNode
{
	return {
		id,
		name,
		note: null,
		parent_id: parentId,
		priority,
		createdAt: 1_600_000_000,
		modifiedAt: 1_600_000_000,
		completedAt: null,
	};
}
