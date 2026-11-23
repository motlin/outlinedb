import {describe, expect, it} from "vite-plus/test";
import {readWorkerConfig} from "../src/worker-config";

describe("readWorkerConfig", () =>
{
	it("starts every account standalone with no Workflowy credentials, keeping the upstream URL", () =>
	{
		expect(
			readWorkerConfig(
				{
					WORKFLOWY_API_URL: "http://upstream.test",
				},
			),
		).toStrictEqual(
			{
				mode: "standalone",
				apiKey: undefined,
				apiUrl: "http://upstream.test",
				accountEmail: "",
				sqlQueryLogging: false,
				calendarEnsureEnabled: true,
				calendarLayoutEnabled: true,
				features:
				{
					embeddings: false,
					treeSnapshot: false,
				},
			},
		);
	});

	it("turns the tree snapshot on only when TREE_SNAPSHOT is true", () =>
	{
		expect(
			readWorkerConfig(
				{
					TREE_SNAPSHOT: "true",
				},
			).features,
		).toStrictEqual(
			{
				embeddings: false,
				treeSnapshot: true,
			},
		);
	});

	it("turns embeddings on only when both the AI and the RELATED_INDEX bindings exist", () =>
	{
		const binding = {};
		expect(
			[
				{
					AI: binding,
					RELATED_INDEX: binding,
				},
				{
					AI: binding,
				},
				{
					RELATED_INDEX: binding,
				},
			].map((env) => readWorkerConfig(env).features.embeddings),
		).toStrictEqual([true, false, false]);
	});

	it("treats an empty upstream URL as unset", () =>
	{
		expect(
			readWorkerConfig(
				{
					WORKFLOWY_API_URL: "",
				},
			).apiUrl,
		).toBeUndefined();
	});
});
