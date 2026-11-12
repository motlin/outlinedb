import {useLayoutEffect, useReducer, useRef} from "react";
import type {KeyboardEvent} from "react";
import {isMacPlatform} from "../editable-text-keys.js";
import
{
	PALETTE_CHIP_CLASS,
	initialPaletteState,
	paletteEntries,
	paletteFooterCount,
	paletteHotkeys,
	paletteReducer,
	paletteRowClass,
} from "../command-palette-model.js";
import type {PaletteEntry} from "../command-palette-model.js";
import {activeCommandRegistry} from "../hooks/use-global-keymap.js";
import {hotkeyTable} from "../keys/dispatch.js";
import {useOutlineStore} from "../stores/outline.js";
import {DialogShell} from "./dialog-shell.js";
import {domkitInputClass} from "./domkit-input.js";

export interface CommandPaletteProps
{
	entries: readonly PaletteEntry[];
	hotkeys: Readonly<Record<string, string>>;
	itemCount: number;
	onExecute: (key: string) => void;
	onClose: () => void;
}

/** Upstream Labs command palette (alt+w): fuzzy search over command ids, arrows move, Enter runs. */
export function CommandPalette({entries, hotkeys, itemCount, onExecute, onClose}: CommandPaletteProps)
{
	const [state, dispatch] = useReducer(paletteReducer, entries, initialPaletteState);
	const listRef = useRef<HTMLDivElement>(null);
	useLayoutEffect(() =>
	{
		listRef.current?.children[state.idx]?.scrollIntoView(
			{
				block: "nearest",
			},
		);
	}, [state.idx]);

	const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) =>
	{
		if (event.key === "Escape")
		{
			return;
		}
		event.stopPropagation();
		if (event.key === "ArrowDown" || event.key === "ArrowUp")
		{
			event.preventDefault();
			dispatch(
				{
					type: event.key === "ArrowDown" ? "MOVE_DOWN" : "MOVE_UP",
				},
			);
		}
		else if (event.key === "Enter")
		{
			event.preventDefault();
			const row = state.list[state.idx];
			if (row?.disabled === null)
			{
				onExecute(row.key);
			}
		}
	};

	return (
		<DialogShell open instant padding="none" onClose={onClose}>
			<div className="flex flex-col gap-m overflow-hidden">
				<div className="px-m pt-m">
					<div className="flex flex-col w-full">
						<input
							type="text"
							name="command-palette"
							// oxlint-disable-next-line jsx-a11y/no-autofocus -- upstream focuses the palette input on open
							autoFocus
							className={domkitInputClass()}
							value={state.term}
							onChange={(event) =>
							{
								dispatch(
									{
										type: "SEARCH",
										term: event.target.value,
									},
								);
							}}
							onKeyDown={onKeyDown}
						/>
					</div>
				</div>
				<div className="px-m overflow-auto" ref={listRef}>
					{state.list.map((entry, index) => (
						// oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- upstream rows swallow clicks
						<div
							key={entry.key}
							title={entry.disabled ?? ""}
							aria-disabled={entry.disabled !== null}
							className={paletteRowClass(index === state.idx)}
							onClick={() =>
							{
							}}
						>
							<div className="flex-1">{entry.key}</div>
							{hotkeys[entry.key] !== undefined && (
								// oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- upstream chips have an empty handler
								<div
									className={PALETTE_CHIP_CLASS}
									onClick={() =>
									{
									}}
								>
									{hotkeys[entry.key]}
								</div>
							)}
						</div>
					))}
				</div>
				<div className="px-m py-s bg-secondary">
					<div className="flex text-s font-mono items-center">
						<div>{paletteFooterCount(itemCount)}</div>
						<div className="flex-1" />
						<div>{`${state.list.length} / ${entries.length}`}</div>
						<div className="pl-m text-2xs">
							<span className="bg-info px-xs py-2xs rounded-xs">Labs</span>
						</div>
					</div>
				</div>
			</div>
		</DialogShell>
	);
}

/** Mounts the palette while the store holds one; entries and hotkeys are captured at open. */
export function CommandPaletteHost()
{
	const palette = useOutlineStore((state) => state.commandPalette);
	const closeCommandPalette = useOutlineStore((state) => state.closeCommandPalette);
	if (palette === null)
	{
		return null;
	}
	const {ctx} = palette;
	return (
		<CommandPalette
			entries={paletteEntries(activeCommandRegistry(), ctx)}
			hotkeys={paletteHotkeys([...hotkeyTable(isMacPlatform())])}
			itemCount={ctx.items.length}
			onClose={() =>
			{
				closeCommandPalette("cancel");
			}}
			onExecute={(key) =>
			{
				closeCommandPalette("execute");
				activeCommandRegistry()[key]?.execute(ctx);
			}}
		/>
	);
}
