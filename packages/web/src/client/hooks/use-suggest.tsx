import {useCallback, useEffect, useLayoutEffect, useRef, useState} from "react";
import type {ReactNode} from "react";
import {placeCaretAtTextOffset, unitsBefore} from "../caret-dom.js";
import {pop, unpop} from "../popups.js";
import {suggestInputAction, suggestKeyAction, suggestMode} from "../suggest/suggest-engine.js";
import type {SuggestOptions} from "../suggest/suggest-engine.js";
import {useOutlineStore} from "../stores/outline.js";

export interface SuggestRange
{
	readonly start: number;
	readonly end: number;
}

export interface SuggestOpen<G>
{
	groups: G;
	index: number;
	keyboardMode: boolean;
	/** The chip's bottom-left in document coordinates. */
	left: number;
	top: number;
}

export interface SuggestMenuProps<G> extends SuggestOpen<G>
{
	onSelect: (index: number) => void;
	onHover: (index: number) => void;
	onMouseMove: () => void;
}

export interface SuggestSelectContext
{
	chip: HTMLElement;
	/** Replace the chip with `text` as plain text and close the menu; the caret goes to the end of it. */
	replaceChip: (text: string) => void;
	/** The chip's rect, taken before it was replaced. */
	anchorRect: DOMRect;
}

/** A client of the shared engine: upstream's `WF.Suggest.for` options plus its search and popup. */
export interface SuggestClient<G, O>
{
	opts: SuggestOptions;
	planOpen: (text: string, index: number) => SuggestRange | null;
	planRearm: (text: string, caret: number) => SuggestRange | null;
	/** The groups for the chip's text, or null when there are no results. */
	search: (chipText: string) => G | null;
	count: (groups: G) => number;
	option: (groups: G, index: number) => O | undefined;
	/** The chip was armed (a new open, not a re-search). */
	onArm?: (chip: HTMLElement) => void;
	select: (option: O, context: SuggestSelectContext) => void;
	/** Called after the chip is replaced or removed and the editor's text changed outside a native input. */
	onChange: () => void;
	renderMenu: (props: SuggestMenuProps<G>) => ReactNode;
}

export interface SuggestInputResult
{
	armedBefore: boolean;
	armedAfter: boolean;
}

/** The selection's collapsed caret inside `editor` when it sits in a text node there. */
function caretTextNode(editor: HTMLElement):
{
	node: Text;
	offset: number;
} | null
{
	const selection = globalThis.getSelection();
	if (selection === null || !selection.isCollapsed || selection.rangeCount === 0)
	{
		return null;
	}
	const {focusNode, focusOffset} = selection;
	if (!(focusNode instanceof Text) || !editor.contains(focusNode))
	{
		return null;
	}
	return {
		node: focusNode,
		offset: focusOffset,
	};
}

/** Wraps `range` of `node` in a chip and puts the caret at the end of the chip's text node. */
function wrapChip(node: Text, range: SuggestRange, className: string): HTMLSpanElement
{
	const chipText = node.splitText(range.start);
	chipText.splitText(range.end - range.start);
	const chip = document.createElement("span");
	chip.className = className;
	chipText.replaceWith(chip);
	chip.append(chipText);
	const caret = document.createRange();
	caret.setStart(chipText, chipText.length);
	caret.collapse(true);
	const selection = globalThis.getSelection();
	selection?.removeAllRanges();
	selection?.addRange(caret);
	return chip;
}

function chipAnchor(chip: HTMLElement):
{
	left: number;
	top: number;
}
{
	const rect = chip.getBoundingClientRect();
	return {
		left: rect.left + globalThis.scrollX,
		top: rect.bottom + globalThis.scrollY,
	};
}

interface TriggerEntry
{
	editorRef: React.RefObject<HTMLElement | null>;
	trigger: () => boolean;
}

const triggerEntries = new Set<TriggerEntry>();

/**
 * Upstream's `WF.Suggest.trigger()`: re-runs the open planners as if the character before the caret had just
 * been typed. Command-inserted prefixes (`insert_at_tag`) use it. Returns whether a chip armed.
 */
export function triggerSuggest(editor: HTMLElement): boolean
{
	for (const entry of triggerEntries)
	{
		if (entry.editorRef.current === editor && entry.trigger())
		{
			return true;
		}
	}
	return false;
}

interface SuggestOptionsInput<G, O>
{
	editorRef: React.RefObject<HTMLElement | null>;
	client: SuggestClient<G, O>;
}

/**
 * The shared chip engine (upstream's `WF.Suggest`): typing the client's prefix wraps it in a chip and opens the
 * client's popup under it; every input re-searches the chip, and a deleting input re-arms a nearby prefix. Call
 * `handleKeyDown` first in the editor's keydown handler: it returns true when the popup took the key. While the
 * chip is armed the editor must not schedule saves (`isOpen`), and `handleInput` reports whether the input was
 * consumed by a chip so later typed-input hooks can be skipped.
 */
export function useSuggest<G, O>({
	editorRef,
	client,
}: SuggestOptionsInput<G, O>):
{
	handleInput: (event?: Event) => SuggestInputResult;
	handleKeyDown: (event: React.KeyboardEvent) => boolean;
	isOpen: () => boolean;
	detach: () => void;
	/** Re-run the client's search for the armed chip (an async result arrived); a strict client with no results abandons. */
	refresh: () => void;
	menu: ReactNode;
}
{
	const clientRef = useRef(client);
	useLayoutEffect(() =>
	{
		clientRef.current = client;
	});
	const [open, setOpenState] = useState<SuggestOpen<G> | null>(null);
	const openRef = useRef<SuggestOpen<G> | null>(null);
	const chipRef = useRef<HTMLSpanElement | null>(null);
	const setOpen = useCallback((next: SuggestOpen<G> | null) =>
	{
		openRef.current = next;
		setOpenState(next);
	}, []);

	/**
	 * Replace the chip with `text` (its own text when omitted) as a plain text node and close the menu.
	 * The caret goes to the end of the replacement when `caretAtEnd`, else stays where it was when it
	 * was in the editor. Returns the replacement's start offset in the editor's text.
	 */
	const disarm = useCallback(
		({text, caretAtEnd}: {text?: string; caretAtEnd: boolean}): number | null =>
		{
			const chip = chipRef.current;
			const editor = editorRef.current;
			chipRef.current = null;
			if (chip !== null)
			{
				unpop("suggest");
			}
			if (openRef.current !== null)
			{
				setOpen(null);
			}
			if (chip === null || editor === null || !chip.isConnected)
			{
				return null;
			}
			const start = unitsBefore(editor, chip, 0);
			const replacement = text ?? chip.textContent;
			const selection = globalThis.getSelection();
			const caretInEditor =
				selection !== null && selection.rangeCount > 0 && editor.contains(selection.focusNode);
			const caret =
				caretInEditor && selection.focusNode !== null
					? unitsBefore(editor, selection.focusNode, selection.focusOffset)
					: null;
			chip.replaceWith(document.createTextNode(replacement));
			editor.normalize();
			if (caretAtEnd)
			{
				placeCaretAtTextOffset(editor, start + replacement.length);
			}
			else if (caret !== null)
			{
				placeCaretAtTextOffset(editor, Math.min(caret, start + replacement.length));
			}
			return start;
		},
		[editorRef, setOpen],
	);

	const onChange = useCallback(() =>
	{
		clientRef.current.onChange();
	}, []);

	const detach = useCallback(() =>
	{
		if (chipRef.current !== null || openRef.current !== null)
		{
			disarm(
				{
					caretAtEnd: false,
				},
			);
			onChange();
		}
	}, [disarm, onChange]);

	const arm = useCallback(
		(node: Text, range: SuggestRange): boolean =>
		{
			const current = clientRef.current;
			const groups = current.search(node.data.slice(range.start, range.end));
			if (groups === null)
			{
				return false;
			}
			const chip = wrapChip(node, range, current.opts.chipClassName);
			chipRef.current = chip;
			pop("suggest", chip);
			setOpen(
				{
					groups,
					index: 0,
					keyboardMode: true,
					...chipAnchor(chip),
				},
			);
			current.onArm?.(chip);
			return true;
		},
		[setOpen],
	);

	/** Arm on the character before the caret as if `inputType` had just typed it. */
	const openFromCaret = useCallback(
		(inputType: string): boolean =>
		{
			const editor = editorRef.current;
			if (editor === null)
			{
				return false;
			}
			const caret = caretTextNode(editor);
			if (caret === null)
			{
				return false;
			}
			const current = clientRef.current;
			if (inputType.startsWith("insert") && caret.node.data[caret.offset - 1] === current.opts.prefix)
			{
				const range = current.planOpen(caret.node.data, caret.offset - 1);
				return range !== null && arm(caret.node, range);
			}
			if (inputType.startsWith("delete"))
			{
				const range = current.planRearm(caret.node.data, caret.offset);
				return range !== null && arm(caret.node, range);
			}
			return false;
		},
		[arm, editorRef],
	);

	const handleInput = useCallback(
		(event?: Event): SuggestInputResult =>
		{
			const editor = editorRef.current;
			if (editor === null)
			{
				return {
					armedBefore: false,
					armedAfter: false,
				};
			}
			const chip = chipRef.current;
			const inputEvent = event instanceof InputEvent ? event : undefined;
			const inputType = inputEvent?.inputType ?? "";
			if (chip !== null)
			{
				const current = clientRef.current;
				const groups = chip.isConnected ? current.search(chip.textContent) : null;
				const action = suggestInputAction(
					{
						chipText: chip.textContent,
						inserted: inputEvent?.data ?? null,
						deleting: inputType.startsWith("delete"),
						composing: inputEvent?.isComposing === true,
						resultsEmpty: groups === null,
						opts: current.opts,
					},
				);
				if (action === "abandon" || !chip.isConnected)
				{
					disarm(
						{
							caretAtEnd: false,
						},
					);
					return {
						armedBefore: true,
						armedAfter: false,
					};
				}
				setOpen(
					groups === null
						? null
						:
							{
								groups,
								index: 0,
								keyboardMode: true,
								...chipAnchor(chip),
							},
				);
				return {
					armedBefore: true,
					armedAfter: true,
				};
			}
			return {
				armedBefore: false,
				armedAfter: openFromCaret(inputType),
			};
		},
		[disarm, editorRef, openFromCaret, setOpen],
	);

	useEffect(() =>
	{
		const entry: TriggerEntry =
		{
			editorRef,
			trigger: () => openFromCaret("insertText"),
		};
		triggerEntries.add(entry);
		return () =>
		{
			triggerEntries.delete(entry);
			if (chipRef.current !== null)
			{
				chipRef.current = null;
				unpop("suggest");
			}
		};
	}, [editorRef, openFromCaret]);

	const run = useCallback(
		(index: number) =>
		{
			const current = openRef.current;
			const chip = chipRef.current;
			const owner = clientRef.current;
			const option = current === null ? undefined : owner.option(current.groups, index);
			if (option === undefined || chip === null)
			{
				return;
			}
			const anchorRect = chip.getBoundingClientRect();
			owner.select(
				option,
				{
					chip,
					anchorRect,
					replaceChip: (text) =>
					{
						disarm(
							{
								text,
								caretAtEnd: true,
							},
						);
					},
				},
			);
		},
		[disarm],
	);

	const handleKeyDown = useCallback(
		(event: React.KeyboardEvent): boolean =>
		{
			const current = openRef.current;
			const chip = chipRef.current;
			if (chip === null || event.nativeEvent.isComposing)
			{
				return false;
			}
			const caret = editorRef.current === null ? null : caretTextNode(editorRef.current);
			const action = suggestKeyAction(
				{
					key: event.key,
					ctrlKey: event.ctrlKey,
					metaKey: event.metaKey,
					caretAtChipEnd: caret !== null && chip.contains(caret.node) && caret.offset === caret.node.length,
				},
			);
			if (action === null)
			{
				return false;
			}
			if (action === "disarmNoAbandon")
			{
				// Upstream removes the chip and its text and swallows the key: the app's undo never runs.
				event.preventDefault();
				event.stopPropagation();
				disarm(
					{
						text: "",
						caretAtEnd: true,
					},
				);
				onChange();
				return true;
			}
			if (current === null)
			{
				return false;
			}
			event.preventDefault();
			event.stopPropagation();
			const count = clientRef.current.count(current.groups);
			switch (action)
			{
				case "down":
				case "up":
				{
					if (count === 0)
					{
						break;
					}
					const step = action === "down" ? 1 : -1;
					setOpen(
						{
							...current,
							index: (current.index + step + count) % count,
							keyboardMode: true,
						},
					);
					break;
				}
				case "select":
				{
					run(current.index);
					break;
				}
				case "abandon":
				{
					// The caret keeps its offset inside the replaced text.
					disarm(
						{
							caretAtEnd: false,
						},
					);
					onChange();
					break;
				}
			}
			return true;
		},
		[disarm, editorRef, onChange, run, setOpen],
	);

	// The caret leaving the chip (a click elsewhere, ArrowLeft past it) disarms and keeps the text.
	useEffect(() =>
	{
		if (open === null)
		{
			// oxlint-disable-next-line unicorn/no-useless-undefined -- consistent-return needs a value beside the cleanup return
			return undefined;
		}
		const onSelectionChange = () =>
		{
			const chip = chipRef.current;
			const focus = globalThis.getSelection()?.focusNode ?? null;
			if (chip !== null && (focus === null || !chip.contains(focus)))
			{
				detach();
			}
		};
		document.addEventListener("selectionchange", onSelectionChange);
		return () =>
		{
			document.removeEventListener("selectionchange", onSelectionChange);
		};
	}, [open, detach]);

	// Navigating to another location disarms.
	useEffect(
		() =>
			useOutlineStore.subscribe((state, previous) =>
			{
				if (state.zoomedNodeId !== previous.zoomedNodeId)
				{
					detach();
				}
			}),
		[detach],
	);

	const isOpen = useCallback(() => chipRef.current !== null, []);

	const refresh = useCallback(() =>
	{
		const chip = chipRef.current;
		const current = openRef.current;
		if (chip === null || current === null || !chip.isConnected)
		{
			return;
		}
		const owner = clientRef.current;
		const groups = owner.search(chip.textContent);
		if (groups === null)
		{
			if (owner.opts.strict === true)
			{
				disarm(
					{
						caretAtEnd: false,
					},
				);
				onChange();
			}
			return;
		}
		setOpen(
			{
				...current,
				groups,
				index: Math.min(current.index, Math.max(0, owner.count(groups) - 1)),
			},
		);
	}, [disarm, onChange, setOpen]);

	const hover = useCallback(
		(index: number) =>
		{
			const current = openRef.current;
			if (current !== null)
			{
				const mode = suggestMode(
					{
						index: current.index,
						hidden: false,
						keyboardMode: current.keyboardMode,
					},
					{
						type: "hover",
						index,
					},
				);
				setOpen(
					{
						...current,
						index: mode.index,
						keyboardMode: mode.keyboardMode,
					},
				);
			}
		},
		[setOpen],
	);
	const mouseMove = useCallback(() =>
	{
		const current = openRef.current;
		if (current?.keyboardMode === true)
		{
			setOpen(
				{
					...current,
					keyboardMode: false,
				},
			);
		}
	}, [setOpen]);

	const menu =
		open === null
			? null
			: client.renderMenu(
					// oxlint-disable-next-line react/refs -- `run` reads the latest client from the ref only in event handlers
					{
						...open,
						onSelect: run,
						onHover: hover,
						onMouseMove: mouseMove,
					},
				);

	return {
		handleInput,
		handleKeyDown,
		isOpen,
		detach,
		refresh,
		menu,
	};
}
