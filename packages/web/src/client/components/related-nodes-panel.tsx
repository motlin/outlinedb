import {skipToken, useQuery, useQueryClient} from "@tanstack/react-query";
import {useShallow} from "zustand/react/shallow";
import {useCallback, useEffect, useState} from "react";
import {setFeature, useFeatureOn} from "../hooks/use-features.js";
import {markAiEmbeddingTooltipDismissed, setPreferences, useAiEmbeddingStage} from "../hooks/use-preferences.js";
import {Button} from "./button.js";
import {nodeUrl} from "../navigation.js";
import {stripHtmlTags as stripHtml} from "@workflowy/shared/html";
import {useStableNavigate} from "../hooks/use-stable-navigate.js";
import {useOutlineStore} from "../stores/outline.js";
import type {OpErrorBody, RelatedResponse} from "../../node-types.js";
import {readJson} from "../read-json.js";

type RelatedNode = RelatedResponse["results"][number];

function formatSimilarityScore(distance: number): string {
	// Convert distance to similarity percentage (1 - distance)
	// Cosine distance of 0 means identical, 1 means orthogonal
	const similarity = Math.max(0, Math.min(100, (1 - distance) * 100));
	return `${similarity.toFixed(0)}%`;
}

async function fetchRelatedNodes(nodeId: string): Promise<RelatedNode[]> {
	const response = await fetch("/api/related", {
		method: "POST",
		headers: {"Content-Type": "application/json"},
		body: JSON.stringify({
			nodeId,
			type: "similar",
			limit: 10,
			threshold: 0.7,
		}),
	});
	if (!response.ok) {
		const data = await readJson<OpErrorBody>(response);
		throw new Error(data.error ?? "Failed to fetch related nodes");
	}
	const data = await readJson<RelatedResponse>(response);
	return data.results;
}

/** Upstream's AI chat welcome heading (`cZ4`/`tZ4`): title and Beta badge. */
function AiWelcomeTitle() {
	return (
		<div className="title-row flex gap-m items-center">
			<h3 className="text-l font-medium">Chat with Your Notes</h3>
			<span className="badge h-fit !ml-0 !p-0 !px-xs !py-2xs !rounded-sm !font-normal !uppercase !bg-info !text-primary">
				Beta
			</span>
		</div>
	);
}

/**
 * Upstream's AI onboarding (`cZ4`), shown while `ai.embeddingStatus` is unset: Not now turns the `ai` feature off and
 * closes the window; Enable AI sets the status to "requested" so the server starts indexing the notes.
 */
function AiEnablePrompt({onNotNow, onEnable}: {onNotNow: () => void; onEnable: () => void}) {
	return (
		<div className="welcome flex flex-col px-xl pt-xl gap-m leading-base text-base">
			<div className="flex flex-col gap-xs">
				<AiWelcomeTitle />
				<p className="text-tertiary">
					Ask questions about your notes, discover new insights, and turn your ideas into action.
				</p>
			</div>
			<div className="flex mt-l gap-l mobile:flex-col-reverse mobile:gap-l">
				<Button variant="secondary" onClick={onNotNow}>
					Not now
				</Button>
				<Button variant="primary" onClick={onEnable}>
					Enable AI
				</Button>
			</div>
			<div className="text-s text-tertiary flex flex-row gap-s align-middle mt-xl">
				<p className="text-tertiary text-s">
					This will send all your notes to third-party AI services for processing. &nbsp;
					<a
						href="https://workflowy.com/ai-terms"
						title="Workflowy AI terms and conditions"
						target="_blank"
						rel="noreferrer"
						className="underline"
					>
						See our AI terms for details.
					</a>
				</p>
			</div>
		</div>
	);
}

/** Upstream's `tZ4`, shown while `ai.embeddingStatus` is "requested" and the server indexes the notes. */
function AiGettingReady() {
	return (
		<div className="welcome flex flex-col px-xl pt-xl gap-m leading-base text-base">
			<div className="flex flex-col gap-xs">
				<AiWelcomeTitle />
				<p className="ai-thinking my-m">Getting everything ready...</p>
				<p className="text-tertiary text-s">
					This might take a few minutes. You can close this window or keep it open - we&rsquo;ll let you know
					when it&rsquo;s ready.
				</p>
			</div>
		</div>
	);
}

/** Upstream's `ai.enable-flow` boot delay before the AI window opens on the Enable AI prompt. */
const ENABLE_FLOW_DELAY_MS = 3000;

/**
 * Upstream's `ai.enable-flow`: with the `ai` feature on and `ai.embeddingStatus` unset, open the AI window on the
 * Enable AI prompt 3s after load, once per page load.
 */
function useAiEnableFlow(stage: ReturnType<typeof useAiEmbeddingStage>, open: () => void): void {
	const aiOn = useFeatureOn("ai");
	const [fired, setFired] = useState(false);
	const due = aiOn && stage === "onboarding" && !fired;
	useEffect(() => {
		if (!due) {
			// oxlint-disable-next-line unicorn/no-useless-undefined -- consistent-return needs a value beside the cleanup return
			return undefined;
		}
		const timer = setTimeout(() => {
			setFired(true);
			open();
		}, ENABLE_FLOW_DELAY_MS);
		return () => {
			clearTimeout(timer);
		};
	}, [due, open]);
}

/**
 * Sidebar panel showing nodes semantically related to the most recently edited node.
 * Updates automatically when editing moves to another node, and keeps its results after the edit ends.
 * Click a result to navigate to that node. Like upstream's AI chat window it is gated on root metadata
 * `ai.embeddingStatus`: unset shows the Enable AI prompt, "requested" the indexing notice, and the first ready open
 * sets `ai.embedding_tooltip_dismissed`.
 */
export function RelatedNodesPanel() {
	const {lastEditedId, relatedNodesPanelOpen, toggleRelatedNodesPanel} = useOutlineStore(
		useShallow((state) => ({
			lastEditedId: state.lastEditedId,
			relatedNodesPanelOpen: state.relatedNodesPanelOpen,
			toggleRelatedNodesPanel: state.toggleRelatedNodesPanel,
		})),
	);
	const navigate = useStableNavigate();
	const queryClient = useQueryClient();
	const stage = useAiEmbeddingStage();
	const ready = stage === "ready";
	const openPanel = useCallback(() => {
		if (!useOutlineStore.getState().relatedNodesPanelOpen) {
			toggleRelatedNodesPanel();
		}
	}, [toggleRelatedNodesPanel]);
	useAiEnableFlow(stage, openPanel);

	useEffect(() => {
		if (relatedNodesPanelOpen && ready) {
			void markAiEmbeddingTooltipDismissed(queryClient);
		}
	}, [relatedNodesPanelOpen, ready, queryClient]);

	const {
		data: relatedNodes = [],
		isLoading,
		error: queryError,
	} = useQuery({
		queryKey: ["related", lastEditedId],
		queryFn:
			relatedNodesPanelOpen && ready && lastEditedId !== null
				? async () => fetchRelatedNodes(lastEditedId)
				: skipToken,
	});
	const error = queryError?.message ?? null;

	const handleNavigateToNode = useCallback(
		(nodeId: string) => {
			void navigate(nodeUrl(nodeId));
		},
		[navigate],
	);

	if (!relatedNodesPanelOpen) {
		return null;
	}

	const notNow = () => {
		void setFeature(queryClient, "ai", false);
		toggleRelatedNodesPanel();
	};
	const enable = () => {
		void setPreferences(queryClient, {aiEmbeddingStatus: "requested"});
	};

	return (
		<div className="related-nodes-panel">
			<div className="related-nodes-panel-header">
				<h2 className="related-nodes-panel-title">Related Nodes</h2>
				<button
					aria-label="Close related nodes panel"
					className="related-nodes-panel-close"
					onClick={toggleRelatedNodesPanel}
					type="button"
				>
					&times;
				</button>
			</div>

			{stage === "onboarding" && <AiEnablePrompt onNotNow={notNow} onEnable={enable} />}
			{stage === "requested" && <AiGettingReady />}
			{ready && (
				<>
					<div className="related-nodes-panel-content">
						{!lastEditedId && (
							<p className="related-nodes-panel-hint">Edit a node to see related content</p>
						)}

						{lastEditedId && isLoading && <p className="related-nodes-panel-status">Loading...</p>}

						{lastEditedId && error && <p className="related-nodes-panel-error">{error}</p>}

						{lastEditedId && !isLoading && !error && relatedNodes.length === 0 && (
							<p className="related-nodes-panel-empty">No related nodes found</p>
						)}

						{lastEditedId && !isLoading && !error && relatedNodes.length > 0 && (
							<ul className="related-nodes-panel-list">
								{relatedNodes.map((node) => (
									<li key={node.id}>
										<button
											className="related-nodes-panel-item"
											onClick={() => {
												handleNavigateToNode(node.id);
											}}
											type="button"
										>
											<div className="related-nodes-panel-item-header">
												<span className="related-nodes-panel-item-name">
													{stripHtml(node.name) || "Untitled"}
												</span>
												<span className="related-nodes-panel-item-score">
													{formatSimilarityScore(node.distance)}
												</span>
											</div>
											{node.path.length > 0 && (
												<span className="related-nodes-panel-item-path">
													{node.path.join(" > ")}
												</span>
											)}
											{node.note && (
												<span className="related-nodes-panel-item-note">
													{stripHtml(node.note)}
												</span>
											)}
										</button>
									</li>
								))}
							</ul>
						)}
					</div>

					<div className="related-nodes-panel-footer">
						<p className="related-nodes-panel-hint-text">Based on semantic similarity using embeddings</p>
					</div>
				</>
			)}
		</div>
	);
}
