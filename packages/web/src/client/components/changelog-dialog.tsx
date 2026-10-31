import {useQueryClient} from "@tanstack/react-query";
import {createElement, useEffect, useState} from "react";
import type {ReactElement} from "react";
import {changelogEntryUnread} from "../changelog.js";
import type {ChangelogRead} from "../changelog.js";
import {WHATS_NEW_ENTRIES} from "../whats-new-entries.js";
import type {ChangelogEntry, ChangelogNode} from "../whats-new-entries.js";
import {markWhatsNewRead, whatsNewKeys} from "../hooks/use-whats-new.js";
import type {WhatsNewState} from "../hooks/use-whats-new.js";
import {useOutlineStore} from "../stores/outline.js";
import {DialogCloseButton, DialogShell, DialogTitle} from "./dialog-shell.js";
import {FaIcon} from "./fa-icons.js";

/** Upstream `I3`'s body section class, literal newlines and indents included. */
const SECTION_CLASS = `
        section leading-base flex flex-col gap-m
        [&_h2]:text-base
        [&_ul]:list-disc
        [&_ul]:ml-l
      `;

function renderNode(node: ChangelogNode, key: number): ReactElement | string {
	if (typeof node === "string") {
		return node;
	}
	return createElement(node.t, {key, ...node.p}, ...(node.c ?? []).map((child, index) => renderNode(child, index)));
}

/** Upstream `WF.DomKit.NotificationDot`. */
function NotificationDot() {
	return <FaIcon className="w-m h-m text-tint blue-circle" icon="fas:circle" />;
}

/**
 * Upstream `I3`: one What's New entry, dotted and rounded while unread, else divided by a bottom border. The
 * like/dislike thumbs are left out (upstream's `changelog.liked` is not stored locally), leaving the empty
 * `div.flex.gap-m` upstream renders when it shows no thumbs.
 */
export function ChangelogEntryView({entry, unread}: {entry: ChangelogEntry; unread: boolean}) {
	return (
		<div className={`flex flex-col gap-ml p-m ${unread ? "rounded-s" : "border-b border-solid border-primary"}`}>
			<div className="update-header flex flex-col gap-xs">
				<div className="title-row flex items-center gap-s justify-between">
					<div className="items-center flex gap-s">
						{unread && <NotificationDot />}
						<h2 className="text-base">{entry.title}</h2>
					</div>
				</div>
				<time className="text-s text-tertiary">{entry.date}</time>
			</div>
			<div className={SECTION_CLASS}>{entry.body.map((node, index) => renderNode(node, index))}</div>
			<div className="flex justify-between mb-m">
				<span />
				<div className="flex gap-m" />
			</div>
		</div>
	);
}

/**
 * Upstream `Rt0`: the dialog's title and the entries in a scroller. `read` is the read entries as they were when the
 * dialog opened, so entries marked read on open keep their dot until it closes. The Pro upsell box and the Workflowy
 * Community footer are left out: the entries announce our features, not workflowy.com's.
 */
export function ChangelogBody({
	entries = WHATS_NEW_ENTRIES,
	read,
}: {
	entries?: readonly ChangelogEntry[];
	read: ChangelogRead;
}) {
	return (
		<div className="flex flex-col flex-1 max-h-[calc(80vh_-_var(--wf-space-2xl)_-_var(--wf-space-2xl))] min-h-0 gap-l [@media(max-height:700px)]:max-h-none [@media(max-width:576px)]:max-h-none">
			<DialogTitle>What&apos;s new</DialogTitle>
			<div className="text-s leading-s paragraph flex-1 min-h-0 overflow-y-auto">
				<div className="container flex flex-col gap-l">
					{entries.map((entry) => (
						<ChangelogEntryView
							entry={entry}
							key={entry.id}
							unread={changelogEntryUnread(read, entry.id)}
						/>
					))}
				</div>
			</div>
		</div>
	);
}

/** The open dialog: snapshots the read entries, then marks every entry read (upstream `Ut0`'s mount effect). */
function OpenChangelog({onClose}: {onClose: () => void}) {
	const queryClient = useQueryClient();
	const [read] = useState<ChangelogRead>(
		// Loading or failed: nothing can be marked, so show every entry as read.
		() =>
			queryClient.getQueryData<WhatsNewState>(whatsNewKeys.all)?.read ??
			WHATS_NEW_ENTRIES.map((entry) => entry.id),
	);
	useEffect(() => {
		void markWhatsNewRead(queryClient);
	}, [queryClient]);
	return (
		<DialogShell onClose={onClose}>
			<ChangelogBody read={read} />
			<DialogCloseButton onClose={onClose} />
		</DialogShell>
	);
}

/** Upstream's `gui-changelog`: the What's New dialog (Help > What's New, command `show_changelog`). */
export function ChangelogHost() {
	const open = useOutlineStore((state) => state.changelogOpen);
	const close = useOutlineStore((state) => state.closeChangelog);
	return open ? <OpenChangelog onClose={close} /> : null;
}
