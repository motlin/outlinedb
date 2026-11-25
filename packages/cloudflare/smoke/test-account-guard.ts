/** The session `GET /api/auth/get-session` answers, as far as the guard reads it. */
export interface WalkthroughSession
{
	user:
	{
		id: string;
		email: string;
		createdAt: string;
	};
}

/**
 * Why the new-user walkthrough must not delete the signed-in account, or null when it may. It deletes only the test
 * account it created itself during this run: the email must be the configured test email, the user the one this run's
 * verification signed in, and the user created after the run started. So an account that already existed (Craig's own,
 * or one holding real data) is never deleted, whatever the email.
 */
export function deletionRefusal({
	testEmail,
	session,
	createdUserId,
	runStartedAt,
}: {
	testEmail: string | undefined;
	session: WalkthroughSession | null;
	createdUserId: string | undefined;
	runStartedAt: Date;
}): string | null
{
	if (testEmail === undefined || testEmail.trim() === "")
	{
		return "OUTLINEDB_TEST_EMAIL is not set";
	}
	if (session === null)
	{
		return "no one is signed in";
	}
	if (session.user.email.trim().toLowerCase() !== testEmail.trim().toLowerCase())
	{
		return "the signed-in account is not the test email";
	}
	if (createdUserId === undefined || session.user.id !== createdUserId)
	{
		return "the signed-in account is not the one this run signed up";
	}
	const createdAt = Date.parse(session.user.createdAt);
	if (Number.isNaN(createdAt) || createdAt < runStartedAt.getTime())
	{
		return "the account existed before this run started";
	}
	return null;
}

/**
 * Why the walkthrough must not start in this Chrome profile, or null when it may. The run must begin as a brand-new
 * user, so the profile must hold no Better Auth session cookie for the app (plain, or with the `__Secure-` prefix it
 * gets over https) and `GET /api/auth/get-session` must answer null.
 */
export function existingSessionRefusal({
	cookieNames,
	session,
}: {
	cookieNames: readonly string[];
	session: WalkthroughSession | null;
}): string | null
{
	const cookie = cookieNames.find((name) => name.endsWith("better-auth.session_token"));
	if (cookie !== undefined)
	{
		return `the profile already has an OutlineDB session cookie (${cookie})`;
	}
	if (session !== null)
	{
		return `the profile is already signed in to OutlineDB as ${session.user.email}`;
	}
	return null;
}
