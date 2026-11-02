/**
 * Upstream's `right-bar.panels.*` registry and the `right-bar-last` cookie that remembers the shown panel.
 */

import type {ReactNode} from "react";

export interface RightBarPanel
{
	title: string;
	element: () => ReactNode;
}

const COOKIE_NAME = "right-bar-last";

const panels: RightBarPanel[] = [];

/** Add a panel to the right bar; the returned function removes it. */
export function registerRightBarPanel(panel: RightBarPanel): () => void
{
	panels.push(panel);
	return () =>
	{
		const index = panels.indexOf(panel);
		if (index !== -1)
		{
			panels.splice(index, 1);
		}
	};
}

export function rightBarPanels(): readonly RightBarPanel[]
{
	return panels;
}

/** The title stored in the `right-bar-last` cookie, if any. */
function rightBarLast(): string | undefined
{
	if (typeof document === "undefined")
	{
		return undefined;
	}
	for (const entry of document.cookie.split(";"))
	{
		const [name, ...value] = entry.trim().split("=");
		if (name === COOKIE_NAME)
		{
			return value.join("=");
		}
	}
	return undefined;
}

export function setRightBarLast(title: string): void
{
	document.cookie = `${COOKIE_NAME}=${title}`;
}

/** The cookie's panel when it names a registered one, else the first panel. */
export function shownRightBarPanel(): RightBarPanel | undefined
{
	const last = rightBarLast();
	return panels.find((panel) => panel.title === last) ?? panels[0];
}
