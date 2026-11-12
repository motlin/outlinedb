import {describe, expect, it} from "vite-plus/test";
import
{
	MIRROR_COPIED_TOAST,
	executeMirrorTo,
	mirrorClipboardHtml,
	mirrorToastText,
	mirrorSourceIds,
	parseMirrorPaste,
	planMirrorHere,
	planMirrorTo,
	shouldDeleteMirrorTrigger,
} from "../src/client/mirror-commands.js";
import type {MoveToToast} from "../src/client/move-to.js";
import {childInstance, instanceKey, isCyclical} from "../src/mirror-path.js";

describe("mirror commands", () =>
{
	describe("mirror clipboard", () =>
	{
		it("writes one data-wf-mirror div per original id, without upstream's undefined prefix", () =>
		{
			expect(mirrorClipboardHtml(["a", "b"])).toBe(
				'<div data-wf-mirror="a">&nbsp;</div><div data-wf-mirror="b">&nbsp;</div>',
			);
		});

		it("reads the original ids back out of the pasted html", () =>
		{
			expect(parseMirrorPaste(mirrorClipboardHtml(["a", "b"]))).toStrictEqual(["a", "b"]);
			expect(parseMirrorPaste("<div>plain</div>")).toStrictEqual([]);
		});

		it("toasts upstream's copied message for 30s, dismissed by the next copy or paste", () =>
		{
			expect(MIRROR_COPIED_TOAST).toStrictEqual(
				{
					text: "Mirror(s) copied. Paste it where you want it to go.",
					timeout: 30_000,
					dismissOn: ["copy", "paste"],
				},
			);
		});
	});

	describe("planMirrorTo", () =>
	{
		it("mirrors the items into the target at its default slot", () =>
		{
			expect(
				planMirrorTo(
					{
						items: ["a", "b"],
						target:
						{
							id: "t",
							defaultToBottom: false,
						},
						childCount: 3,
					},
				),
			).toStrictEqual(
				{
					item_ids: ["a", "b"],
					parent_id: "t",
					index: 0,
				},
			);
			expect(
				planMirrorTo(
					{
						items: ["a"],
						target:
						{
							id: "t",
							defaultToBottom: true,
						},
						childCount: 3,
					},
				),
			).toStrictEqual(
				{
					item_ids: ["a"],
					parent_id: "t",
					index: 3,
				},
			);
		});
	});

	describe("planMirrorHere", () =>
	{
		it("mirrors the picked item right after the row, under the row's parent", () =>
		{
			expect(
				planMirrorHere(
					{
						picked: "p",
						itemId: "row",
						parentId: "par",
						siblingIndex: 2,
						isZoomRoot: false,
					},
				),
			).toStrictEqual(
				{
					item_ids: ["p"],
					parent_id: "par",
					index: 3,
				},
			);
		});

		it("mirrors into the zoom root itself at the top", () =>
		{
			expect(
				planMirrorHere(
					{
						picked: "p",
						itemId: "zoom",
						parentId: "up",
						siblingIndex: 0,
						isZoomRoot: true,
					},
				),
			).toStrictEqual(
				{
					item_ids: ["p"],
					parent_id: "zoom",
					index: 0,
				},
			);
		});
	});

	describe("shouldDeleteMirrorTrigger", () =>
	{
		it("deletes only an empty, childless, writable, non-zoom row", () =>
		{
			const empty =
			{
				name: "",
				note: "",
				childCount: 0,
				isZoomRoot: false,
				readOnly: false,
			};
			expect([
				shouldDeleteMirrorTrigger(empty),
				shouldDeleteMirrorTrigger(
					{
						...empty,
						name: "x",
					},
				),
				shouldDeleteMirrorTrigger(
					{
						...empty,
						note: "n",
					},
				),
				shouldDeleteMirrorTrigger(
					{
						...empty,
						childCount: 1,
					},
				),
				shouldDeleteMirrorTrigger(
					{
						...empty,
						isZoomRoot: true,
					},
				),
				shouldDeleteMirrorTrigger(
					{
						...empty,
						readOnly: true,
					},
				),
			]).toStrictEqual([true, false, false, false, false, false]);
		});
	});

	describe("mirrorToastText", () =>
	{
		it("words the toasts like upstream", () =>
		{
			expect([
				mirrorToastText("to", "Target"),
				mirrorToastText("here", "Target"),
				mirrorToastText("cant-here", "Target"),
			]).toStrictEqual([
				"mirrored to 'Target'",
				"mirrored 'Target' here",
				"Can't mirror the selected bullet here",
			]);
		});
	});

	describe("executeMirrorTo", () =>
	{
		function run(
			overrides:
			{
				picked?:
					|
					  {
							id: string;
					  }
					| undefined;
				created?: boolean;
			} = {},
		)
		{
			const toasts: MoveToToast[] = [];
			const mirrored: unknown[] = [];
			const viewed: string[] = [];
			let undone = 0;
			const result = executeMirrorTo(
				{
					items: ["a"],
					pick: async () =>
						Promise.resolve(
							"picked" in overrides
								? overrides.picked
								:
									{
										id: "t",
									},
						),
					loadTarget: async (id) =>
						Promise.resolve(
							{
								target:
								{
									id,
									name: "Target",
									defaultToBottom: false,
								},
								childCount: 2,
								parentOf: () => null,
							},
						),
					mirrorNodes: async (request) =>
					{
						mirrored.push(request);
						return Promise.resolve(overrides.created === false ? 0 : request.item_ids.length);
					},
					showToast: (toast) =>
					{
						toasts.push(toast);
					},
					view: (id) =>
					{
						viewed.push(id);
					},
					undo: () =>
					{
						undone += 1;
					},
				},
			);
			return {
				result,
				toasts,
				mirrored,
				viewed,
				undone: () => undone,
			};
		}

		it("mirrors into the picked target and toasts with View and Undo", async () =>
		{
			const {result, toasts, mirrored, viewed, undone} = run();
			await expect(result).resolves.toBe(true);
			expect(mirrored).toStrictEqual([
				{
					item_ids: ["a"],
					parent_id: "t",
					index: 0,
				},
			]);
			expect(
				toasts.map(({text, timeout, actions}) => (
				{
					text,
					timeout,
					labels: actions.map((a) => a.label),
				})),
			).toStrictEqual([
				{
					text: "mirrored to 'Target'",
					timeout: 5000,
					labels: ["View", "Undo"],
				},
			]);
			toasts[0]?.actions[0]?.run();
			toasts[0]?.actions[1]?.run();
			expect([viewed, undone()]).toStrictEqual([["t"], 1]);
		});

		it("does nothing when the picker is cancelled", async () =>
		{
			const {result, toasts, mirrored} = run(
				{
					picked: undefined,
				},
			);
			expect([await result, toasts, mirrored]).toStrictEqual([false, [], []]);
		});
	});

	describe("mirrorSourceIds", () =>
	{
		it("copies a mirror's original id and an original's own id", () =>
		{
			const nodes: Record<
				string,
				{
					isMirror?: boolean;
					originalNodeId?: string | null;
				}
			> =
			{
				m:
				{
					isMirror: true,
					originalNodeId: "orig",
				},
				o:
				{
					isMirror: false,
				},
			};
			expect(mirrorSourceIds(["m", "o", "unknown"], (id) => nodes[id])).toStrictEqual(["orig", "o", "unknown"]);
		});
	});
});

describe("mirror path", () =>
{
	const M = "aaaa0000-0000-0000-0000-000000000000";
	const K = "bbbb0000-0000-0000-0000-000000000000";
	const mirrorM =
	{
		id: M,
		isMirror: true,
	};
	const plainK =
	{
		id: K,
	};

	describe("childInstance", () =>
	{
		it("starts an instance at a mirror met outside any mirror", () =>
		{
			expect(childInstance(mirrorM, null)).toStrictEqual(
				{
					rootId: M,
					path: "aaaa",
				},
			);
		});

		it("leaves a plain row outside any mirror outside", () =>
		{
			expect(childInstance(plainK, null)).toBeNull();
		});

		it("grows the path by the first four characters of each row's id", () =>
		{
			const paths: string[] = [];
			let instance = childInstance(mirrorM, null);
			for (const node of [plainK, mirrorM, plainK, mirrorM, plainK])
			{
				instance = childInstance(node, instance);
				paths.push(instance?.path ?? "");
			}
			expect(paths).toStrictEqual([
				"aaaabbbb",
				"aaaabbbbaaaa",
				"aaaabbbbaaaabbbb",
				"aaaabbbbaaaabbbbaaaa",
				"aaaabbbbaaaabbbbaaaabbbb",
			]);
		});
	});

	describe("isCyclical", () =>
	{
		it("is false while a mirror's chunk has repeated fewer than three times", () =>
		{
			expect(
				isCyclical(
					mirrorM,
					{
						rootId: M,
						path: "aaaabbbbaaaabbbb",
					},
				),
			).toBe(false);
		});

		it("is true once a chunk repeats three times", () =>
		{
			expect(
				isCyclical(
					mirrorM,
					{
						rootId: M,
						path: "aaaabbbbaaaabbbbaaaabbbb",
					},
				),
			).toBe(true);
		});

		it("is true for a mirror identified by originalNodeId", () =>
		{
			expect(
				isCyclical(
					{
						originalNodeId: K,
					},
					{
						rootId: M,
						path: "aaaabbbbaaaabbbbaaaabbbb",
					},
				),
			).toBe(true);
		});

		it("is false for a plain row at the same path", () =>
		{
			expect(
				isCyclical(
					plainK,
					{
						rootId: M,
						path: "aaaabbbbaaaabbbbaaaabbbb",
					},
				),
			).toBe(false);
		});

		it("is false outside any mirror", () =>
		{
			expect(isCyclical(mirrorM, null)).toBe(false);
		});
	});

	describe("instanceKey", () =>
	{
		it("is the parent id outside a mirror and distinguishes instances inside one", () =>
		{
			expect([
				instanceKey("p", null),
				instanceKey(
					"p",
					{
						rootId: M,
						path: "aaaa",
					},
				),
				instanceKey(
					"p",
					{
						rootId: M,
						path: "aaaabbbb",
					},
				),
				instanceKey(null, null),
			]).toStrictEqual(["p", `p@${M}_aaaa`, `p@${M}_aaaabbbb`, null]);
		});
	});
});
