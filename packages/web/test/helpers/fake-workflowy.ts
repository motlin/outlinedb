import type {CacheService} from "@outlinedb/shared/cache";
import {anchoredIndex} from "@outlinedb/shared/internal";
import type {CreateAtInput, RestoreInput} from "@outlinedb/shared/internal";
import type {Node, WorkflowyNode} from "@outlinedb/shared/types";

/**
 * A fake Workflowy behind the real local server: its writes land straight in the server's cache, as the real
 * write-through client's do once Workflowy answers. Only type imports here, so a test's `vi.mock` factory for
 * `@outlinedb/shared/cache` can load these classes without importing the module it replaces.
 */

let clock = 1_000_000;

function now(): number
{
	clock += 1;
	return clock;
}

function seconds(date: Date | null): number | null
{
	return date === null ? null : Math.floor(date.getTime() / 1000);
}

function toApi(node: Node): WorkflowyNode
{
	return {
		id: node.id,
		name: node.name ?? "",
		note: node.note,
		parent_id: node.parentId,
		priority: node.priority,
		completed: node.completedAt !== null,
		...(node.layoutMode === null
			? {}
			:
				{
					data:
					{
						layoutMode: node.layoutMode,
					},
				}),
		createdAt: seconds(node.createdAt) ?? 0,
		modifiedAt: seconds(node.modifiedAt),
		completedAt: seconds(node.completedAt),
	};
}

function home(parentId: string | null | undefined): string | null
{
	return parentId === undefined || parentId === null || parentId === "home" ? null : parentId;
}

/** Deleted subtrees, root first, so a restore brings back the same ids. */
const trash = new Map<
	string,
	{
		node: WorkflowyNode;
		parentId: string | null;
	}[]
>();

export function resetFakeWorkflowy(): void
{
	trash.clear();
}

function read(cache: CacheService, id: string): WorkflowyNode
{
	const node = cache.getNode(id);
	if (node === undefined)
	{
		throw new Error(`Fake Workflowy: unknown node ${id}`);
	}
	return toApi(node);
}

/** Put `ids` under `parentId` at the move slot `index` (counted among its children before removal), renumbering. */
function place(cache: CacheService, ids: readonly string[], parentId: string | null, index: number): void
{
	const moving = new Set(ids);
	const before = cache.getChildren(parentId).map((child) => child.id);
	const others = before.filter((id) => !moving.has(id));
	const at = before.slice(0, index).filter((id) => !moving.has(id)).length;
	const order = [...others.slice(0, at), ...ids, ...others.slice(at)];
	for (const [priority, id] of order.entries())
	{
		cache.insertNode(
			{
				...read(cache, id),
				parent_id: parentId,
				priority,
			},
			parentId,
		);
	}
}

/** Stands in for `WorkflowyWriteThroughClient`, with the constructor arguments the routes pass it. */
export class FakeWriteThroughClient
{
	constructor(
		_apiClient: unknown,
		private readonly cache: CacheService,
	)
	{
	}

	// fallow-ignore-next-line unused-class-member -- called by the routes through the mocked shared client
	async updateNode(
		requestedId: string,
		options:
		{
			name?: string;
			note?: string;
		},
	): Promise<WorkflowyNode>
	{
		const id = this.cache.getMirrorOriginal(requestedId) ?? requestedId;
		const node = read(this.cache, id);
		const updated =
		{
			...node,
			name: options.name ?? node.name,
			note: options.note ?? node.note,
			modifiedAt: now(),
		};
		this.cache.insertNode(updated, home(node.parent_id));
		return Promise.resolve(updated);
	}

	// fallow-ignore-next-line unused-class-member -- called by the routes through the mocked shared client
	async deleteNode(nodeId: string): Promise<void>
	{
		const subtree:
		{
			node: WorkflowyNode;
			parentId: string | null;
		}[] = [];
		const walk = (id: string) =>
		{
			const node = read(this.cache, id);
			subtree.push(
				{
					node,
					parentId: home(node.parent_id),
				},
			);
			for (const child of this.cache.getChildren(id))
			{
				walk(child.id);
			}
		};
		walk(nodeId);
		trash.set(nodeId, subtree);
		this.cache.deleteNode(nodeId);
		return Promise.resolve();
	}

	// fallow-ignore-next-line unused-class-member -- called by the routes through the mocked shared client
	async completeNode(nodeId: string): Promise<WorkflowyNode>
	{
		return this.#complete(nodeId, true);
	}

	// fallow-ignore-next-line unused-class-member -- called by the routes through the mocked shared client
	async uncompleteNode(nodeId: string): Promise<WorkflowyNode>
	{
		return this.#complete(nodeId, false);
	}

	async #complete(nodeId: string, completed: boolean): Promise<WorkflowyNode>
	{
		const node = read(this.cache, nodeId);
		const at = now();
		const updated =
		{
			...node,
			completed,
			completedAt: completed ? at : null,
			modifiedAt: at,
		};
		this.cache.insertNode(updated, home(node.parent_id));
		return Promise.resolve(updated);
	}
}

/** Stands in for `WorkflowyApiClient`: only the restore route's "is it really deleted?" read is reached. */
export class FakeApiClient
{
	// fallow-ignore-next-line unused-class-member -- called by the routes through the mocked shared client
	async findNode(id: string): Promise<null |
	{
		id: string;
	}>
	{
		return Promise.resolve(
			trash.has(id)
				? null
				:
					{
						id,
					},
		);
	}
}

/** The internal-API adapter methods the routes write exact-index changes through. */
export function fakeAdapter(cache: CacheService)
{
	return {
		async createAt(input: CreateAtInput)
		{
			const parentId = home(input.parentId);
			const siblingIds = cache.getChildren(parentId).map((child) => child.id);
			const index = anchoredIndex(siblingIds, input.afterId, input.index ?? siblingIds.length);
			const id = input.id ?? `new-${now()}`;
			const at = now();
			cache.insertNode(
				{
					id,
					name: input.name,
					note: input.note ?? null,
					parent_id: parentId,
					priority: 1e9,
					createdAt: at,
					modifiedAt: at,
				},
				parentId,
			);
			place(cache, [id], parentId, index);
			return Promise.resolve(
				{
					id,
				},
			);
		},
		async moveTo(input: {ids: string[]; parentId: string; index?: number})
		{
			const parentId = home(input.parentId);
			place(cache, input.ids, parentId, input.index ?? cache.getChildren(parentId).length);
			return Promise.resolve();
		},
		async moveBlocks(
			inputs:
			{
				ids: string[];
				parentId: string;
				index?: number;
			}[],
		)
		{
			for (const input of inputs)
			{
				const parentId = home(input.parentId);
				place(cache, input.ids, parentId, input.index ?? cache.getChildren(parentId).length);
			}
			return Promise.resolve();
		},
		async restore(input: RestoreInput)
		{
			const subtree = trash.get(input.id) ?? [];
			trash.delete(input.id);
			for (const {node, parentId} of subtree)
			{
				cache.insertNode(
					{
						...node,
						priority: node.id === input.id ? 1e9 : node.priority,
					},
					parentId,
				);
			}
			const root = subtree.at(0);
			if (root !== undefined)
			{
				const parentId = input.parentId === undefined ? root.parentId : home(input.parentId);
				place(cache, [input.id], parentId, input.index ?? cache.getChildren(parentId).length);
			}
			return Promise.resolve();
		},
		async setNodeMetaValues(
			id: string,
			changes:
			{
				path: string[];
				value: unknown;
			}[],
		)
		{
			for (const {path, value} of changes)
			{
				if (path[0] === "layoutMode")
				{
					const node = read(cache, id);
					cache.insertNode(
						{
							...node,
							data:
								typeof value === "string"
									?
										{
											layoutMode: value,
										}
									: {},
						},
						home(node.parent_id),
					);
				}
			}
			return Promise.resolve();
		},
		async syncBacklinks()
		{
			return Promise.resolve();
		},
		async deleteBacklinksOf()
		{
			return Promise.resolve();
		},
		async getRootMeta()
		{
			return Promise.resolve("bullets");
		},
	};
}
