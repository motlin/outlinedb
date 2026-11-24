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
