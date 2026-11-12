import {memo, useCallback, useEffect, useMemo, useRef, useState} from "react";
import {StarButton} from "./star-button.js";
import type {CSSProperties, KeyboardEvent} from "react";
import {useQuery, useQueryClient} from "@tanstack/react-query";
import {useStableNavigate} from "../hooks/use-stable-navigate.js";
import {isMacPlatform} from "../editable-text-keys.js";
import {useBreakpoint} from "../hooks/use-breakpoint.js";
import {focusOutline} from "../hooks/use-search-escape.js";
import type {HelperTags, TagAutocompleteResponse} from "../../node-types.js";
import {readJson} from "../read-json.js";
import {borderStyle, createSearchBoxController} from "../search-box-model.js";
import {operatorAutocomplete, tagAutocompleteRows} from "../search/autocomplete-values.js";
import type {AutocompleteRow} from "../search/autocomplete-values.js";
import {insertHelperValue, replaceSearchWord, wordAt} from "../search/helper-insert.js";
import {useDateSettings} from "../hooks/use-preferences.js";
import {NO_HELPER_SELECTION, chipNeighbor, helperKey} from "../search/helper-keys.js";
import type {ChipGeometry, HelperSelection} from "../search/helper-keys.js";
import {useOutlineStore} from "../stores/outline.js";
import {SearchAutocomplete} from "./search-autocomplete.js";
import {SearchHelpers, helperSections} from "./search-helpers.js";
import type {HelperTagLists} from "./search-helpers.js";

/** Upstream's label class; the collapsed circle adds its hover tint before `searchBox`. */
export function labelClass(collapsed: boolean): string
{
	return `relative shrink-0 max-w-[60vw] transition-[width] duration-300 ease-base ${collapsed ? "hover:!bg-tertiary " : ""}searchBox`;
}
const INPUT_BASE_CLASS =
	"m-0 w-full py-[7px] pl-[30px] box-border font-[inherit] leading-[16px] border-transparent rounded-[16px] bg-transparent placeholder:text-primary";
const INPUT_CLASS = `${INPUT_BASE_CLASS} pr-[72px] searchBoxInput`;
export const COMPACT_INPUT_CLASS = `${INPUT_BASE_CLASS} transition-opacity duration-[400ms] ease-base searchBoxInput`;
const FOCUSED_INNER_CLASS =
	"flex items-center after:content-[''] after:absolute after:z-1 after:top-full after:left-[5%] after:right-[5%] after:bottom-0 after:-mt-px after:h-px";

export const MAGNIFIER_PATH =
	"M384 208A176 176 0 1 0 32 208a176 176 0 1 0 352 0zM343.3 366C307 397.2 259.7 416 208 416C93.1 416 0 322.9 0 208S93.1 0 208 0S416 93.1 416 208c0 51.7-18.8 99-50 135.3L507.3 484.7c6.2 6.2 6.2 16.4 0 22.6s-16.4 6.2-22.6 0L343.3 366z";
export const CLEAR_PATH =
	"M14 7C14 10.866 10.8662 14 7 14C3.13379 14 0 10.866 0 7C0 3.134 3.13379 0 7 0C10.8662 0 14 3.134 14 7ZM5.03027 3.96967C4.7373 3.67679 4.2627 3.67679 3.96973 3.96967C3.67676 4.26257 3.67676 4.73743 3.96973 5.03033L5.93945 7L3.96973 8.96967C3.67676 9.26257 3.67676 9.73743 3.96973 10.0303C4.2627 10.3232 4.7373 10.3232 5.03027 10.0303L7 8.06067L8.96973 10.0303C9.2627 10.3232 9.7373 10.3232 10.0303 10.0303C10.3232 9.73743 10.3232 9.26257 10.0303 8.96967L8.06055 7L10.0303 5.03033C10.3232 4.73743 10.3232 4.26257 10.0303 3.96967C9.7373 3.67679 9.2627 3.67679 8.96973 3.96967L7 5.93933L5.03027 3.96967Z";

const NO_HELPER_TAGS: HelperTagLists =
{
	hashTags: [],
	atTags: [],
};

async function fetchHelperTags(rootId: string | null): Promise<HelperTagLists>
{
	const response = await fetch(`/api/search/helpers?rootId=${encodeURIComponent(rootId ?? "")}`);
	if (!response.ok)
	{
		throw new Error(`Failed to fetch search helpers: ${response.statusText}`);
	}
	return readJson<HelperTags>(response);
}

const CARET_WORD_DEBOUNCE_MS = 50;
const AUTOCOMPLETE_TAG_LIMIT = 8;
const NO_AUTOCOMPLETE_TAGS: readonly string[] = [];

async function fetchAutocompleteTags(rootId: string | null, word: string): Promise<string[]>
{
	const params = new URLSearchParams(
		{
			root: rootId ?? "",
			prefix: word,
			limit: String(AUTOCOMPLETE_TAG_LIMIT),
			fallback: rootId === null ? "0" : "1",
		},
	);
	const response = await fetch(`/api/v1/tags/autocomplete?${params}`);
	if (!response.ok)
	{
		throw new Error(`Failed to fetch search autocomplete tags: ${response.statusText}`);
	}
	return (await readJson<TagAutocompleteResponse>(response)).tags.map(({tag}) => tag);
}

function rectOf(element: Element)
{
	const {left, top, width, height} = element.getBoundingClientRect();
	return {
		left,
		top,
		width,
		height,
	};
}

/** The open helper panel's chips as geometry for upstream's `elementFromPoint` Up/Down navigation. */
function chipLayout(flyout: HTMLElement | null)
{
	const items = [...(flyout?.querySelectorAll<HTMLElement>("a.menuItem") ?? [])];
	const wrappers = items.map((item) => item.parentElement);
	const geometry: ChipGeometry[] = items.map((item, index) => (
	{
		wrapper: rectOf(wrappers[index] ?? item),
		item: rectOf(item),
		offsetTop: item.offsetTop,
	}));
	const container = wrappers[0]?.parentElement?.parentElement;
	const containerBottom =
		container === null || container === undefined ? 0 : container.getBoundingClientRect().bottom;
	const hit = (x: number, y: number): number =>
	{
		const found = document.elementFromPoint(x, y);
		return found === null ? -1 : wrappers.findIndex((wrapper) => wrapper?.contains(found) === true);
	};
	return {
		geometry,
		containerBottom,
		hit,
	};
}

/**
 * Upstream header search box (label.searchBox): a 210px pill that widens to 320px on focus and
 * collapses to a borderless 36px circle with a plain magnifier below 1000px while empty and unfocused.
 */
export const SearchBox = memo(function SearchBox()
{
	const searchInput = useOutlineStore((state) => state.searchInput);
	const setSearchInput = useOutlineStore((state) => state.setSearchInput);
	const focused = useOutlineStore((state) => state.searchFocused);
	const setSearchFocused = useOutlineStore((state) => state.setSearchFocused);
	const navigate = useStableNavigate();
	const queryClient = useQueryClient();
	const controller = useMemo(
		() =>
			createSearchBoxController(
				{
					commit: (query) =>
					{
						useOutlineStore.getState().commitSearch(query, navigate);
					},
					getCommitted: () => useOutlineStore.getState().searchQuery,
				},
			),
		[navigate],
	);
	useEffect(() => controller.dispose, [controller]);
	const wide = useBreakpoint(1000);
	const [armed, setArmed] = useState(false);
	const zoomedNodeId = useOutlineStore((state) => state.zoomedNodeId);
	const {data: helperTags = NO_HELPER_TAGS} = useQuery(
		{
			queryKey: ["search-helpers", zoomedNodeId],
			queryFn: async () => fetchHelperTags(zoomedNodeId),
			enabled: focused,
		},
	);
	const [helper, setHelper] = useState<HelperSelection>(NO_HELPER_SELECTION);
	const [canHover, setCanHover] = useState(false);
	const [keyboardMode, setKeyboardMode] = useState(false);
	const inputRef = useRef<HTMLInputElement>(null);
	const flyoutRef = useRef<HTMLDivElement>(null);
	const committedQuery = useOutlineStore((state) => state.searchQuery);
	const dateSettings = useDateSettings();
	const [caret, setCaret] = useState(
		{
			word: "",
			now: new Date(0),
		},
	);
	const caretWord = caret.word;
	const setCaretWord = useCallback((word: string) =>
	{
		setCaret(
			{
				word,
				now: new Date(),
			},
		);
	}, []);
	const caretTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const tagWord = caretWord.startsWith("#") || caretWord.startsWith("@");
	const {data: autocompleteTags = NO_AUTOCOMPLETE_TAGS} = useQuery(
		{
			queryKey: ["search-autocomplete-tags", zoomedNodeId, caretWord],
			queryFn: async () => fetchAutocompleteTags(zoomedNodeId, caretWord),
			enabled: focused && tagWord,
		},
	);
	const autocompleteRows = useMemo(
		() =>
			focused
				? tagWord
					? tagAutocompleteRows(caretWord, autocompleteTags)
					: operatorAutocomplete(
							caretWord,
							{
								...dateSettings,
								now: caret.now,
							},
						)
				: [],
		[focused, tagWord, caretWord, autocompleteTags, dateSettings, caret.now],
	);
	const autocompletePopulated = autocompleteRows.length > 0;
	const helperVisible = focused && !autocompletePopulated;
	const sections = helperSections(helperTags);
	const [previousPopulated, setPreviousPopulated] = useState(autocompletePopulated);
	if (previousPopulated !== autocompletePopulated)
	{
		// Upstream resets the tab whenever the helper flyout hides or shows.
		setPreviousPopulated(autocompletePopulated);
		setHelper(NO_HELPER_SELECTION);
	}
	const jumpTabSelected = helperVisible && sections[helper.tab]?.hint === true;

	useEffect(() =>
	{
		if (!helperVisible)
		{
			return () =>
			{
			};
		}
		// A click on a chip keeps its tab open. The browser then forwards the click to the label's input, which
		// must not reset the selection either; clicks on the input and elsewhere reset it.
		let pressedInFlyout = false;
		const inFlyout = (event: Event) =>
			event.target instanceof Node && flyoutRef.current?.contains(event.target) === true;
		const press = (event: MouseEvent) =>
		{
			pressedInFlyout = inFlyout(event);
		};
		const reset = (event: MouseEvent) =>
		{
			if (inFlyout(event))
			{
				setTimeout(() =>
				{
					pressedInFlyout = false;
				}, 0);
				return;
			}
			if (pressedInFlyout)
			{
				pressedInFlyout = false;
				return;
			}
			setHelper(NO_HELPER_SELECTION);
		};
		window.addEventListener("mousedown", press, true);
		window.addEventListener("click", reset);
		return () =>
		{
			window.removeEventListener("mousedown", press, true);
			window.removeEventListener("click", reset);
		};
	}, [helperVisible]);

	// Upstream's jump-to tab: Enter opens the jump menu and ArrowDown is swallowed, ahead of every other handler.
	useEffect(() =>
	{
		if (!jumpTabSelected)
		{
			return () =>
			{
			};
		}
		const onKeyDown = (event: globalThis.KeyboardEvent) =>
		{
			if (event.code !== "Enter" && event.code !== "ArrowDown")
			{
				return;
			}
			event.stopImmediatePropagation();
			event.preventDefault();
			if (event.code === "Enter")
			{
				useOutlineStore.getState().openJumpMenu();
			}
		};
		window.addEventListener("keydown", onKeyDown, true);
		return () =>
		{
			window.removeEventListener("keydown", onKeyDown, true);
		};
	}, [jumpTabSelected]);

	/** Upstream's debounced caret word (`WF.Caret.word`): the word around the caret, re-read when the timer fires. */
	const scheduleCaretWord = useCallback(() =>
	{
		if (caretTimer.current !== null)
		{
			clearTimeout(caretTimer.current);
		}
		caretTimer.current = setTimeout(() =>
		{
			caretTimer.current = null;
			const input = inputRef.current;
			setCaretWord(input === null ? "" : wordAt(input.value, input.selectionStart ?? 0).text);
		}, CARET_WORD_DEBOUNCE_MS);
	}, [setCaretWord]);
	useEffect(
		() => () =>
		{
			if (caretTimer.current !== null)
			{
				clearTimeout(caretTimer.current);
			}
		},
		[],
	);

	const selectAutocomplete = useCallback(
		(row: AutocompleteRow) =>
		{
			const input = inputRef.current;
			if (input === null)
			{
				return;
			}
			const {insert} = row;
			const result = replaceSearchWord(
				input.value,
				input.selectionStart ?? input.value.length,
				insert === undefined ? row.value : `${row.value}${insert.suffix}`,
				insert === undefined
					? {}
					:
						{
							trailingSpace: insert.trailingSpace,
							caretOffset: insert.caretOffset,
						},
			);
			// Write the DOM value first so React's controlled update leaves the caret where it is placed here.
			input.value = result.query;
			input.setSelectionRange(result.caret, result.caret);
			setCaretWord(wordAt(result.query, result.caret).text);
			setSearchInput(result.query);
			controller.dispose();
			useOutlineStore.getState().commitSearch(result.query, navigate);
		},
		[controller, navigate, setSearchInput, setCaretWord],
	);

	const insertHelper = (value: string) =>
	{
		const input = inputRef.current;
		const result = insertHelperValue(searchInput, input?.selectionStart ?? searchInput.length, value);
		// Write the DOM value first so React's controlled update leaves the caret where it is placed here.
		if (input !== null)
		{
			input.value = result.query;
			input.setSelectionRange(result.caret, result.caret);
		}
		setSearchInput(result.query);
		controller.dispose();
		useOutlineStore.getState().commitSearch(result.query, navigate);
	};

	const hasText = searchInput !== "";
	const collapsed = !wide && !focused && !hasText;

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
				width: focused ? 320 : 210,
			};
	const innerStyle: CSSProperties =
	{
		...(collapsed
			?
				{
					borderRadius: 20,
				}
			: borderStyle(hasText ? "var(--wf-border-tint)" : "var(--wf-border-primary)")),
		...(focused
			?
				{
					borderRadius: "20px 20px 0 0",
					borderBottom: "1px solid transparent",
					background: "var(--wf-background-primary)",
				}
			: {}),
	};

	/** Runs upstream's tab-row and chip-row key handlers; true when the key is fully handled here. */
	const handleHelperKey = (event: KeyboardEvent<HTMLInputElement>): boolean =>
	{
		const values = sections[helper.tab]?.values ?? [];
		const geometry = chipLayout(flyoutRef.current);
		const result = helperKey(
			helper,
			{
				code: event.code,
				ctrl: event.ctrlKey && !event.metaKey && !event.altKey,
			},
			{
				tabCount: sections.length,
				hasChips: (tab) => (sections[tab]?.values.length ?? 0) > 0,
				chipCount: values.length,
				neighbor: (chip, dir) =>
					chipNeighbor(geometry.geometry, geometry.containerBottom, chip, dir, geometry.hit),
				hidden: !helperVisible,
			},
		);
		if (result.preventDefault)
		{
			event.preventDefault();
		}
		if (result.sel !== helper)
		{
			setHelper(result.sel);
			setKeyboardMode(true);
		}
		const chip = result.select === null ? undefined : values[result.select];
		if (chip !== undefined)
		{
			insertHelper(chip.value);
			return true;
		}
		return result.stopPropagation;
	};

	const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) =>
	{
		scheduleCaretWord();
		if (handleHelperKey(event))
		{
			return;
		}
		// The autocomplete menu's own window listener selects on Enter; committing the typed query first would double up.
		if (autocompletePopulated && event.key === "Enter")
		{
			return;
		}
		const result = controller.key(event.key, searchInput);
		if (result.preventDefault)
		{
			event.preventDefault();
		}
		if (result.action === "focusOutline")
		{
			focusOutline(queryClient);
		}
	};

	const label = (
		// oxlint-disable-next-line jsx-a11y/label-has-associated-control -- upstream's bare label wraps the input; its placeholder names it
		<label className={labelClass(collapsed)} style={labelStyle}>
			<div className={focused ? FOCUSED_INNER_CLASS : "flex items-center "} style={innerStyle}>
				<SearchHelpers
					query={searchInput}
					focused={focused}
					autocompletePopulated={autocompletePopulated}
					tags={helperTags}
					selection={helper}
					onHoverTab={(tab) =>
					{
						setCanHover(true);
						setKeyboardMode(false);
						setHelper((current) => (
						{
							tab,
							chip: -1,
							rowMode: current.rowMode,
						}));
					}}
					onHoverChip={(chip) =>
					{
						setCanHover(true);
						setKeyboardMode(false);
						setHelper((current) => (
						{
							...current,
							chip,
						}));
					}}
					keyboardMode={keyboardMode}
					onClickTab={(tab) =>
					{
						if (sections[tab]?.hint === true)
						{
							useOutlineStore.getState().openJumpMenu();
						}
					}}
					canHover={canHover}
					onInsert={insertHelper}
					jumpKey={isMacPlatform() ? "meta+k" : "ctrl+k"}
					flyoutRef={flyoutRef}
				/>
				{autocompletePopulated && (
					<SearchAutocomplete
						rows={autocompleteRows}
						committed={committedQuery !== ""}
						onSelect={selectAutocomplete}
					/>
				)}
				<input
					autoComplete="off"
					autoCorrect="off"
					className={
						wide
							? INPUT_CLASS
							: collapsed
								? `${COMPACT_INPUT_CLASS} opacity-0 cursor-pointer`
								: COMPACT_INPUT_CLASS
					}
					data-handbook="search.search"
					id="srch-input"
					onBlur={() =>
					{
						if (caretTimer.current !== null)
						{
							clearTimeout(caretTimer.current);
							caretTimer.current = null;
						}
						setCaretWord("");
						setHelper(NO_HELPER_SELECTION);
						setSearchFocused(false);
					}}
					onChange={(event) =>
					{
						setSearchInput(event.target.value);
						controller.change(event.target.value);
						scheduleCaretWord();
					}}
					onSelect={scheduleCaretWord}
					onFocus={() =>
					{
						setArmed(true);
						setHelper(NO_HELPER_SELECTION);
						setCanHover(false);
						scheduleCaretWord();
						void queryClient.invalidateQueries(
							{
								queryKey: ["search-helpers"],
							},
						);
						setSearchFocused(true);
					}}
					onKeyDown={handleKeyDown}
					placeholder="Search"
					ref={inputRef}
					readOnly={!armed}
					type="text"
					value={searchInput}
				/>
				<svg
					aria-hidden="true"
					focusable="false"
					data-prefix="fal"
					data-icon="magnifying-glass"
					className={`svg-inline--fa fa-magnifying-glass ${collapsed ? "fa-1x absolute left-[10px] pt-xs" : "fa-sm absolute left-ml"} pointer-events-none`}
					// oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- verbatim upstream markup
					role="img"
					xmlns="http://www.w3.org/2000/svg"
					viewBox="0 0 512 512"
				>
					<path d={MAGNIFIER_PATH} fill="currentColor" />
				</svg>
				<div className="absolute top-0 right-[11px] h-full flex items-center justify-center">
					{hasText && <StarButton />}
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
							onClick={() =>
							{
								if (useOutlineStore.getState().searchQuery === "")
								{
									setSearchInput("");
									controller.change("");
									return;
								}
								controller.dispose();
								focusOutline(queryClient, () =>
								{
									useOutlineStore.getState().cancelSearch(navigate);
								});
							}}
						>
							<path clipRule="evenodd" d={CLEAR_PATH} fill="currentColor" fillRule="evenodd" />
						</svg>
					)}
				</div>
			</div>
		</label>
	);

	return <div className="flex items-center">{label}</div>;
});
