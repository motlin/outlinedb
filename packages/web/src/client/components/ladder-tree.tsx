import {stripHtmlTags} from "@workflowy/shared/html";
import {getWorkflowyUrl} from "@workflowy/shared/workflowy";
import {useEffect, useRef} from "react";
import type {NodeResponse} from "../../node-types.js";
import {useChildren, useNode} from "../hooks/use-nodes.js";

export function LadderTree({item, onClose}: {item: {id: string; name: string}; onClose: () => void}) {
	const dialog = useRef<HTMLDialogElement>(null);
	const {data: node, error, refetch} = useNode(item.id);
	useEffect(() => {
		// The ref is attached before effects run, so the dialog is always present here.
		const element = dialog.current;
		element?.showModal();
		return () => {
			element?.close();
		};
	}, []);
	return (
		<dialog
			className="ladder-tree-panel"
			ref={dialog}
			aria-labelledby="ladder-tree-title"
			onClose={() => {
				if (!dialog.current?.open) {
					onClose();
				}
			}}
		>
			<header>
				<div>
					<h2 id="ladder-tree-title">{item.name}</h2>
					<a href={getWorkflowyUrl(item.id)} target="_blank" rel="noreferrer">
						Open in workflowy.com ↗
					</a>
				</div>
				<button type="button" onClick={onClose} autoFocus aria-label="Close task tree">
					Close
				</button>
			</header>
			<div className="ladder-tree-body">
				{error ? (
					<p role="alert">
						Could not load task details.{" "}
						<button type="button" onClick={() => void refetch()}>
							Retry
						</button>
					</p>
				) : null}
				{node?.note ? <p className="ladder-tree-note">{stripHtmlTags(node.note)}</p> : null}
				<LadderTreeChildren parentId={item.id} ancestors={[node?.originalNodeId ?? item.id]} />
			</div>
		</dialog>
	);
}

function LadderTreeChildren({parentId, ancestors}: {parentId: string; ancestors: string[]}) {
	const {data: children, isLoading, error, refetch} = useChildren(parentId);
	if (isLoading) {
		return (
			<p>
				<output>Loading subtasks…</output>
			</p>
		);
	}
	if (error) {
		return (
			<p role="alert">
				Could not load subtasks.{" "}
				<button type="button" onClick={() => void refetch()}>
					Retry
				</button>
			</p>
		);
	}
	if (children === undefined || children.length === 0) {
		return <p className="ladder-tree-empty">No subtasks.</p>;
	}
	return (
		<ul>
			{children.map((node) => (
				<LadderTreeNode key={node.id} node={node} ancestors={ancestors} />
			))}
		</ul>
	);
}

function LadderTreeNode({node, ancestors}: {node: NodeResponse; ancestors: string[]}) {
	const identity = node.originalNodeId ?? node.id;
	const cyclic = ancestors.includes(identity);
	const completed = node.completedAt !== null && node.completedAt !== 0;
	const label = (
		<span className={completed ? "ladder-tree-completed" : undefined}>
			{stripHtmlTags(node.name) || "Untitled"}
			{completed ? " (completed)" : ""}
		</span>
	);
	const note = node.note ? <p className="ladder-tree-note">{stripHtmlTags(node.note)}</p> : null;
	return (
		<li>
			{node.hasChildren && !cyclic ? (
				<details open>
					<summary>{label}</summary>
					{note}
					<LadderTreeChildren parentId={node.id} ancestors={[...ancestors, identity]} />
				</details>
			) : (
				<>
					{label}
					{note}
					{cyclic ? (
						<p className="ladder-tree-note">This mirror points to an ancestor already shown above.</p>
					) : null}
				</>
			)}
		</li>
	);
}
