import {originalUrl} from "./file-preview-kind.js";

/** Upstream's `attachment.download()`: a hidden `<a download>` clicked and removed. The signed original redirects from the proxy. */
export function downloadFile(nodeId: string, fileName: string, doc: Document = document): void
{
	const anchor = doc.createElement("a");
	anchor.href = originalUrl(nodeId);
	anchor.download = fileName;
	anchor.style.display = "none";
	doc.body.append(anchor);
	anchor.click();
	anchor.remove();
}

/** "View original": the signed original in a new tab. */
export function viewOriginal(
	nodeId: string,
	open: (url: string, target: string) => unknown = window.open.bind(window),
): void
{
	open(originalUrl(nodeId), "_blank");
}
