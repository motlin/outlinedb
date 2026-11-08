import type {UserStore} from "../user-store";
import {isStoreOwner} from "../worker-config";
import type {WorkerSecrets} from "../worker-config";

/** Bindings provisioning needs: D1 for the once-only flag, the Durable Objects, and the owner list. */
export interface ProvisionEnv extends Pick<WorkerSecrets, "WORKFLOWY_ENV_OWNERS" | "ALLOWED_EMAILS"> {
	AUTH_DB: D1Database;
	USER_STORE: DurableObjectNamespace<UserStore>;
}

/**
 * Give a verified user their Durable Object (named by their id) unless D1 says it already has one: store its profile,
 * in mirror mode when the email is an owner's (`WORKFLOWY_ENV_OWNERS`, else `ALLOWED_EMAILS`) and standalone
 * otherwise, then set `user.provisioned_at`. Safe to repeat: the object keeps its first profile.
 */
export async function provisionUser(env: ProvisionEnv, user: {id: string; email: string}): Promise<void> {
	const row = await env.AUTH_DB.prepare('SELECT provisioned_at FROM "user" WHERE id = ?')
		.bind(user.id)
		.first<{provisioned_at: string | null}>();
	if (row?.provisioned_at !== null) {
		return;
	}
	const mode = isStoreOwner(user.email, env) ? "mirror" : "standalone";
	const result = await env.USER_STORE.getByName(user.id).provision({userId: user.id, email: user.email, mode});
	if (!result.ok) {
		throw new Error(`Could not provision ${user.id}: ${result.error}`);
	}
	await env.AUTH_DB.prepare('UPDATE "user" SET provisioned_at = ? WHERE id = ? AND provisioned_at IS NULL')
		.bind(new Date().toISOString(), user.id)
		.run();
}
