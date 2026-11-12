/** Upstream's hover status bar (`hJ1`): the hovered link's href in a fixed box at the window's bottom-left. */

const BAR_STYLE =
	"color: rgb(60, 64, 67); background: rgb(222, 225, 230); border-radius: 0 3px 0 0; border: 1px solid rgb(213, 213, 213); border-left: none; border-bottom: none; position: fixed; bottom: 0; left: 0; z-index: 1000; font-size: 12px; padding: 2px 5px; opacity: 0; transition: opacity 0.3s";

function linkOf(event: Event): HTMLAnchorElement | null
{
	return event.target instanceof Element ? event.target.closest<HTMLAnchorElement>(".contentLink") : null;
}

/** Mount the bar on `doc`'s body and track `.contentLink` hovers; returns the uninstall function. */
export function installLinkStatusBar(doc: Document): () => void
{
	const bar = doc.createElement("div");
	bar.setAttribute("style", BAR_STYLE);
	doc.body.append(bar);
	const show = (event: Event) =>
	{
		const link = linkOf(event);
		if (link !== null)
		{
			bar.textContent = link.href;
			bar.style.opacity = "1";
		}
	};
	const hide = () =>
	{
		bar.style.opacity = "0";
	};
	doc.addEventListener("mouseover", show);
	doc.addEventListener("mouseout", hide);
	doc.defaultView?.addEventListener("hashchange", hide);
	return () =>
	{
		doc.removeEventListener("mouseover", show);
		doc.removeEventListener("mouseout", hide);
		doc.defaultView?.removeEventListener("hashchange", hide);
		bar.remove();
	};
}
