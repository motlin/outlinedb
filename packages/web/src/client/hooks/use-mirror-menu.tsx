import {useCallback, useEffect, useMemo, useRef} from "react";
import type {ReactNode} from "react";
import {MirrorMenu} from "../components/mirror-menu.js";
import type {MirrorHit} from "../components/mirror-menu.js";
import {serializeEditorHtml} from "../editor-html.js";
import {planMirrorOpen, planMirrorRearm} from "../inline-mirror.js";
import type {LocationResponse} from "../../node-types.js";
import {readJson} from "../read-json.js";
import {useSuggest} from "./use-suggest.js";
import type {SuggestClient, SuggestInputResult} from "./use-suggest.js";

const MIRROR_CHIP_CLASS = "mirror-input";

const SEARCH_LIMIT = 20;

/** What the row held around the `((query))` when a location was chosen. */
export interface MirrorPick
{
	hit: MirrorHit;
	/** The row's html before the chip and after the closing `))`. */
	beforeHtml: string;
	afterHtml: string;
}

interface MirrorMenuOptions
{
	editorRef: React.RefObject<HTMLElement | null>;
	/** The editor's text changed outside a native input (the chip was unwrapped or removed). */
	onChange: () => void;
	/** A location was chosen; the row has been cut down to its text before and after the `((…))`. */
	onPick: (pick: MirrorPick) => void;
}

async function fetchHits(query: string): Promise<MirrorHit[]>
{
	const response = await fetch(
		"/api/search/locations",
		{
			method: "POST",
			headers:
			{
				"Content-Type": "application/json",
			},
			body: JSON.stringify(
				{
					query,
					limit: SEARCH_LIMIT,
				},
			),
		},
	);
	return response.ok ? (await readJson<LocationResponse>(response)).results : [];
}

function rangeHtml(range: Range): string
{
	const holder = document.createElement("div");
	holder.append(range.cloneContents());
	return serializeEditorHtml(holder.innerHTML);
}

/** Unwraps a live `((` chip to its plain text so it is never persisted. */
const MIRROR_CHIP_PATTERN = new RegExp(`<span class="${MIRROR_CHIP_CLASS}">([^<]*)</span>`, "gu");
export function stripMirrorChip(html: string): string
{
	return html.replaceAll(MIRROR_CHIP_PATTERN, "$1");
}

/**
 * Upstream's `((` inline mirror popup (`MIRROR_SEARCH_POPUP`): typing `((` arms a chip, auto-closes to `((…))` and
 * offers locations matching the text between the parentheses under a "mirror from" header.
 */
export function useMirrorMenu({editorRef, onChange, onPick}: MirrorMenuOptions):
{
	handleInput: (event?: Event) => SuggestInputResult;
	handleKeyDown: (event: React.KeyboardEvent) => boolean;
	isOpen: () => boolean;
	detach: () => void;
	menu: ReactNode;
}
{
	const cache = useRef(new Map<string, MirrorHit[]>());
	const pending = useRef(new Set<string>());
	const last = useRef<MirrorHit[]>([]);
	const refreshRef = useRef<() => void>(() => {});

	const search = useCallback((chipText: string): MirrorHit[] | null =>
	{
		const query = chipText.startsWith("((") ? chipText.slice(2).trim() : "";
		if (query === "")
		{
			return [];
		}
		const hit = cache.current.get(query);
		if (hit === undefined && !pending.current.has(query))
		{
			pending.current.add(query);
			fetchHits(query)
				.catch((): MirrorHit[] => [])
				.then((hits) =>
				{
					cache.current.set(query, hits);
					pending.current.delete(query);
					last.current = hits;
					refreshRef.current();
					return hits;
				})
				.catch(() => {});
		}
		return hit ?? last.current;
	}, []);

	const client: SuggestClient<MirrorHit[], MirrorHit> = useMemo(
		() => (
		{
			opts:
			{
				prefix: "(",
				chipClassName: MIRROR_CHIP_CLASS,
			},
			planOpen: planMirrorOpen,
			planRearm: planMirrorRearm,
			search,
			count: (hits) => hits.length,
			option: (hits, index) => hits[index],
			// Upstream auto-closes: `((` becomes `(())` with the caret between.
			onArm: (chip) =>
			{
				chip.after(document.createTextNode("))"));
			},
			onChange,
			select: (hit, {chip, replaceChip}) =>
			{
				const editor = editorRef.current;
				if (editor === null)
				{
					return;
				}
				const closing =
					chip.nextSibling instanceof Text && chip.nextSibling.data.startsWith("))")
						? chip.nextSibling
						: null;
				const before = document.createRange();
				before.selectNodeContents(editor);
				before.setEndBefore(chip);
				const after = document.createRange();
				after.selectNodeContents(editor);
				if (closing === null)
				{
					after.setStartAfter(chip);
				}
				else
				{
					after.setStart(closing, 2);
				}
				const pick: MirrorPick =
				{
					hit,
					beforeHtml: rangeHtml(before),
					afterHtml: rangeHtml(after),
				};
				replaceChip("");
				onPick(pick);
			},
			renderMenu: (props) => (
				<MirrorMenu
					hits={props.groups}
					index={props.index}
					keyboardMode={props.keyboardMode}
					left={props.left}
					top={props.top}
					onSelect={props.onSelect}
					onHover={props.onHover}
					onMouseMove={props.onMouseMove}
				/>
			),
		}),
		[search, onChange, onPick, editorRef],
	);
	const suggest = useSuggest(
		{
			editorRef,
			client,
		},
	);
	const {refresh} = suggest;
	useEffect(() =>
	{
		refreshRef.current = refresh;
	}, [refresh]);
	return {
		handleInput: suggest.handleInput,
		handleKeyDown: suggest.handleKeyDown,
		isOpen: suggest.isOpen,
		detach: suggest.detach,
		menu: suggest.menu,
	};
}
