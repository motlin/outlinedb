// Craig's real Google Chrome, in a profile signed in to Google as the test email, so Gmail (for the verification link)
// and 1Password are at hand. Chrome 136+ ignores remote debugging on its default user data directory, and a copy of a
// default-directory profile cannot decrypt its cookies elsewhere, so the walkthrough keeps its own user data directory:
// Craig signs its profile in once in plain Chrome, and every run drives real Chrome there. Craig's own Chrome profiles
// are never opened, read for cookies, or changed.
import {cpSync, existsSync, lstatSync, readFileSync, readlinkSync} from "node:fs";
import {spawn} from "node:child_process";
import {homedir} from "node:os";
import {join} from "node:path";

const chromeUserData = join(homedir(), "Library/Application Support/Google/Chrome");
const walkthroughUserData =
	process.env.OUTLINEDB_WALKTHROUGH_CHROME_DIR ??
	join(homedir(), "Library/Application Support/OutlineDB Walkthrough Chrome");

/** The directory of the one profile in Chrome's Local State signed in as `email`, or why there is not exactly one. */
export function profileForEmail(
	localState: unknown,
	email: string,
):
	|
	  {
			directory: string;
	  }
	|
	  {
			refusal: string;
	  }
{
	const profile: unknown =
		typeof localState === "object" && localState !== null ? Reflect.get(localState, "profile") : undefined;
	const infoCache: unknown =
		typeof profile === "object" && profile !== null ? Reflect.get(profile, "info_cache") : undefined;
	if (typeof infoCache !== "object" || infoCache === null)
	{
		return {
			refusal: "Chrome's Local State lists no profiles",
		};
	}
	const wanted = email.trim().toLowerCase();
	const matches = Object.entries(infoCache)
		.filter(([, info]: [string, unknown]) =>
		{
			const userName: unknown = typeof info === "object" && info !== null ? Reflect.get(info, "user_name") : "";
			return typeof userName === "string" && userName.trim().toLowerCase() === wanted;
		})
		.map(([directory]) => directory)
		.toSorted();
	const [only] = matches;
	if (only === undefined)
	{
		return {
			refusal: `no Chrome profile is signed in as ${email}`,
		};
	}
	if (matches.length > 1)
	{
		return {
			refusal: `more than one Chrome profile is signed in as ${email}: ${matches.join(", ")}`,
		};
	}
	return {
		directory: only,
	};
}

/** The pid of the Chrome holding `userDataDir`, from its `SingletonLock` link (`host-pid`), if that process is alive. */
function runningChromePid(userDataDir: string): number | undefined
{
	let target: string;
	try
	{
		if (!lstatSync(join(userDataDir, "SingletonLock")).isSymbolicLink())
		{
			return undefined;
		}
		target = readlinkSync(join(userDataDir, "SingletonLock"));
	}
	catch
	{
		return undefined;
	}
	const pid = Number(target.slice(target.lastIndexOf("-") + 1));
	if (!Number.isInteger(pid) || pid <= 0)
	{
		return undefined;
	}
	try
	{
		process.kill(pid, 0);
		return pid;
	}
	catch
	{
		return undefined;
	}
}

/**
 * The walkthrough's user data directory and the profile in it signed in as `email`. Stops when Chrome already holds
 * that directory. When no profile there is signed in as `email` (the first run), opens plain Chrome on the directory
 * for Craig to sign in, and stops.
 */
export function walkthroughProfileFor(email: string):
{
	userDataDir: string;
	directory: string;
}
{
	const pid = runningChromePid(walkthroughUserData);
	if (pid !== undefined)
	{
		throw new Error(
			`The walkthrough's Google Chrome is running (pid ${pid}). Quit that Chrome window (Cmd-Q) and rerun.`,
		);
	}
	const localStatePath = join(walkthroughUserData, "Local State");
	const found = profileForEmail(
		existsSync(localStatePath) ? (JSON.parse(readFileSync(localStatePath, "utf8")) as unknown) : undefined,
		email,
	);
	if ("refusal" in found)
	{
		// Plain Chrome, without remote debugging, so Google allows the sign-in.
		spawn(
			"open",
			["-na", "Google Chrome", "--args", `--user-data-dir=${walkthroughUserData}`],
			{
				detached: true,
				stdio: "ignore",
			},
		).unref();
		throw new Error(
			`Stopping: ${found.refusal} in ${walkthroughUserData}. A Chrome window on it just opened: sign that Chrome in to Google as ${email} (profile icon > Sign in to Chrome), add the 1Password extension, quit that Chrome (Cmd-Q), then rerun.`,
		);
	}
	// 1Password's extension reaches its desktop app through a native messaging manifest, which Chrome reads from the
	// user data directory; refresh the copies from Craig's Chrome (manifests only, nothing of his profiles).
	if (existsSync(join(chromeUserData, "NativeMessagingHosts")))
	{
		cpSync(
			join(chromeUserData, "NativeMessagingHosts"),
			join(walkthroughUserData, "NativeMessagingHosts"),
			{
				recursive: true,
			},
		);
	}
	return {
		userDataDir: walkthroughUserData,
		directory: found.directory,
	};
}
