import type {ChangeEvent, KeyboardEvent} from "react";
import {useRef} from "react";
import {useStableNavigate} from "../hooks/use-stable-navigate.js";
import {mobileSearchBlurAction, mobileSearchVisible} from "../mobile-search-model.js";
import {activeZoomedId, useOutlineStore} from "../stores/outline.js";
import {FaIcon} from "./fa-icons.js";
import {useHeaderActions} from "./header-actions.js";

export interface MobileSearchFormViewProps
{
	visible: boolean;
	value: string;
	/** Upstream shows the star only with a query. */
	starred: boolean;
	onChange: (value: string) => void;
	onFocus: () => void;
	onBlur: (value: string) => void;
	onClear: () => void;
	onToggleStar: () => void;
	inputRef?: React.Ref<HTMLInputElement>;
}

const FORM_CLASS =
	"wf-header h-[44px] bg-primary border-b border-solid border-primary flex flex-row items-center px-l gap-m";
const INPUT_CLASS =
	"newMobileSearchBox searchBoxInput flex-1 text-[17px] text-primary border-0 bg-primary placeholder:text-tertiary";

/** Upstream's `aS4` mobile search form: hidden until visible, 44px tall, above the crumbs. */
export function MobileSearchFormView({
	visible,
	value,
	starred,
	onChange,
	onFocus,
	onBlur,
	onClear,
	onToggleStar,
	inputRef,
}: MobileSearchFormViewProps)
{
	return (
		<form
			className={`${visible ? "block" : "hidden"} ${FORM_CLASS}`}
			onSubmit={(event) =>
			{
				event.preventDefault();
			}}
		>
			<FaIcon icon="fas:magnifying-glass" className="text-primary" />
			<input
				ref={inputRef}
				id="mobile-srch-input"
				name="search"
				className={INPUT_CLASS}
				placeholder="Search"
				autoComplete="off"
				value={value}
				onChange={(event: ChangeEvent<HTMLInputElement>) =>
				{
					onChange(event.target.value);
				}}
				onFocus={onFocus}
				onBlur={(event) =>
				{
					onBlur(event.target.value);
				}}
				onKeyDown={(event: KeyboardEvent<HTMLInputElement>) =>
				{
					if (event.key === "Enter")
					{
						event.currentTarget.blur();
					}
				}}
			/>
			<div className="flex gap-ml">
				{value !== "" && (
					// oxlint-disable-next-line jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events -- a touch control: tapping stars the search
					<div onClick={onToggleStar}>
						{starred ? (
							<FaIcon
								icon="fas:star"
								style={
								{
									color: "var(--wf-yellow-200)",
								}}
							/>
						) : (
							<FaIcon icon="fal:star" />
						)}
					</div>
				)}
				{/* oxlint-disable-next-line jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events -- a touch control: tapping clears the search */}
				<div
					onMouseDown={(event) =>
					{
						event.preventDefault();
					}}
					onClick={onClear}
				>
					<FaIcon icon="fas:circle-xmark" className="text-primary" />
				</div>
			</div>
		</form>
	);
}

/** The mobile search form on the outline store's search state (typed, focused and committed). */
export function MobileSearchForm()
{
	const navigate = useStableNavigate();
	const input = useRef<HTMLInputElement>(null);
	const searchInput = useOutlineStore((state) => state.searchInput);
	const focused = useOutlineStore((state) => state.searchFocused);
	const query = useOutlineStore((state) => state.searchQuery);
	const zoomedId = useOutlineStore(activeZoomedId);
	const actions = useHeaderActions(zoomedId, query === "" ? null : query);
	return (
		<MobileSearchFormView
			visible={mobileSearchVisible(
				{
					focused,
					input: searchInput,
					query,
				},
			)}
			value={searchInput}
			starred={actions.isStarred}
			inputRef={input}
			onChange={(value) =>
			{
				useOutlineStore.getState().setSearchInput(value);
			}}
			onFocus={() =>
			{
				useOutlineStore.getState().setSearchFocused(true);
			}}
			onBlur={(value) =>
			{
				const store = useOutlineStore.getState();
				store.setSearchFocused(false);
				if (mobileSearchBlurAction(value) === "cancel")
				{
					store.cancelSearch(navigate);
				}
				else if (value !== store.searchQuery)
				{
					store.commitSearch(value, navigate);
				}
			}}
			onClear={() =>
			{
				const store = useOutlineStore.getState();
				store.setSearchInput("");
				input.current?.blur();
				store.setSearchFocused(false);
				store.cancelSearch(navigate);
			}}
			onToggleStar={actions.toggleStar}
		/>
	);
}
