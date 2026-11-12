import type {NodeResponse} from "../node-types.js";
import {spliceChildren} from "./node-cache.js";

interface PendingCreate
{
	row: NodeResponse;
	index: number;
	/** Every create registered before this one, settled. */
	prior: Promise<void>;
	/** Resolves when this create settles (success or failure). */
	done: Promise<void>;
	end: () => void;
}

/**
 * Creates sent under a client-generated id whose reply has not arrived yet. The
 * outline edits such a row immediately, so writes and reads that name it wait
 * here until the server has it, a children refetch that raced the create keeps
 * the optimistic row, and creates reach the server in the order they were made
 * (each one's index counts the rows created just before it).
 */
export class PendingCreates
{
	readonly #creates = new Map<string, PendingCreate>();

	/** Register the optimistic `row` inserted at `index` among its parent's children. */
	begin(row: NodeResponse, index: number): void
	{
		const prior = this.#allDone();
		const {promise: done, resolve: end} = deferred();
		this.#creates.set(
			row.id,
			{
				row,
				index,
				prior,
				done,
				end,
			},
		);
	}

	/** The create for `id` settled: stop tracking it and release everything waiting on it. */
	end(id: string): void
	{
		const create = this.#creates.get(id);
		this.#creates.delete(id);
		create?.end();
	}

	/** Wait for the creates registered before `id`'s (or for all pending creates when `id` is not tracked). */
	async prior(id: string | undefined): Promise<void>
	{
		const create = id === undefined ? undefined : this.#creates.get(id);
		await (create ? create.prior : this.#allDone());
	}

	/** Wait until none of `ids` (nodes or parents a request names) is still being created. */
	async settled(ids: (string | null | undefined)[]): Promise<void>
	{
		await settledAll(ids.flatMap((id) => (id ? [this.#creates.get(id)?.done] : [])));
	}

	async #allDone(): Promise<void>
	{
		await settledAll([...this.#creates.values()].map(async (create) => create.done));
	}

	/** `fetched` (a parent's children from the server) plus any pending row of that parent it does not have yet. */
	withPending(parentId: string | null, fetched: NodeResponse[]): NodeResponse[]
	{
		let children = fetched;
		for (const {row, index} of this.#creates.values())
		{
			if (row.parent_id === parentId && !children.some((child) => child.id === row.id))
			{
				children = spliceChildren(children, row, index);
			}
		}
		return children;
	}
}

async function settledAll(promises: (Promise<void> | undefined)[]): Promise<void>
{
	await Promise.all(promises.filter((promise): promise is Promise<void> => promise !== undefined));
}

function deferred():
{
	promise: Promise<void>;
	resolve: () => void;
}
{
	let resolve = noop;
	const promise = new Promise<void>((settle) =>
	{
		resolve = settle;
	});
	return {
		promise,
		resolve,
	};
}

function noop(): void
{
}

/** The app-wide registry the node hooks share. */
export const pendingCreates = new PendingCreates();
