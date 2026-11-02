import {useCallback} from "react";
import {createPortal} from "react-dom";
import {MIRROR_FROM_HEADER} from "../inline-mirror.js";
import {revealInScroller} from "../reveal-in-scroller.js";
import {Flyout} from "./flyout/flyout.js";
import {FlyoutAlign} from "./flyout/flyout-style.js";
import {MenuScroller} from "./flyout/menu.js";
import {MenuItem, MenuSectionHeader} from "./flyout/menu-item.js";
import {LocationCrumbs} from "./location-picker.js";
import type {LocationResponse} from "../../node-types.js";

/** One location the `((` popup offers: upstream's `<b><u>` word-start label and root-first ancestors without Home. */
export type MirrorHit = LocationResponse["results"][number];

interface MirrorMenuProps
{
	hits: readonly MirrorHit[];
	index: number;
	keyboardMode: boolean;
	/** The chip's page left and bottom. */
	left: number;
	top: number;
	onSelect: (index: number) => void;
	onHover: (index: number) => void;
	onMouseMove: () => void;
}

const POSITION_OFFSET = [0, 0] as const;

/**
 * Upstream's `((` popup (`MIRROR_SEARCH_POPUP`): the shared suggest flyout under the chip with a "mirror from" header
 * and one location row per hit, its label matched in `<b><u>` and its ancestors as breadcrumbs.
 */
export function MirrorMenu({hits, index, keyboardMode, left, top, onSelect, onHover, onMouseMove}: MirrorMenuProps)
{
	const scrollActive = useCallback((element: HTMLAnchorElement | null) =>
	{
		if (element !== null)
		{
			revealInScroller(element);
		}
	}, []);

	if (hits.length === 0)
	{
		return null;
	}
	return createPortal(
		<Flyout
			align={FlyoutAlign.None}
			position={[left, top]}
			offset={POSITION_OFFSET}
			minWidth={0}
			className="menu mirror-popup"
			removeFromDom={false}
		>
			<MenuScroller onMouseMove={onMouseMove}>
				<MenuSectionHeader key="header">{MIRROR_FROM_HEADER}</MenuSectionHeader>
				{hits.map((hit, hitIndex) =>
				{
					const active = hitIndex === index;
					return (
						<MenuItem
							key={hit.id}
							ref={active && keyboardMode ? scrollActive : undefined}
							label={
								<div data-menu-item-label="" className="flex flex-row gap-m">
									<div
										dangerouslySetInnerHTML={
										{
											__html: hit.labelHtml,
										}}
									/>
								</div>
							}
							subtext={<LocationCrumbs crumbs={hit.ancestors} />}
							isSelected={keyboardMode && active}
							isInKeyboardMode={keyboardMode}
							onMouseEnter={() =>
							{
								onHover(hitIndex);
							}}
							onSelect={() =>
							{
								onSelect(hitIndex);
							}}
						/>
					);
				})}
			</MenuScroller>
		</Flyout>,
		document.body,
	);
}
