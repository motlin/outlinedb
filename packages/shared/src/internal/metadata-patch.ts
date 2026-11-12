/** One Immer patch, the format upstream uses for `metadataPatches` on `edit` ops. */
export type MetadataPatch =
	|
	  {
			op: "add" | "replace";
			path: string[];
			value: unknown;
	  }
	|
	  {
			op: "remove";
			path: string[];
	  };

export interface MetadataPatchSet
{
	patches: MetadataPatch[];
	inverse: MetadataPatch[];
}

type MetadataObject = Record<string, unknown>;

function isObject(value: unknown): value is MetadataObject
{
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nest(path: string[], value: unknown): unknown
{
	return path.reduceRight<unknown>(
		(inner, key) => (
		{
			[key]: inner,
		}),
		value,
	);
}

/**
 * Build the Immer patches that set `path` to `value` in `metadata` (or delete it when `value` is undefined),
 * the way upstream's `setWith(metadata, path, value, Object)` inside `produce` would.
 *
 * A missing or non-object intermediate yields ONE patch of the full nested object at that level.
 * Array values throw, because upstream silently drops patch batches holding arrays.
 */
export function buildMetadataPatches(metadata: MetadataObject, path: string[], value: unknown): MetadataPatchSet
{
	if (path.length === 0)
	{
		throw new TypeError("metadata path must not be empty");
	}
	if (Array.isArray(value))
	{
		throw new TypeError("array metadata is not supported");
	}

	let current: MetadataObject = metadata;
	for (const [depth, key] of path.entries())
	{
		const prefix = path.slice(0, depth + 1);
		const isLeaf = depth === path.length - 1;
		const exists = Object.hasOwn(current, key);
		const existing = current[key];

		if (isLeaf || !isObject(existing))
		{
			if (value === undefined)
			{
				if (!isLeaf || !exists)
				{
					return {
						patches: [],
						inverse: [],
					};
				}
				return {
					patches: [
						{
							op: "remove",
							path: prefix,
						},
					],
					inverse: [
						{
							op: "add",
							path: prefix,
							value: existing,
						},
					],
				};
			}
			const next = nest(path.slice(depth + 1), value);
			if (!exists)
			{
				return {
					patches: [
						{
							op: "add",
							path: prefix,
							value: next,
						},
					],
					inverse: [
						{
							op: "remove",
							path: prefix,
						},
					],
				};
			}
			if (isLeaf && Object.is(existing, value))
			{
				return {
					patches: [],
					inverse: [],
				};
			}
			return {
				patches: [
					{
						op: "replace",
						path: prefix,
						value: next,
					},
				],
				inverse: [
					{
						op: "replace",
						path: prefix,
						value: existing,
					},
				],
			};
		}
		current = existing;
	}
	throw new Error("unreachable");
}

/** One metadata value to set at `path`, or to remove when `value` is undefined. */
export interface MetadataChange
{
	path: string[];
	value: unknown;
}

/**
 * Build the patches for several changes applied in order, as one `produce`
 * would: each change is built against the result of the ones before it, and
 * the inverse patches undo them in reverse order.
 */
export function buildMetadataChanges(metadata: MetadataObject, changes: MetadataChange[]): MetadataPatchSet
{
	const patches: MetadataPatch[] = [];
	const inverse: MetadataPatch[] = [];
	let current = metadata;
	for (const change of changes)
	{
		const set = buildMetadataPatches(current, change.path, change.value);
		patches.push(...set.patches);
		inverse.unshift(...set.inverse);
		current = applyMetadataPatches(current, set.patches);
	}
	return {
		patches,
		inverse,
	};
}

/** Apply Immer patches to a copy of `metadata`; the input is never mutated. */
export function applyMetadataPatches(metadata: MetadataObject, patches: MetadataPatch[]): MetadataObject
{
	const result = structuredClone(metadata);
	for (const patch of patches)
	{
		const parentPath = patch.path.slice(0, -1);
		const [leaf] = patch.path.slice(-1);
		if (leaf === undefined)
		{
			throw new TypeError("metadata patch path must not be empty");
		}
		let parent: MetadataObject = result;
		for (const key of parentPath)
		{
			const child = parent[key];
			if (!isObject(child))
			{
				throw new Error(`metadata patch path ${JSON.stringify(patch.path)} has no parent object`);
			}
			parent = child;
		}
		if (patch.op === "remove")
		{
			Reflect.deleteProperty(parent, leaf);
		}
		else
		{
			parent[leaf] = structuredClone(patch.value);
		}
	}
	return result;
}
