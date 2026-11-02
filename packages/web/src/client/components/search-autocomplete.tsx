import {useMemo} from "react";
import type {AutocompleteHeader, AutocompleteIcon, AutocompleteRow} from "../search/autocomplete-values.js";
import {Flyout} from "./flyout/flyout.js";
import {MenuBody} from "./flyout/menu.js";
import {MenuItem, MenuSectionHeader} from "./flyout/menu-item.js";

const AUTOCOMPLETE_BASE_CLASS =
	"menu [&.menu.flyout]:m-0 [&.menu.flyout]:-mt-px [&.menu.flyout]:box-border [&.menu.flyout]:border-solid [&.menu.flyout]:border-t-0 [&.menu.flyout]:rounded-[16px] [&.menu.flyout]:rounded-tl-none [&.menu.flyout]:rounded-tr-none [&.menu.flyout]:shadow-none ";
const ROW_CLASS = "hover:!bg-secondary [&.active]:!bg-secondary";

/** Upstream's flyout class: the tint border once a query is committed, else a class with no shipped rule. */
export function autocompleteClassName(committed: boolean): string
{
	return `${AUTOCOMPLETE_BASE_CLASS}${committed ? "[&.menu.flyout]:border-[var(--wf-border-tint)]" : "[&.menu.flyout]:border-primary-x"}`;
}

function iconOf(icon: AutocompleteIcon | undefined)
{
	if (icon === undefined || typeof icon === "string")
	{
		return icon;
	}
	return (
		<span
			className="border border-primary box-border w-[14px] h-[14px] rounded-xs"
			style={
			{
				backgroundColor: `var(--wf-${icon.swatch}-${icon.color})`,
			}}
		/>
	);
}

export interface SearchAutocompleteProps
{
	rows: readonly (AutocompleteRow | AutocompleteHeader)[];
	/** The committed query is non-empty. */
	committed: boolean;
	onSelect: (row: AutocompleteRow) => void;
}

/** Upstream's search box autocomplete flyout (`kN4`): a keyboard-driven value list under the pill. */
export function SearchAutocomplete({rows, committed, onSelect}: SearchAutocompleteProps)
{
	const items = useMemo(
		() =>
			rows.map((row) =>
				row.type === "header" ? (
					<MenuSectionHeader key={`header-${row.label}`}>
						<span>{row.label}</span>
					</MenuSectionHeader>
				) : (
					<MenuItem
						key={row.value}
						label={row.label}
						icon={iconOf(row.icon)}
						className={ROW_CLASS}
						onSelect={() =>
						{
							onSelect(row);
						}}
					/>
				),
			),
		[rows, onSelect],
	);
	return (
		<Flyout
			expanded
			minWidth="100%"
			maxWidth="100%"
			maxHeight="200px"
			rounded
			surfaceClassName="wf-header"
			removeFromDom={false}
			className={autocompleteClassName(committed)}
		>
			<MenuBody unwrapped keyboardMode initialSelect={0} maxHeight="200px" cyclicNavigation selectOnTab={false}>
				{items}
			</MenuBody>
		</Flyout>
	);
}
