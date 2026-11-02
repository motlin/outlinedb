import {ZOOMING_CLASS} from "./zoom-animation.js";

const STYLE_ID = "wf-calendar-nav-anim";
const KEYFRAMES = "@keyframes wf-cal-fade {0%{opacity:1}30%{opacity:0.15}100%{opacity:1}}";
const ANIMATION = "wf-cal-fade 500ms ease-in-out";

/**
 * Upstream's strip zoom fade: when a zoom starts (the body gains the zooming class), the strip dips to 15% opacity
 * and back over 500ms. Injects the keyframes once. Returns the cleanup.
 */
export function attachStripZoomFade(el: HTMLElement, doc: Document): () => void
{
	if (doc.getElementById(STYLE_ID) === null)
	{
		const style = doc.createElement("style");
		style.id = STYLE_ID;
		style.textContent = KEYFRAMES;
		doc.head.append(style);
	}
	const observer = new MutationObserver(() =>
	{
		if (doc.body.classList.contains(ZOOMING_CLASS))
		{
			el.style.animation = "none";
			void el.offsetWidth;
			el.style.animation = ANIMATION;
		}
	});
	observer.observe(
		doc.body,
		{
			attributes: true,
			attributeFilter: ["class"],
		},
	);
	return () =>
	{
		observer.disconnect();
	};
}
