import {useEffect, useState} from "react";
import type {ReactNode} from "react";
import {stripHtmlTags as stripHtml} from "@outlinedb/shared/html";
import {useNodeNavigation} from "../navigation.js";
import {readJson} from "../read-json.js";
import {useOutlineStore} from "../stores/outline.js";
import {useDeleteNode} from "../hooks/use-nodes.js";
import {LeftCollapsingCrumbs} from "./breadcrumbs.js";
import {DialogCloseButton, DialogShell} from "./dialog-shell.js";
import {FaIcon} from "./fa-icons.js";
import type {MirrorLocation, MirrorsResponse} from "../../node-types.js";

export type {MirrorLocation, MirrorsResponse} from "../../node-types.js";

/** Lodash `truncate(text, {length})`: longer text keeps `length - 3` characters and an ellipsis. */
export function lodashTruncate(text: string, length: number): string
{
	return text.length <= length ? text : `${text.slice(0, length - 3)}...`;
}

/** Upstream's "Delete Original and Linked copies" deletes the mirrors first so the original is never promoted. */
export function deletionOrder(data: MirrorsResponse): string[]
{
	return [
		...data.mirrors.filter((location) => !location.isOriginal),
		...data.mirrors.filter((l) => l.isOriginal),
	].map((location) => location.id);
}

/** The dialog's content: upstream `F62`'s title, one row per location and the delete button. */
export function MirrorsDialogView({
	data,
	renderCrumbs,
	onDeleteAll,
}: {
	data: MirrorsResponse;
	renderCrumbs: (location: MirrorLocation) => ReactNode;
	onDeleteAll: () => void;
})
{
	return (
		<div className="flex flex-col gap-xl">
			<div className="text-xl font-bold">
				Mirrors for &quot;{lodashTruncate(stripHtml(data.nodeName), 15)}&quot;
			</div>
			<div className="flex flex-col gap-m">
				{data.mirrors.map((location, index) => (
					<div
						className={`flex rounded-s flex-col gap-s px-l py-m ${index === 0 ? "bg-tint text-on-color" : "text-primary"}`}
						key={location.id}
					>
						<div className="text-base">
							<p>{location.isOriginal ? "Original" : "Linked copy"}</p>
						</div>
						<div className="flex flex-row items-center gap-m text-s">
							<p>
								<strong>{index + 1}.</strong>
							</p>
							{renderCrumbs(location)}
						</div>
					</div>
				))}
			</div>
			<div>
				<button type="button" className="hover:no-underline button" onClick={onDeleteAll}>
					<FaIcon icon="fal:trash-can" />
					<span className="ml-m">Delete Original and Linked copies</span>
				</button>
			</div>
		</div>
	);
}

/** Upstream `WF.Mirrors.see`: the "Mirrors for" dialog of the node in the store, fetched when it opens. */
export function MirrorsDialogHost()
{
	const nodeId = useOutlineStore((state) => state.mirrorsDialogNodeId);
	const close = useOutlineStore((state) => state.closeMirrorsDialog);
	const [loaded, setLoaded] = useState<
	{
		nodeId: string;
		data: MirrorsResponse;
	} | null>(null);
	const {navigateToNode} = useNodeNavigation();
	const deleteNode = useDeleteNode();

	useEffect(() =>
	{
		if (nodeId === null)
		{
			// oxlint-disable-next-line unicorn/no-useless-undefined -- consistent-return needs a value beside the cleanup return
			return undefined;
		}
		const controller = new AbortController();
		void (async () =>
		{
			try
			{
				const response = await fetch(
					`/api/v1/nodes/${encodeURIComponent(nodeId)}/mirrors`,
					{
						signal: controller.signal,
					},
				);
				if (response.ok)
				{
					setLoaded(
						{
							nodeId,
							data: await readJson<MirrorsResponse>(response),
						},
					);
				}
			}
			catch
			{
				// A failed or superseded lookup leaves the dialog closed.
			}
		})();
		return () =>
		{
			controller.abort();
		};
	}, [nodeId]);

	if (nodeId === null || loaded === null || loaded.nodeId !== nodeId)
	{
		return null;
	}
	const {data} = loaded;
	const deleteAll = async () =>
	{
		for (const id of deletionOrder(data))
		{
			// oxlint-disable-next-line no-await-in-loop -- the mirrors go before the original
			await new Promise<void>((resolve) =>
			{
				deleteNode.mutate(
					id,
					{
						onSettled: () =>
						{
							resolve();
						},
					},
				);
			});
		}
		close();
	};
	return (
		<DialogShell onClose={close}>
			<MirrorsDialogView
				data={data}
				renderCrumbs={(location) => (
					<LeftCollapsingCrumbs
						crumbs={location.path.map((crumb) => (
						{
							id: crumb.id,
							isRoot: false,
							name: crumb.name,
						}))}
						currentId={location.id}
						onNavigate={(id) =>
						{
							close();
							navigateToNode(id);
						}}
					/>
				)}
				onDeleteAll={() =>
				{
					void deleteAll();
				}}
			/>
			<DialogCloseButton onClose={close} />
		</DialogShell>
	);
}
