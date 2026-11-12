import {useCallback, useEffect, useLayoutEffect, useRef} from "react";
import type {RefObject} from "react";
import {placeCaretAtTextOffset, placeSelectionAtTextOffsets, selectionTextOffsets} from "../caret-dom.js";
import * as latestColor from "../latest-color.js";
import {pendingFormatApply, planInlineToggle} from "../rich-text.js";
import type {ColorChoice, ColorKind, InlineAttr} from "../rich-text.js";
import type {ColorName} from "../../color-palette.js";

/** Whether a collapsed caret can make `attr` pending: Code is atomic upstream, so Shift+Cmd+C at a caret does nothing. */
export function canBePending(attr: InlineAttr): boolean
{
	return attr !== "code";
}

/** `attrs` with `attr` toggled: a second toggle of the same attribute cancels the first. */
export function togglePendingAttr(attrs: ReadonlySet<InlineAttr>, attr: InlineAttr): Set<InlineAttr>
{
	const next = new Set(attrs);
	if (!next.delete(attr))
	{
		next.add(attr);
	}
	return next;
}

/** Inserts typed `text` at `pos`: its first character takes the pending attributes, the rest inherit from it, and every character takes the pending color. */
export function insertWithPendingFormat(
	html: string,
	pos: number,
	attrs: ReadonlySet<InlineAttr>,
	text: string,
	color?: ColorChoice,
): string
{
	let result = html;
	// oxlint-disable-next-line typescript/no-misused-spread -- rich-text counts code points, so each one is a character
	for (const [index, char] of [...text].entries())
	{
		result = pendingFormatApply(result, pos + index, index === 0 ? attrs : new Set(), char, color);
	}
	return result;
}

interface InlineFormatOptions
{
	editorRef: RefObject<HTMLElement | null>;
	/** The editor is mounted and editable. */
	active: boolean;
	/** The editor's content as stored HTML. */
	read: () => string;
	/** The editor's innerHTML for stored HTML. */
	render: (html: string) => string;
	/** The stored HTML changed. */
	onChange: (html: string) => void;
}

/**
 * Upstream's inline format commands for a contenteditable: a stretched selection toggles `attr` over the
 * whole range and stays selected; a collapsed caret makes the format pending (`WF.AppPendingInlineFormat`)
 * so the next typed character carries it. Pending formats clear on blur and when the caret moves.
 */
export function useInlineFormat({editorRef, active, read, render, onChange}: InlineFormatOptions)
{
	const io = useRef(
		{
			read,
			render,
			onChange,
		},
	);
	useLayoutEffect(() =>
	{
		io.current =
		{
			read,
			render,
			onChange,
		};
	});
	const pending = useRef<
	{
		attrs: Set<InlineAttr>;
		color?: ColorChoice;
		at: number;
	}>(
		{
			attrs: new Set(),
			at: -1,
		},
	);

	const applyInlineToggle = useCallback(
		(attr: InlineAttr) =>
		{
			const element = editorRef.current;
			if (element === null)
			{
				return;
			}
			const sel = selectionTextOffsets(element);
			if (sel.start === sel.end)
			{
				if (canBePending(attr))
				{
					const prior = pending.current;
					const attrs = prior.at === sel.start ? prior.attrs : new Set<InlineAttr>();
					pending.current =
					{
						attrs: togglePendingAttr(attrs, attr),
						at: sel.start,
						...(prior.at === sel.start && prior.color
							?
								{
									color: prior.color,
								}
							: {}),
					};
				}
				return;
			}
			pending.current =
			{
				attrs: new Set(),
				at: -1,
			};
			const plan = planInlineToggle(io.current.read(), sel, attr);
			element.innerHTML = io.current.render(plan.html);
			placeSelectionAtTextOffsets(element, plan.sel.start, plan.sel.end);
			io.current.onChange(plan.html);
		},
		[editorRef],
	);

	/** Applies the latest color to the selection (toggling it), as one change that keeps the selection. */
	const applyLatestToSelection = useCallback((element: HTMLElement) =>
	{
		const sel = selectionTextOffsets(element);
		pending.current =
		{
			attrs: new Set(),
			at: -1,
		};
		const html = latestColor.planApply(io.current.read(), sel.start, sel.end);
		element.innerHTML = io.current.render(html);
		placeSelectionAtTextOffsets(element, sel.start, sel.end);
		io.current.onChange(html);
	}, []);

	/**
	 * Upstream's `latestColor.applyToCaret` (the toolbar's font button and Shift+Cmd+H): a stretched selection toggles
	 * the latest color, a collapsed caret makes it pending. Returns false when no color was ever picked, so the
	 * caller opens the popup instead.
	 */
	const applyLatestColor = useCallback((): boolean =>
	{
		const element = editorRef.current;
		const latest = latestColor.get();
		if (element === null || latest === undefined)
		{
			return false;
		}
		const sel = selectionTextOffsets(element);
		if (sel.start === sel.end)
		{
			const attrs = pending.current.at === sel.start ? pending.current.attrs : new Set<InlineAttr>();
			const color = pending.current.at === sel.start ? pending.current.color : undefined;
			const same = color?.kind === latest.kind && color.color === latest.color;
			pending.current =
			{
				attrs,
				...(same
					? {}
					:
						{
							color: latest,
						}),
				at: sel.start,
			};
			return true;
		}
		applyLatestToSelection(element);
		return true;
	}, [applyLatestToSelection, editorRef]);

	/** A popup pick: `color` becomes the latest (null keeps it and removes the color once), then it is applied. */
	const applyColorToggle = useCallback(
		(kind: ColorKind, color: ColorName | null) =>
		{
			const element = editorRef.current;
			if (element === null)
			{
				return;
			}
			latestColor.change(kind, color);
			applyLatestToSelection(element);
		},
		[applyLatestToSelection, editorRef],
	);

	useEffect(() =>
	{
		const element = editorRef.current;
		if (!active || element === null)
		{
			// oxlint-disable-next-line unicorn/no-useless-undefined -- consistent-return needs a value beside the cleanup return
			return undefined;
		}
		const clear = () =>
		{
			pending.current =
			{
				attrs: new Set(),
				at: -1,
			};
		};
		const onBeforeInput = (event: InputEvent) =>
		{
			const {attrs, at, color} = pending.current;
			if (attrs.size === 0 && color === undefined)
			{
				return;
			}
			const sel = selectionTextOffsets(element);
			clear();
			if (event.inputType !== "insertText" || !event.data || sel.start !== at || sel.end !== at)
			{
				return;
			}
			event.preventDefault();
			const html = insertWithPendingFormat(io.current.read(), at, attrs, event.data, color);
			element.innerHTML = io.current.render(html);
			placeCaretAtTextOffset(element, at + event.data.length);
			io.current.onChange(html);
		};
		element.addEventListener("beforeinput", onBeforeInput);
		element.addEventListener("blur", clear);
		return () =>
		{
			element.removeEventListener("beforeinput", onBeforeInput);
			element.removeEventListener("blur", clear);
		};
	}, [active, editorRef]);

	return {
		applyInlineToggle,
		applyLatestColor,
		applyColorToggle,
	};
}
