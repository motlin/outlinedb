import {useQueryClient} from "@tanstack/react-query";
import {useEffect, useState} from "react";
import {useOutlineStore} from "../stores/outline.js";
import {isStalled, oldestInFlightStart} from "../sync-health.js";

interface OfflineNoticeBarProps {
	entered: boolean;
	left: number;
	onRetry: () => void;
}

/** Upstream's stalled `.offlineNotice` bar, verbatim classes. */
export function OfflineNoticeBar({entered, left, onRetry}: OfflineNoticeBarProps) {
	return (
		<div
			className="fixed right-sar border-t border-b border-solid border-primary text-center text-primary transition-transform duration-200 ease-base print:hidden flex flex-wrap items-center justify-center gap-x-m gap-y-xs px-l py-s text-s leading-base bg-warning offlineNotice"
			style={{
				bottom: 0,
				top: "unset",
				left: `${left}px`,
				transform: `translateY(${entered ? "0" : "100%"})`,
				zIndex: 500,
			}}
		>
			<span>
				<strong>Changes are not syncing.</strong> Keep the OutlineDB app open while we reconnect.
			</span>
			<button
				type="button"
				className="bg-transparent border-0 p-0 text-primary font-semibold underline cursor-pointer"
				onClick={onRetry}
			>
				Try syncing now
			</button>
		</div>
	);
}

/** Mounted once. Shows while a write has hung for 2 minutes and the caret is not in a row. */
export function OfflineNotice() {
	const queryClient = useQueryClient();
	const editing = useOutlineStore((state) => state.editingId !== null);
	const left = useOutlineStore((state) => state.leftBarOffset());
	const [stalled, setStalled] = useState(false);
	const [phase, setPhase] = useState<"hidden" | "entering" | "entered" | "exiting">("hidden");
	const visible = stalled && !editing;
	const wanted = visible ? "entering" : "exiting";
	const [lastWanted, setLastWanted] = useState(wanted);
	if (lastWanted !== wanted) {
		setLastWanted(wanted);
		if (visible) {
			setPhase("entering");
		} else if (phase !== "hidden") {
			setPhase("exiting");
		}
	}

	useEffect(() => {
		const check = (): void => {
			const mutations = queryClient.getMutationCache().getAll();
			setStalled(isStalled({oldestInFlightStartedAt: oldestInFlightStart(mutations), now: Date.now()}));
		};
		const timer = setInterval(check, 1000);
		return () => {
			clearInterval(timer);
		};
	}, [queryClient]);

	useEffect(() => {
		let cancel = (): void => {};
		if (phase === "entering") {
			const frame = requestAnimationFrame(() => {
				setPhase("entered");
			});
			cancel = () => {
				cancelAnimationFrame(frame);
			};
		} else if (phase === "exiting") {
			const timer = setTimeout(() => {
				setPhase("hidden");
			}, 200);
			cancel = () => {
				clearTimeout(timer);
			};
		}
		return cancel;
	}, [phase]);

	if (phase === "hidden") {
		return null;
	}
	return (
		<OfflineNoticeBar
			entered={phase === "entered"}
			left={left}
			onRetry={() => {
				void queryClient.resumePausedMutations().then(async () => queryClient.invalidateQueries());
			}}
		/>
	);
}
