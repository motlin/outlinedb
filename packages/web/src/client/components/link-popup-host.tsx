import {useCallback} from "react";
import {useShallow} from "zustand/react/shallow";
import {useUpdateNode} from "../hooks/use-nodes.js";
import {applyLinkToHtml, unlinkInHtml} from "../link-popup-model.js";
import {useOutlineStore} from "../stores/outline.js";
import {captureOutlineView, runInUndoBatch} from "../undo-batch.js";
import {LinkPopup} from "./link-popup.js";

/**
 * Mounts upstream's ⌘K link popup while the store holds one. Apply and Unlink rewrite the snapshot of the field the
 * popup opened on, save it as one undo step, and resume editing at upstream's caret (the old end + 1 after Apply).
 */
export function LinkPopupHost()
{
	const {linkPopup, closeLinkPopup} = useOutlineStore(
		useShallow((state) => (
		{
			linkPopup: state.linkPopup,
			closeLinkPopup: state.closeLinkPopup,
		})),
	);
	const updateNode = useUpdateNode();

	const finish = useCallback(
		(html: string, caret: number) =>
		{
			if (linkPopup === null)
			{
				return;
			}
			const {nodeId, field} = linkPopup;
			closeLinkPopup();
			void runInUndoBatch(captureOutlineView, () =>
			{
				updateNode.mutate(
					field === "name"
						?
							{
								nodeId,
								name: html,
							}
						:
							{
								nodeId,
								note: html,
							},
				);
			});
			const store = useOutlineStore.getState();
			if (field === "name")
			{
				store.resumeEditing(
					nodeId,
					caret,
					{
						html,
					},
				);
			}
			else
			{
				store.focusNote(nodeId, caret);
			}
		},
		[closeLinkPopup, linkPopup, updateNode],
	);

	const cancel = useCallback(() =>
	{
		if (linkPopup === null || useOutlineStore.getState().linkPopup === null)
		{
			return;
		}
		const {nodeId, field, end} = linkPopup;
		closeLinkPopup();
		const store = useOutlineStore.getState();
		if (field === "name")
		{
			store.resumeEditing(nodeId, end);
		}
		else
		{
			store.focusNote(nodeId, end);
		}
	}, [closeLinkPopup, linkPopup]);

	if (linkPopup === null)
	{
		return null;
	}
	const {html, start, end, existing} = linkPopup;
	return (
		<LinkPopup
			key={`${linkPopup.nodeId}:${start}:${end}`}
			text={linkPopup.text}
			href={linkPopup.href}
			position={linkPopup.position}
			onApply={(link) =>
			{
				const applied = applyLinkToHtml(html, start, end, link.text, link.href, existing);
				finish(applied.html, applied.caret);
			}}
			onUnlink={() =>
			{
				finish(unlinkInHtml(html, start), end);
			}}
			onCancel={cancel}
		/>
	);
}
