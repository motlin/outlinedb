import type {UserStore} from "../user-store";

/** Bindings provisioning needs: D1 for the once-only flag and the Durable Objects. */
export interface ProvisionEnv
{
	AUTH_DB: D1Database;
	USER_STORE: DurableObjectNamespace<UserStore>;
}

/**
 * Give a verified user their Durable Object (named by their id) unless D1 says it already has one: store its profile,
 * which seeds the standalone account and the tutorial, then set `user.provisioned_at`. Every account starts the same
 * way; only its own Workflowy connection later makes it a mirror. Safe to repeat: the object keeps its first profile.
 */
export async function provisionUser(
	env: ProvisionEnv,
	user:
	{
		id: string;
		email: string;
	},
): Promise<void>
{
	const row = await env.AUTH_DB.prepare('SELECT provisioned_at FROM "user" WHERE id = ?').bind(user.id).first<
	{
		provisioned_at: string | null;
	}>();
	if (row?.provisioned_at !== null)
	{
		return;
	}
	const result = await env.USER_STORE.getByName(user.id).provision(
		{
			userId: user.id,
			email: user.email,
		},
	);
	if (!result.ok)
	{
		throw new Error(`Could not provision ${user.id}: ${result.error}`);
	}
	await env.AUTH_DB.prepare('UPDATE "user" SET provisioned_at = ? WHERE id = ? AND provisioned_at IS NULL')
		.bind(new Date().toISOString(), user.id)
		.run();
}
