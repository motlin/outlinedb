import {useEffect} from "react";
import {useCloseOnLocationChange} from "../hooks/use-close-on-location-change.js";
import {hideSheet, useSheetStore} from "../stores/sheet.js";
import {FontSizeSheet} from "./mobile-font-size.js";
import {MobileMenu} from "./mobile-menu.js";
import {MobileMoreMenu} from "./mobile-more-menu.js";

/** Upstream's `body { height: 100vh; overflow-y: hidden }` while a sheet is open (styles.css `mobile-sheet-open`). */
const SHEET_OPEN_BODY_CLASS = "mobile-sheet-open";

function deferredHide(): void
{
	setTimeout(hideSheet, 0);
}

/** Renders the open sheet (`WF.Sheet`). A location change closes it, deferred a tick like upstream. */
export function MobileSheetHost()
{
	const sheet = useSheetStore((state) => state.sheet);
	// Deferred a tick, like upstream (`setTimeout 0`).
	useCloseOnLocationChange(deferredHide);
	useEffect(() =>
	{
		document.body.classList.toggle(SHEET_OPEN_BODY_CLASS, sheet !== null);
		return () =>
		{
			document.body.classList.remove(SHEET_OPEN_BODY_CLASS);
		};
	}, [sheet]);
	if (sheet === null)
	{
		return null;
	}
	return (
		<MobileMenu header={sheet !== "more-menu"} onClose={hideSheet}>
			{sheet === "more-menu" ? <MobileMoreMenu /> : <FontSizeSheet />}
		</MobileMenu>
	);
}
