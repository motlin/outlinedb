import type {NodeResponse} from "../../node-types.js";
import {usePreferences} from "../hooks/use-preferences.js";
import {useOutlineStore} from "../stores/outline.js";
import {FilePreviewView} from "./file-preview.js";
import {showImageViewer} from "./image-viewer-state.js";

/**
 * A node's `.file-preview` after its `.name`. Pressing the image focuses the row at its end; pressing it again while
 * the row is focused blurs it and opens the full-screen viewer, like upstream.
 */
export function RowFilePreview({node, zoomedIn}: {node: NodeResponse; zoomedIn: boolean})
{
	const {preferences} = usePreferences();
	const isEditing = useOutlineStore((state) => state.editingId === node.id);
	const resumeEditing = useOutlineStore((state) => state.resumeEditing);
	const stopEditing = useOutlineStore((state) => state.stopEditing);
	const openSettings = useOutlineStore((state) => state.openSettings);
	const showFullScreen = () =>
	{
		showImageViewer(node.id);
	};
	return (
		<FilePreviewView
			nodeId={node.id}
			attachment={node.attachment ?? null}
			name={node.name ?? ""}
			zoomedIn={zoomedIn}
			innerWidth={window.innerWidth}
			thumbs={preferences.displayImagePreviewsAsThumbnails}
			devicePixelRatio={window.devicePixelRatio || 1}
			onImageMouseDown={(event) =>
			{
				event.preventDefault();
				if (isEditing)
				{
					stopEditing();
					showFullScreen();
				}
				else
				{
					resumeEditing(node.id, Number.MAX_SAFE_INTEGER);
				}
			}}
			showFullScreen={showFullScreen}
			openSettings={() =>
			{
				openSettings("Media & Previews");
			}}
		/>
	);
}
