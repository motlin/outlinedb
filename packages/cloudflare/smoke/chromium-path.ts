import {existsSync, readdirSync} from "node:fs";
import {homedir} from "node:os";
import {join} from "node:path";

/** `CHROMIUM_PATH`, else the newest Playwright Chromium in its macOS cache, else undefined for Playwright's own lookup. */
export function chromiumPath(): string | undefined
{
	const override = process.env.CHROMIUM_PATH;
	if (override !== undefined)
	{
		return override;
	}
	const cache = join(homedir(), "Library/Caches/ms-playwright");
	const dirs = existsSync(cache)
		? readdirSync(cache)
				.filter((d) => /^chromium-\d+$/u.test(d))
				.toSorted()
				.toReversed()
		: [];
	for (const dir of dirs)
	{
		for (const rel of [
			"chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
			"chrome-mac/Chromium.app/Contents/MacOS/Chromium",
		])
		{
			if (existsSync(join(cache, dir, rel)))
			{
				return join(cache, dir, rel);
			}
		}
	}
	return undefined;
}
