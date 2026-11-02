import {Fragment} from "react";
import {selectCompletedVisibility} from "../completed-visibility.js";
import {useSearchProgress} from "../hooks/use-tree-search.js";
import {useOutlineStore} from "../stores/outline.js";
import {FaIcon} from "./fa-icons.js";
import {DomKitSpinner} from "./dom-kit-spinner.js";

export interface SearchCountIndicatorProps
{
	/** Every match, hidden completed ones included. */
	matchCount: number;
	completedMatchCount: number;
	/** Completed rows render: the preference, or forced by a revealing query. */
	shown: boolean;
	/** The current query's result has not arrived yet. */
	searching: boolean;
	onToggleCompleted: () => void;
}

/** Upstream's pill class string, whitespace collapsed. */
const PILL_CLASS =
	" matching-node fixed mobile:bottom-[64px] desktop:bottom-l min-w-[256px] flex items-center justify-center px-l py-m rounded-pill bg-secondary whitespace-nowrap text-secondary overflow-hidden text-s ";

/** Upstream's `.matching-node` count pill: "N Matches" plus the "M completed" show/hide toggle. */
export function SearchCountIndicatorView({
	matchCount,
	completedMatchCount,
	shown,
	searching,
	onToggleCompleted,
}: SearchCountIndicatorProps)
{
	const done = !searching;
	const hasToggle = completedMatchCount > 0;
	return (
		<div className="flex justify-center print:hidden">
			<span
				className={PILL_CLASS}
				style={
				{
					marginBottom: "var(--safe-area-inset-bottom)",
					zIndex: 500,
				}}
			>
				{done && (
					<Fragment>
						<span>{`${matchCount} Match${matchCount === 1 ? "" : "es"}`}</span>
						{hasToggle && <div className=" border-solid border-l-[1px] border-primary h-full mx-m " />}
						{hasToggle && (
							// oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- verbatim upstream markup
							<div className="flex cursor-pointer h-full items-center " onClick={onToggleCompleted}>
								<span className="mr-s">{`${completedMatchCount} completed`}</span>
								<div className="w-[20px] flex justify-center">
									<FaIcon icon={shown ? "fal:eye" : "fal:eye-slash"} />
								</div>
							</div>
						)}
					</Fragment>
				)}
				{done ? " " : " Still searching "}
				{!done && <DomKitSpinner />}
			</span>
		</div>
	);
}

/** The count pill for the committed search; upstream keeps it while the caret is in a row. */
export function SearchCountIndicator()
{
	const searchQuery = useOutlineStore((state) => state.searchQuery);
	const showCompleted = useOutlineStore((state) => state.showCompleted);
	const toggleShowCompleted = useOutlineStore((state) => state.toggleShowCompleted);
	const {result, searching} = useSearchProgress();
	if (searchQuery === "")
	{
		return null;
	}
	return (
		<SearchCountIndicatorView
			matchCount={result?.matchCount ?? 0}
			completedMatchCount={result?.completedMatchCount ?? 0}
			shown={
				selectCompletedVisibility(
					{
						showCompleted,
						searchQuery,
					},
				).shown
			}
			searching={searching}
			onToggleCompleted={toggleShowCompleted}
		/>
	);
}
