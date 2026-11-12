/**
 * Moves (and undo replays, see `holdUndoReplay`) whose reply has not arrived yet, by the parents they leave and enter. A children read of
 * such a parent waits for the move to reach the server, so a refetch sent while it is in flight
 * (a create's settle, an expand) cannot answer the pre-move list and undo the optimistic splice.
 */
class PendingMoves
{
	readonly #moves = new Map<
		object,
		{
			parentIds: Set<string | null>;
			done: Promise<void>;
			end: () => void;
		}
	>();

	/** Register the move `key` (its request) touching `parentIds`. */
	begin(key: object, parentIds: (string | null)[]): void
	{
		let end = noop;
		const done = new Promise<void>((resolve) =>
		{
			end = resolve;
		});
		this.#moves.set(
			key,
			{
				parentIds: new Set(parentIds),
				done,
				end,
			},
		);
	}

	/** The move `key` settled: release every read waiting on it. */
	end(key: object): void
	{
		this.#moves.get(key)?.end();
		this.#moves.delete(key);
	}

	/** How many moves are still pending. */
	get size(): number
	{
		return this.#moves.size;
	}

	/** Whether a move into or out of `parentId` is still pending. */
	has(parentId: string | null): boolean
	{
		return [...this.#moves.values()].some((move) => move.parentIds.has(parentId));
	}

	/** Wait until no move into or out of `parentId` is still pending. */
	async settled(parentId: string | null): Promise<void>
	{
		await Promise.all(
			[...this.#moves.values()].filter((move) => move.parentIds.has(parentId)).map(async (move) => move.done),
		);
	}
}

function noop(): void
{
}

/** The app-wide registry the node hooks share. */
export const pendingMoves = new PendingMoves();
