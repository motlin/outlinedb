import {useEffect, useMemo, useRef, useState} from "react";
import type {CSSProperties, KeyboardEvent} from "react";
import {borderStyle, createSearchBoxController} from "../search-box-model.js";
import {CLEAR_PATH, COMPACT_INPUT_CLASS, MAGNIFIER_PATH, labelClass} from "./search-box.js";

interface PaneSearchBoxProps
{
	/** The pane's committed query ("" for none). */
	query: string;
	/** Upstream's `compact`: a borderless 36px circle while empty and unfocused. */
	compact?: boolean;
	onCommit: (query: string) => void;
}

/**
 * Upstream's per-pane search box (`kR4`): it filters only its own pane. In a compact pane header it is a 36px
 * magnifier circle until focused or holding a query, then the header's pill. Typing commits after the header search's
 * debounce, Enter commits at once, and Escape or the clear control ends the pane's search.
 */
export function PaneSearchBox({query, compact = false, onCommit}: PaneSearchBoxProps)
{
	const [value, setValue] = useState(query);
	const [shownQuery, setShownQuery] = useState(query);
	const [focused, setFocused] = useState(false);
	const inputRef = useRef<HTMLInputElement>(null);
	// A pane zoom or Back/Forward replaces the committed query; the box follows it.
	if (shownQuery !== query)
	{
		setShownQuery(query);
		setValue(query);
	}
	const controller = useMemo(
		() =>
			createSearchBoxController(
				{
					commit: onCommit,
					getCommitted: () => query,
				},
			),
		[onCommit, query],
	);
	useEffect(() => controller.dispose, [controller]);

	const clear = () =>
	{
		controller.dispose();
		setValue("");
		if (query !== "")
		{
			onCommit("");
		}
	};

	const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) =>
	{
		if (event.key === "Escape")
		{
			event.preventDefault();
			event.stopPropagation();
			clear();
			inputRef.current?.blur();
			return;
		}
		const result = controller.key(event.key, value);
		if (result.preventDefault)
		{
			event.preventDefault();
		}
		if (result.action === "focusOutline")
		{
			inputRef.current?.blur();
		}
	};

	const hasText = value !== "";
	const collapsed = compact && !focused && !hasText;
	const labelStyle: CSSProperties = collapsed
		?
			{
				width: 36,
				height: 36,
				borderRadius: 18,
			}
		:
			{
				marginRight: 6,
				width: 210,
			};
	const innerStyle: CSSProperties = collapsed
		?
			{
				borderRadius: 20,
			}
		: borderStyle(hasText ? "var(--wf-border-tint)" : "var(--wf-border-primary)");

	const label = (
		// oxlint-disable-next-line jsx-a11y/label-has-associated-control -- upstream's bare label wraps the input; its placeholder names it
		<label className={labelClass(collapsed)} style={labelStyle}>
			<div className="flex items-center " style={innerStyle}>
				<input
					autoComplete="off"
					autoCorrect="off"
					name="pane-search"
					className={collapsed ? `${COMPACT_INPUT_CLASS} opacity-0 cursor-pointer` : COMPACT_INPUT_CLASS}
					data-handbook="search.search"
					data-pane-search-input="true"
					onBlur={() =>
					{
						setFocused(false);
					}}
					onChange={(event) =>
					{
						setValue(event.target.value);
						controller.change(event.target.value);
					}}
					onFocus={() =>
					{
						setFocused(true);
					}}
					onKeyDown={handleKeyDown}
					placeholder="Search"
					readOnly={!focused}
					ref={inputRef}
					type="text"
					value={value}
				/>
				<svg
					className={`svg-inline--fa fa-magnifying-glass ${collapsed ? "fa-1x absolute left-[10px] pt-xs" : "fa-sm absolute left-ml"} pointer-events-none`}
					data-icon="magnifying-glass"
					viewBox="0 0 512 512"
				>
					<path d={MAGNIFIER_PATH} fill="currentColor" />
				</svg>
				<div className="absolute top-0 right-[11px] h-full flex items-center justify-center">
					{hasText && (
						// oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- upstream's clear control is a bare svg
						<svg
							width="14"
							height="14"
							viewBox="0 0 14 14"
							className="cursor-pointer text-secondary"
							onMouseDown={(event) =>
							{
								event.preventDefault();
							}}
							onClick={clear}
						>
							<path clipRule="evenodd" d={CLEAR_PATH} fill="currentColor" fillRule="evenodd" />
						</svg>
					)}
				</div>
			</div>
		</label>
	);

	return <div className="flex items-center">{label}</div>;
}
