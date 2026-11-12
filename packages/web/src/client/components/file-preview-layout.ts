/** Upstream's aspect for the image box: `floor(h/w*100)/100`, null when the original size is unknown. */
export function aspect(width: number | null, height: number | null): number | null
{
	if (width === null || height === null || width === 0)
	{
		return null;
	}
	return Math.floor((height / width) * 100) / 100;
}

/** The upload's pixel density, where a missing or zero value counts as 1. */
export function pixelDensity(pixels: number | null): number
{
	return pixels === null || pixels === 0 ? 1 : pixels;
}

export interface PreviewWidthInput
{
	/** The window is zoomed into the image item itself. */
	zoomedIn: boolean;
	innerWidth: number;
	/** `display_image_previews_as_thumbnails`: Small (200px) instead of Big (700px). */
	thumbs: boolean;
	/** The original width; upstream assumes 600 when unknown. */
	w: number | null;
	/** The upload's pixel density; a missing or zero value counts as 1. */
	pixels: number | null;
}

/** Upstream `cA4`'s image width in px: the window when zoomed in, else the size cap plus the 2px border, never wider than the window. */
export function previewWidth({zoomedIn, innerWidth, thumbs, w, pixels}: PreviewWidthInput): number
{
	if (zoomedIn)
	{
		return innerWidth;
	}
	const cap = thumbs ? 200 : 700;
	return Math.min(innerWidth, Math.min(cap, (w ?? 600) / pixelDensity(pixels)) + 2);
}
