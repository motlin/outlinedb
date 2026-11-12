/** Upstream's `AppSettings.font_size` range and default: client-only (never sent to /change_settings). */
export const DEFAULT_FONT_SIZE = 19;
const MIN_FONT_SIZE = 12;
const MAX_FONT_SIZE = 28;
export const FONT_SIZE_STORAGE_KEY = "font_size";

export function clampFontSize(size: number): number
{
	return Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, size));
}

/** One tap on an `Aa` button: a step of 1 inside the range. */
export function stepFontSize(current: number, delta: number): number
{
	return clampFontSize(current + delta);
}

/** Upstream's phone row variables for `fontSize`: `--name-padding-left`, and the `VD4` bullet box. */
export function mobileRowMetrics(fontSize: number):
{
	namePaddingLeft: number;
	bulletSize: number;
	bulletLeft: number;
}
{
	const bulletSize = Math.round((fontSize * 25) / 18);
	return {
		namePaddingLeft: (fontSize + 20) / 1.3,
		bulletSize,
		bulletLeft: Math.round(-bulletSize / 2 + 11),
	};
}

function readStored(): number
{
	try
	{
		const raw = localStorage.getItem(FONT_SIZE_STORAGE_KEY);
		const parsed = raw === null ? Number.NaN : Number(raw);
		return Number.isFinite(parsed) ? clampFontSize(parsed) : DEFAULT_FONT_SIZE;
	}
	catch
	{
		return DEFAULT_FONT_SIZE;
	}
}

let current: number | null = null;
const listeners = new Set<() => void>();

/** The current size, read from this browser's storage on first use. */
export function getFontSize(): number
{
	current ??= readStored();
	return current;
}

/** Sets and persists the size per browser, as upstream's client-only setting is. */
export function setFontSize(size: number): void
{
	current = clampFontSize(size);
	try
	{
		localStorage.setItem(FONT_SIZE_STORAGE_KEY, String(current));
	}
	catch
	{
		// Storage can be blocked; the in-memory size still applies.
	}
	for (const listener of listeners)
	{
		listener();
	}
}

export function subscribeFontSize(listener: () => void): () => void
{
	listeners.add(listener);
	return () =>
	{
		listeners.delete(listener);
	};
}

export function resetFontSizeForTests(): void
{
	current = null;
	listeners.clear();
}
