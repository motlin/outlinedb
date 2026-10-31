import {useQuery, useQueryClient} from "@tanstack/react-query";
import {createElement, useEffect, useState} from "react";
import type {ReactElement} from "react";
import {changelogEntryUnread} from "../changelog.js";
import type {ChangelogRead} from "../changelog.js";
import {CHANGELOG_ENTRIES} from "../changelog-entries.js";
import type {ChangelogEntry, ChangelogNode} from "../changelog-entries.js";
import {useAccount} from "../hooks/use-account.js";
import {fetchPreferences, markChangelogRead, preferenceKeys, premarkChangelog} from "../hooks/use-preferences.js";
import type {PreferencesState} from "../hooks/use-preferences.js";
import {useOutlineStore} from "../stores/outline.js";
import {DialogCloseButton, DialogShell, DialogTitle} from "./dialog-shell.js";
import {FaIcon} from "./fa-icons.js";

/** Upstream `WF.Urls.expand("/discourse/login/")`: the footer's community link. */
const COMMUNITY_LOGIN_URL = "https://workflowy.com/discourse/login/";

/** Upstream `I3`'s body section class, literal newlines and indents included. */
const SECTION_CLASS = `
        section leading-base flex flex-col gap-m
        [&_h2]:text-base
        [&_ul]:list-disc
        [&_ul]:ml-l
      `;

/** Upstream `a6` images and `Bc` videos add their own attributes; every other element keeps its props as given. */
function extraProps(tag: string): Record<string, unknown> {
	if (tag === "img") {
		return {className: "border border-stone-200 rounded-s"};
	}
	if (tag === "video") {
		return {autoPlay: true, muted: true, loop: true, playsInline: true};
	}
	return {};
}

function renderNode(node: ChangelogNode, key: number): ReactElement | string {
	if (typeof node === "string") {
		return node;
	}
	return createElement(
		node.t,
		{key, ...node.p, ...extraProps(node.t)},
		...(node.c ?? []).map((child, index) => renderNode(child, index)),
	);
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
 * Upstream `Rt0`: the dialog's title, the entries in a scroller and the community footer. `read` is the flags as
 * they were when the dialog opened, so entries marked read on open keep their dot until it closes. The Pro upsell
 * box is left out (there is no Pro subscription flow locally).
 */
export function ChangelogBody({
	entries = CHANGELOG_ENTRIES,
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
			<div className="footer sticky bottom-0 z-1 -mx-xl -mb-xl pt-l text-sm text-center border-t border-solid border-primary bg-primary shrink-0">
				<p>
					Questions or feedback? Get in touch on the {" "}
					<a href={COMMUNITY_LOGIN_URL} className="contentLink !text-tint" target="_blank">
						Workflowy Community.
					</a>
				</p>
			</div>
		</div>
	);
}

/** The open dialog: snapshots the read flags, then marks every entry read (upstream `Ut0`'s mount effect). */
function OpenChangelog({onClose}: {onClose: () => void}) {
	const queryClient = useQueryClient();
	const [read] = useState<ChangelogRead>(() => {
		const state = queryClient.getQueryData<PreferencesState>(preferenceKeys.all);
		// Loading or unavailable: nothing can be marked, so show every entry as read.
		return state?.available === true ? state.preferences.changelogRead : {};
	});
	useEffect(() => {
		void markChangelogRead(queryClient);
	}, [queryClient]);
	return (
		<DialogShell onClose={onClose}>
			<ChangelogBody read={read} />
			<DialogCloseButton onClose={onClose} />
		</DialogShell>
	);
}

/**
 * Upstream's `gui-changelog`: the What's New dialog (Help > What's New, command `show_changelog`), plus the boot-time
 * pre-mark (`Ht0`) that starts accounts joined after 2025-05-26 with every entry read.
 */
export function ChangelogHost() {
	const queryClient = useQueryClient();
	const open = useOutlineStore((state) => state.changelogOpen);
	const close = useOutlineStore((state) => state.closeChangelog);
	const account = useAccount();
	const joinedAt = account?.joinedAt ?? null;
	const {data: preferences} = useQuery({queryKey: preferenceKeys.all, queryFn: fetchPreferences});
	const read = preferences?.available === true ? preferences.preferences.changelogRead : undefined;
	useEffect(() => {
		if (joinedAt !== null && read === null) {
			void premarkChangelog(queryClient, joinedAt);
		}
	}, [queryClient, joinedAt, read]);
	return open ? <OpenChangelog onClose={close} /> : null;
}
