import {useCallback, useEffect, useMemo, useRef} from "react";
import type {ReactNode} from "react";
import {caretTextOffset, placeCaretAtTextOffset} from "../caret-dom.js";
import {MentionMenu} from "../components/mention-menu.js";
import {insertSuggestion, mentionGroups} from "../mention-options.js";
import type {MentionGroup, MentionOption} from "../mention-options.js";
import {renderMentionPills} from "../mention-pills.js";
import type {MentionAccount} from "../mention-pills.js";
import {MENTION_CHIP_CLASS, planMentionOpen, planMentionRearm} from "../mention-trigger.js";
import type {TagAutocompleteResponse} from "../../node-types.js";
import {readJson} from "../read-json.js";
import {useOutlineStore} from "../stores/outline.js";
import {useAccount} from "./use-account.js";
import {useSuggest} from "./use-suggest.js";
import type {SuggestClient, SuggestInputResult} from "./use-suggest.js";

interface MentionMenuOptions
{
	editorRef: React.RefObject<HTMLElement | null>;
	/** The editor's text changed outside a native input (the chip was unwrapped or removed). */
	onChange: () => void;
	/** An option was accepted: re-render the editor's tags and save now. */
	onAccept: () => void;
}

const TAG_LIMIT = 8;

async function fetchTags(term: string, zoomedId: string | null): Promise<string[]>
{
	const prefix = encodeURIComponent(term === "*" ? "@" : `@${term}`);
	const root = zoomedId === null ? "" : `&root=${encodeURIComponent(zoomedId)}&fallback=1`;
	const response = await fetch(`/api/v1/tags/autocomplete?prefix=${prefix}&limit=${TAG_LIMIT}${root}`);
	if (!response.ok)
	{
		return [];
	}
	return (await readJson<TagAutocompleteResponse>(response)).tags.map(({tag}) => tag);
}

/** Seconds since the account joined, like upstream's `WF.Updates.timestamp()`. */
function mentionTimestamp(joinedAt: string | undefined): number
{
	const joined = joinedAt === undefined ? Number.NaN : Date.parse(joinedAt);
	return Number.isNaN(joined) ? 0 : Math.max(0, Math.floor((Date.now() - joined) / 1000));
}

/**
 * A backspace that leaves the caret at the end of a resting `@tag` span turns the whole span back into plain text so
 * the shared engine can re-arm it as a chip (upstream replaces the tag span with a chip holding the remaining text).
 */
function unwrapRestingMention(editor: HTMLElement): void
{
	const selection = globalThis.getSelection();
	const focus = selection?.focusNode ?? null;
	if (selection === null || focus === null || !selection.isCollapsed)
	{
		return;
	}
	const tag = (focus instanceof Element ? focus : focus.parentElement)?.closest<HTMLElement>(
		'.contentTag[data-val^="@"]',
	);
	if (tag === null || tag === undefined || !editor.contains(tag))
	{
		return;
	}
	const before = document.createRange();
	before.setStart(tag, 0);
	before.setEnd(focus, selection.focusOffset);
	const text = tag.textContent;
	if (before.toString().length !== text.length)
	{
		return;
	}
	const node = document.createTextNode(text);
	tag.replaceWith(node);
	selection.collapse(node, text.length);
}

function neighborChar(node: Node | null, end: "first" | "last"): string
{
	const text = node?.textContent ?? "";
	return end === "first" ? text.slice(0, 1) : text.slice(-1);
}

/**
 * Upstream's `@` mention input (`editor.input.mention-autocomplete`): a `WF.Suggest` client with prefix `@`, solid and
 * strict, offering the current user (PEOPLE) and the zoom subtree's `@tags` (TAGS). Tags come from the existing tag
 * autocomplete route; until a term's response arrives the chip stays armed with the people it already knows.
 */
export function useMentionMenu({editorRef, onChange, onAccept}: MentionMenuOptions):
{
	handleInput: (event?: Event) => SuggestInputResult;
	handleKeyDown: (event: React.KeyboardEvent) => boolean;
	isOpen: () => boolean;
	detach: () => void;
	menu: ReactNode;
}
{
	const account = useAccount();
	const accountRef = useRef<MentionAccount>(account);
	useEffect(() =>
	{
		accountRef.current = account;
	}, [account]);
	const cache = useRef(new Map<string, string[]>());
	const pending = useRef(new Set<string>());
	const lastTags = useRef<string[]>([]);
	const refreshRef = useRef<() => void>(() => {});

	const search = useCallback((chipText: string): MentionGroup[] | null =>
	{
		if (!chipText.startsWith("@"))
		{
			return null;
		}
		const term = chipText.slice(1);
		const zoomedId = useOutlineStore.getState().zoomedNodeId;
		const key = `${zoomedId ?? ""}|${term.toLowerCase()}`;
		const hit = cache.current.get(key);
		if (hit === undefined && !pending.current.has(key))
		{
			pending.current.add(key);
			fetchTags(term, zoomedId)
				.catch((): string[] => [])
				.then((tags) =>
				{
					cache.current.set(key, tags);
					pending.current.delete(key);
					lastTags.current = tags;
					refreshRef.current();
					return tags;
				})
				.catch(() => {});
		}
		const lower = `@${term}`.toLowerCase();
		const tags = hit ?? lastTags.current.filter((tag) => term === "*" || tag.toLowerCase().startsWith(lower));
		const groups = mentionGroups(
			{
				term,
				account: accountRef.current,
				tags,
			},
		);
		if (groups.length === 0)
		{
			return hit === undefined ? [] : null;
		}
		return groups;
	}, []);

	const flat = useCallback(
		(groups: readonly MentionGroup[]): MentionOption[] => groups.flatMap((group) => group.options),
		[],
	);

	const client: SuggestClient<MentionGroup[], MentionOption> = useMemo(
		() => (
		{
			opts:
			{
				prefix: "@",
				solid: true,
				strict: true,
				chipClassName: MENTION_CHIP_CLASS,
			},
			planOpen: planMentionOpen,
			planRearm: planMentionRearm,
			search,
			count: (groups) => flat(groups).length,
			option: (groups, index) => flat(groups)[index],
			onChange,
			select: (option, {chip, replaceChip}) =>
			{
				const editor = editorRef.current;
				if (editor === null)
				{
					return;
				}
				const previous = neighborChar(chip.previousSibling, "last");
				const next = neighborChar(chip.nextSibling, "first");
				const chipText = chip.textContent;
				const inserted = option.kind === "tag" ? option.text : "";
				const result = insertSuggestion(
					previous + chipText + next,
					previous.length,
					previous.length + chipText.length,
					inserted,
				);
				const replacement = result.text.slice(previous.length, result.text.length - next.length);
				const lead = previous !== "" && previous !== " " ? " " : "";
				if (option.kind === "tag")
				{
					replaceChip(replacement);
					if (next === " ")
					{
						placeCaretAtTextOffset(editor, caretTextOffset(editor) + 1);
					}
					onAccept();
					return;
				}
				replaceChip(lead);
				const markup = `<mention id="${option.id}" by="${option.id}" ts="${mentionTimestamp(accountRef.current?.joinedAt)}"> </mention>`;
				const template = document.createElement("template");
				template.innerHTML = renderMentionPills(markup, accountRef.current);
				const pill = template.content.firstChild;
				const selection = globalThis.getSelection();
				if (pill === null || selection === null || selection.rangeCount === 0)
				{
					return;
				}
				const range = selection.getRangeAt(0);
				const trailing = document.createTextNode(next === " " ? "" : " ");
				range.insertNode(trailing);
				range.insertNode(pill);
				if (next === " " && trailing.nextSibling instanceof Text)
				{
					selection.collapse(trailing.nextSibling, 1);
				}
				else
				{
					selection.collapse(trailing, trailing.length);
				}
				onAccept();
			},
			renderMenu: (props) => (
				<MentionMenu
					groups={props.groups}
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
		[search, flat, onChange, onAccept, editorRef],
	);
	const suggest = useSuggest(
		{
			editorRef,
			client,
		},
	);
	const {handleInput: engineInput, refresh} = suggest;
	useEffect(() =>
	{
		refreshRef.current = refresh;
	}, [refresh]);

	const handleInput = useCallback(
		(event?: Event): SuggestInputResult =>
		{
			const editor = editorRef.current;
			const inputType = event instanceof InputEvent ? event.inputType : "";
			if (editor !== null && !suggest.isOpen() && inputType.startsWith("delete"))
			{
				unwrapRestingMention(editor);
			}
			return engineInput(event);
		},
		[editorRef, engineInput, suggest],
	);

	return {
		handleInput,
		handleKeyDown: suggest.handleKeyDown,
		isOpen: suggest.isOpen,
		detach: suggest.detach,
		menu: suggest.menu,
	};
}
