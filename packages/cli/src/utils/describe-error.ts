/** One level of an error chain: its name, SQLite code when it has one, and message. */
function describeOne(error: unknown): string {
	if (!(error instanceof Error)) {
		return String(error);
	}
	const code = "code" in error && typeof error.code === "string" ? ` [${error.code}]` : "";
	return `${error.name}${code}: ${error.message}`;
}

/**
 * Render an error with its whole `cause` chain. A DrizzleError's own message is
 * only the failed SQL; the SQLite error that explains it (a constraint, a busy
 * lock) is its cause, which `String(error)` drops.
 */
export function describeError(error: unknown): string {
	const lines = [describeOne(error)];
	let cause = error instanceof Error ? error.cause : undefined;
	while (cause !== undefined) {
		lines.push(`  caused by ${describeOne(cause)}`);
		cause = cause instanceof Error ? cause.cause : undefined;
	}
	return lines.join("\n");
}
