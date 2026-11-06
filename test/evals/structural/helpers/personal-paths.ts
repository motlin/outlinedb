/**
 * Made-up names that plugin examples use in place of a real user, matching the
 * `@Alice`/`@Bob`/`@Carol` convention. A home directory under one of these is
 * an illustration, not a leaked username.
 */
const PLACEHOLDER_USERS = new Set([
	"alice",
	"bob",
	"carol",
	"charlie",
	"dave",
	"david",
	"eve",
	"frank",
	"grace",
	"me",
	"user",
	"username",
]);

const HOME_PATH = /\/(?:Users|home)\/([A-Za-z0-9._-]+)/gu;

/** Returns each home directory on the line that is not a placeholder user. */
export function findPersonalHomePaths(line: string): string[] {
	return [...line.matchAll(HOME_PATH)]
		.filter((match) => !PLACEHOLDER_USERS.has((match[1] ?? "").toLowerCase()))
		.map((match) => match[0]);
}
