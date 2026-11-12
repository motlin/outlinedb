/**
 * JSON output of `node mirror --json`.
 */
export interface NodeMirrorResult
{
	/** Whether a mirror was created or removed. */
	action: "created" | "deleted";
	/** Full UUID of the mirror node. */
	mirrorId: string;
	/** Full UUID of the true origin the mirror reflects; null when deleting. */
	originId: string | null;
	/** Full UUID of the mirror's parent; null when deleting. */
	parentId: string | null;
}
