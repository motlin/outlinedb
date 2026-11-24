import fs from "node:fs";
import path from "node:path";
import type {InternalAuth, SessionCookieStore} from "../api/workflowy-internal-client.js";

/** `.llm/workflowy-session` at the repository root (gitignored), from `src/node` or `dist/node` alike. */
export const DEFAULT_SESSION_FILE = path.resolve(import.meta.dirname, "../../../../.llm/workflowy-session");

/** A session store backed by one file, written with mode 0600. */
export function fileSessionStore(file: string): SessionCookieStore
{
	return {
		read()
		{
			const cookie = fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim() : "";
			return cookie === "" ? undefined : cookie;
		},
		write(cookie)
		{
			fs.mkdirSync(
				path.dirname(file),
				{
					recursive: true,
				},
			);
			fs.writeFileSync(
				file,
				`${cookie}\n`,
				{
					mode: 0o600,
				},
			);
			fs.chmodSync(file, 0o600);
		},
		clear()
		{
			fs.rmSync(
				file,
				{
					force: true,
				},
			);
		},
	};
}

/** `OUTLINEDB_SESSION_FILE`, or {@link DEFAULT_SESSION_FILE}. */
export function sessionFilePath(env: NodeJS.ProcessEnv = process.env): string
{
	return (env.OUTLINEDB_SESSION_FILE ?? "") || DEFAULT_SESSION_FILE;
}

/** The internal-API auth configured in the environment: the saved session cookie, or undefined when none is saved. */
export function readInternalAuth(env: NodeJS.ProcessEnv = process.env): InternalAuth | undefined
{
	const sessionStore = fileSessionStore(sessionFilePath(env));
	return sessionStore.read() === undefined
		? undefined
		:
			{
				sessionStore,
			};
}
