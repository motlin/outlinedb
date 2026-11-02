import {useQuery} from "@tanstack/react-query";
import {stripHtmlTags as stripHtml} from "@outlinedb/shared/html";
import {useState} from "react";
import {useSearchParams} from "react-router-dom";
import {diffChars} from "diff";
import type {ChangesResponse} from "../../node-types.js";
import {usePreferences} from "../hooks/use-preferences.js";
import {readJson} from "../read-json.js";

type NodeChange = ChangesResponse["changes"][number];
type ChangeTreeNode = ChangesResponse["tree"][number];
type ChangeSummary = ChangesResponse["summary"];

function getChangeLabels(change: NodeChange): string[]
{
	const labels: string[] = [];

	if (change.isNew)
	{
		labels.push("Added");
		return labels;
	}
	if (change.isDeleted)
	{
		labels.push("Deleted");
		return labels;
	}
	if (change.completionChanged)
	{
		labels.push(change.currentCompletedAt ? "Completed" : "Uncompleted");
	}
	if (change.contentChanged && change.parentChanged)
	{
		labels.push("Changed and moved");
	}
	else if (change.contentChanged)
	{
		labels.push("Changed");
	}
	else if (change.parentChanged)
	{
		labels.push("Moved");
	}
	if (change.noteChanged && !change.contentChanged)
	{
		labels.push("Note edited");
	}
	return labels;
}

function getLabelColor(label: string): string
{
	if (label === "Added")
	{
		return "var(--changes-green)";
	}
	if (label === "Deleted")
	{
		return "var(--changes-red)";
	}
	if (label === "Moved" || label === "Changed and moved")
	{
		return "var(--changes-blue)";
	}
	if (label === "Completed" || label === "Uncompleted")
	{
		return "var(--changes-gray)";
	}
	return "var(--changes-gray)";
}

function getBulletColor(change: NodeChange): string
{
	if (change.isNew)
	{
		return "var(--changes-green)";
	}
	if (change.isDeleted)
	{
		return "var(--changes-red)";
	}
	if (change.parentChanged && !change.contentChanged && !change.noteChanged)
	{
		return "var(--changes-blue)";
	}
	return "var(--changes-gray)";
}

function InlineDiff({oldText, newText}: {oldText: string; newText: string})
{
	const parts = diffChars(oldText, newText);
	return (
		<span>
			{parts.map((part, i) => (
				// A diff is a fixed sequence of parts with no identity beyond its position.
				// oxlint-disable-next-line react/no-array-index-key
				<span className={part.added ? "diff-added" : part.removed ? "diff-removed" : undefined} key={i}>
					{part.value}
				</span>
			))}
		</span>
	);
}

function ChangeTreeNodeView({node, depth}: {node: ChangeTreeNode; depth: number})
{
	const name = node.name ? stripHtml(node.name) : "(unnamed)";

	if (node.isContext || node.change === null)
	{
		return (
			<div>
				<div
					className="change-node change-context"
					style={
					{
						paddingLeft: `${depth * 24}px`,
					}}
				>
					<span className="change-bullet context">●</span>
					<span className="change-name">{name}</span>
				</div>
				{node.children.map((child) => (
					<ChangeTreeNodeView depth={depth + 1} key={child.id} node={child} />
				))}
			</div>
		);
	}

	const {change} = node;
	const labels = getChangeLabels(change);
	const bulletColor = getBulletColor(change);

	let nameContent: React.ReactNode;
	if (change.isDeleted)
	{
		nameContent = <span className="change-deleted-text">{name}</span>;
	}
	else if (change.isNew)
	{
		nameContent = <span className="change-added-text">{name}</span>;
	}
	else if (change.contentChanged && change.oldName && change.currentName)
	{
		nameContent = <InlineDiff newText={stripHtml(change.currentName)} oldText={stripHtml(change.oldName)} />;
	}
	else
	{
		nameContent = <span>{name}</span>;
	}

	return (
		<div>
			<div
				className={`change-node change-${change.isNew ? "added" : change.isDeleted ? "deleted" : change.parentChanged && !change.contentChanged ? "moved" : "changed"}`}
				style={
				{
					paddingLeft: `${depth * 24}px`,
				}}
			>
				<span
					className="change-bullet"
					style={
					{
						color: bulletColor,
					}}
				>
					●
				</span>
				<span className="change-name">{nameContent}</span>
				{labels.map((label) => (
					<span
						className="change-label"
						key={label}
						style={
						{
							color: getLabelColor(label),
						}}
					>
						{label}
					</span>
				))}
			</div>
			{node.children.map((child) => (
				<ChangeTreeNodeView depth={depth + 1} key={child.id} node={child} />
			))}
		</div>
	);
}

function SummaryBar({summary}: {summary: ChangeSummary})
{
	const parts:
	{
		label: string;
		count: number;
		className: string;
	}[] = [];
	if (summary.added > 0)
	{
		parts.push(
			{
				label: "added",
				count: summary.added,
				className: "summary-added",
			},
		);
	}
	if (summary.deleted > 0)
	{
		parts.push(
			{
				label: "deleted",
				count: summary.deleted,
				className: "summary-deleted",
			},
		);
	}
	if (summary.moved > 0)
	{
		parts.push(
			{
				label: "moved",
				count: summary.moved,
				className: "summary-moved",
			},
		);
	}
	if (summary.changed > 0)
	{
		parts.push(
			{
				label: "changed",
				count: summary.changed,
				className: "summary-changed",
			},
		);
	}
	if (summary.completed > 0)
	{
		parts.push(
			{
				label: "completed",
				count: summary.completed,
				className: "summary-completed",
			},
		);
	}
	if (summary.uncompleted > 0)
	{
		parts.push(
			{
				label: "uncompleted",
				count: summary.uncompleted,
				className: "summary-uncompleted",
			},
		);
	}

	return (
		<div className="changes-summary">
			{parts.map((p) => (
				<span className={`summary-badge ${p.className}`} key={p.label}>
					{p.count} {p.label}
				</span>
			))}
		</div>
	);
}

export function ChangesView()
{
	const [searchParams, setSearchParams] = useSearchParams();
	const sinceParam = searchParams.get("since") ?? "1d";
	const [sinceInput, setSinceInput] = useState(sinceParam);

	const {data, isLoading, error} = useQuery<ChangesResponse>(
		{
			queryKey: ["changes", sinceParam],
			async queryFn()
			{
				const response = await fetch(`/api/changes?since=${encodeURIComponent(sinceParam)}`);
				if (!response.ok)
				{
					throw new Error(`Failed to fetch changes: ${response.statusText}`);
				}
				return readJson<ChangesResponse>(response);
			},
		},
	);

	const handleSubmit = (e: React.SubmitEvent<HTMLFormElement>) =>
	{
		e.preventDefault();
		setSearchParams(
			{
				since: sinceInput,
			},
		);
	};

	/** When the account's change tracking started (upstream's `searchForChangesAfter`). */
	const updatesStart = usePreferences().preferences.searchForChangesAfter;

	return (
		<div className="changes-page">
			<div className="changes-header">
				<h1>Node Changes</h1>
				<form className="changes-controls" onSubmit={handleSubmit}>
					<label htmlFor="since-input">Since:</label>
					<input
						id="since-input"
						onChange={(e) =>
						{
							setSinceInput(e.target.value);
						}}
						placeholder="1d, 12h, 1w, or ISO date"
						type="text"
						value={sinceInput}
					/>
					<button type="submit">Update</button>
					{updatesStart !== null && (
						<button
							onClick={() =>
							{
								setSinceInput(updatesStart);
								setSearchParams(
									{
										since: updatesStart,
									},
								);
							}}
							title={`Changes since ${new Date(updatesStart).toLocaleString()}, when change tracking started`}
							type="button"
						>
							Since updates start
						</button>
					)}
				</form>
			</div>

			{isLoading && <div className="changes-loading">Loading changes...</div>}
			{error && <div className="changes-error">Error: {error.message}</div>}

			{data && (
				<>
					<div className="changes-meta">Changes since {new Date(data.cutoffDate).toLocaleString()}</div>
					<SummaryBar summary={data.summary} />
					{data.tree.length === 0 ? (
						<div className="changes-empty">No changes found.</div>
					) : (
						<div className="changes-tree">
							{data.tree.map((node) => (
								<ChangeTreeNodeView depth={0} key={node.id} node={node} />
							))}
						</div>
					)}
				</>
			)}
		</div>
	);
}
