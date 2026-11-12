import type {NodeResponse} from "../node-types.js";

/** The most parents one batch request asks for. */
export const CHILDREN_BATCH_SIZE = 200;

interface Waiter
{
	resolve: (nodes: NodeResponse[]) => void;
	reject: (error: unknown) => void;
}

/**
 * Coalesce every children load requested in one tick into batch requests of at most `CHILDREN_BATCH_SIZE` parents.
 * An expanded search can render thousands of rows at once, and one GET per row floods the browser
 * (net::ERR_INSUFFICIENT_RESOURCES) and freezes the tab.
 */
export function createChildrenBatcher(
	post: (parentIds: string[]) => Promise<Record<string, NodeResponse[]>>,
): (parentId: string) => Promise<NodeResponse[]>
{
	let queue = new Map<string, Waiter[]>();

	const send = async (batch: [string, Waiter[]][]): Promise<void> =>
	{
		try
		{
			const children = await post(batch.map(([id]) => id));
			for (const [id, waiters] of batch)
			{
				const nodes = children[id];
				for (const waiter of waiters)
				{
					if (nodes === undefined)
					{
						waiter.reject(new Error(`Failed to fetch children: unknown parent ${id}`));
					}
					else
					{
						waiter.resolve(nodes);
					}
				}
			}
		}
		catch (error)
		{
			for (const [, waiters] of batch)
			{
				for (const waiter of waiters)
				{
					waiter.reject(error);
				}
			}
		}
	};

	const flush = (): void =>
	{
		const entries = [...queue];
		queue = new Map();
		for (let start = 0; start < entries.length; start += CHILDREN_BATCH_SIZE)
		{
			void send(entries.slice(start, start + CHILDREN_BATCH_SIZE));
		}
	};

	return async (parentId) =>
		new Promise<NodeResponse[]>((resolve, reject) =>
		{
			if (queue.size === 0)
			{
				setTimeout(flush, 0);
			}
			const waiters = queue.get(parentId);
			if (waiters === undefined)
			{
				queue.set(parentId, [
					{
						resolve,
						reject,
					},
				]);
			}
			else
			{
				waiters.push(
					{
						resolve,
						reject,
					},
				);
			}
		});
}
