// 5176 sits next to the client's 5175 and is claimed by no sibling project under
// ~/projects, unlike 3000 — the unpinned template default that a dozen of them share.
export const DEFAULT_PORT = 5176;

// Overridable so a second instance can run beside a dev server already on the default.
export const resolvePort = (env: {PORT?: string | undefined}): number =>
{
	const port = Number(env.PORT);
	return Number.isFinite(port) && port > 0 ? port : DEFAULT_PORT;
};
