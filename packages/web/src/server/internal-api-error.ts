/** Kept apart from `internal-api.ts` (which imports Hono) so host-neutral ops can share the message. */
export const INTERNAL_API_NOT_CONFIGURED =
	"Workflowy internal API is not configured (run './bin/run.js internal login')";
