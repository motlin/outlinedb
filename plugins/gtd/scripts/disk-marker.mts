// The `Disks: <name>, <name>` marker on a daily-review task names the external disks (by volume
// name, as in the 💾 External Hard Drives inventory) that the task needs mounted. `NAS` names the
// NAS share and `any` means at least one inventory disk. disk-check.mts reports which are
// available; compute-llm-dag.mts and compute-overdue.mts skip a task whose disks are missing.

export const DISKS_PREFIX = "Disks: ";
export const NAS_DISK = "NAS";
export const ANY_DISK = "any";

interface MarkerNode
{
	name: string;
	children?: readonly MarkerNode[] | null;
}

/** The disks a task's `Disks:` marker child names, or an empty list when it has none. */
export function requiredDisks(node: MarkerNode): string[]
{
	return (node.children ?? [])
		.filter((child) => child.name.startsWith(DISKS_PREFIX))
		.flatMap((child) => child.name.slice(DISKS_PREFIX.length).split(","))
		.map((name) => name.trim())
		.filter((name) => name !== "");
}

/** The required disks that are not available, compared case-insensitively. */
export function missingDisks(required: readonly string[], available: ReadonlySet<string>): string[]
{
	const lower = new Set([...available].map((name) => name.toLowerCase()));
	const anyDisk = [...lower].some((name) => name !== NAS_DISK.toLowerCase());
	return required.filter((name) => (name.toLowerCase() === ANY_DISK ? !anyDisk : !lower.has(name.toLowerCase())));
}
