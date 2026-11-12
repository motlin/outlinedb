/** The browser and platform tags upstream appends to the version in Settings, e.g. `chrome-155, mac`. */
export function versionTags(userAgent: string): string[]
{
	const tags: string[] = [];
	const chrome = /Chrome\/(\d+)/u.exec(userAgent);
	if (chrome && !userAgent.includes("Edg/"))
	{
		tags.push(`chrome-${chrome[1]}`);
	}
	const ios = /(?:iPhone|iPad|iPod).*? OS (\d+)_(\d+)/u.exec(userAgent);
	const android = /Android (\d+)/u.exec(userAgent);
	if (ios)
	{
		tags.push(`ios-${ios[1]}.${ios[2]}`);
	}
	else if (/iPhone|iPad|iPod/u.test(userAgent))
	{
		tags.push("ios");
	}
	else if (android)
	{
		tags.push(`android-${android[1]}`);
	}
	else if (userAgent.includes("Android"))
	{
		tags.push("android");
	}
	else if (userAgent.includes("Macintosh"))
	{
		tags.push("mac");
	}
	else if (userAgent.includes("Windows"))
	{
		tags.push("win");
	}
	else if (userAgent.includes("Linux"))
	{
		tags.push("linx");
	}
	return tags;
}

/** `4.3.1 [chrome-155, mac]`, or the bare version when there are no tags. */
export function versionLabel(version: string, tags: readonly string[]): string
{
	return tags.length > 0 ? `${version} [${tags.join(", ")}]` : version;
}

/** This build's version with the running browser's tags. */
export function currentVersionLabel(): string
{
	const injected: unknown = import.meta.env.VITE_APP_VERSION;
	const version = typeof injected === "string" ? injected : "0.0.0";
	return versionLabel(version, versionTags(globalThis.navigator.userAgent));
}
