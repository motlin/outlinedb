/** The test email's row in the production AUTH_DB `user` table, as the walkthrough reads it. */
export interface TestUserRow
{
	id: string;
	createdAt: string;
	emailVerified: boolean;
	provisionedAt: string | null;
}

/** Where the new-user walkthrough is: each stage expects D1 to hold the test email's row in a particular state. */
export type WalkthroughStage = "before signup" | "signed up" | "verified" | "provisioned" | "deleted";

/**
 * The read-only SELECT for the test email's user row. `wrangler d1 execute --command` takes no bind parameters, so the
 * email is inlined as an SQL string literal with its quotes doubled.
 */
export function testUserQuery(email: string): string
{
	const literal = `'${email.replaceAll("'", "''")}'`;
	return `SELECT id, "createdAt", "emailVerified", provisioned_at FROM "user" WHERE lower(email) = lower(${literal})`;
}

function rowFrom(value: unknown): TestUserRow
{
	const field = (name: string): unknown =>
		typeof value === "object" && value !== null ? Reflect.get(value, name) : undefined;
	const id = field("id");
	const createdAt = field("createdAt");
	const emailVerified = field("emailVerified");
	const provisionedAt = field("provisioned_at");
	if (
		typeof id !== "string" ||
		typeof createdAt !== "string" ||
		(emailVerified !== 0 && emailVerified !== 1) ||
		(provisionedAt !== null && typeof provisionedAt !== "string")
	)
	{
		throw new TypeError(`unexpected user row: ${JSON.stringify(value)}`);
	}
	return {
		id,
		createdAt,
		emailVerified: emailVerified === 1,
		provisionedAt,
	};
}

/** The rows of `wrangler d1 execute --json` output for one statement; throws on anything else. */
export function parseTestUserRows(output: string): TestUserRow[]
{
	const parsed: unknown = JSON.parse(output);
	const statement: unknown = Array.isArray(parsed) && parsed.length === 1 ? parsed[0] : undefined;
	const results: unknown =
		typeof statement === "object" && statement !== null && Reflect.get(statement, "success") === true
			? Reflect.get(statement, "results")
			: undefined;
	if (!Array.isArray(results))
	{
		throw new TypeError(`wrangler d1 execute did not succeed: ${output.trim()}`);
	}
	return results.map((value: unknown) => rowFrom(value));
}

/**
 * Why D1 does not match the walkthrough's stage, or null when it does. Before signup the test email must have no user
 * (the run starts brand new); from signup on it must have exactly one, created after the run started, then verified,
 * then provisioned; after Craig deletes the account it must have none again.
 */
export function walkthroughRefusal(
	stage: WalkthroughStage,
	rows: readonly TestUserRow[],
	runStartedAt: Date,
): string | null
{
	if (stage === "before signup" || stage === "deleted")
	{
		const [existing] = rows;
		if (existing === undefined)
		{
			return null;
		}
		return stage === "before signup"
			? `a user with the test email already exists (created ${existing.createdAt}); the run must start with a brand-new email`
			: `the user still exists (created ${existing.createdAt})`;
	}
	const [user] = rows;
	if (user === undefined)
	{
		return "no user with the test email exists yet";
	}
	if (rows.length > 1)
	{
		return `${rows.length} users have the test email`;
	}
	const createdAt = Date.parse(user.createdAt);
	if (Number.isNaN(createdAt) || createdAt < runStartedAt.getTime())
	{
		return `the user was created at ${user.createdAt}, before this run started at ${runStartedAt.toISOString()}`;
	}
	if (stage !== "signed up" && !user.emailVerified)
	{
		return "the email is not verified yet";
	}
	if (stage === "provisioned" && user.provisionedAt === null)
	{
		return "the account is not provisioned yet (provisioned_at is null)";
	}
	return null;
}
