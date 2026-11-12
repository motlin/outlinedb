import {describe, expect, it} from "vite-plus/test";
import {createFakeInternalApi, forbidTreeData, treeDataReads} from "./helpers/fake-internal-api.js";

describe("fake internal API tree-data helpers", () =>
{
	it("counts only /get_tree_data/ requests", async () =>
	{
		const api = createFakeInternalApi();

		await api.fetch("https://workflowy.test/get_tree_data/");
		await api.fetch("https://workflowy.test/get_initialization_data");
		await api.fetch("https://workflowy.test/get_tree_data/?ot=4567");

		expect(treeDataReads(api)).toBe(2);
	});

	it("answers a forbidden /get_tree_data/ with 500 and records the call", async () =>
	{
		const api = createFakeInternalApi();
		const forbidden = forbidTreeData(api);

		const response = await api.fetch("https://workflowy.test/get_tree_data/");

		expect(
			{
				status: response.status,
				forbidden: forbidden.map((request) => [request.method, request.path]),
				reads: treeDataReads(api),
			},
		).toStrictEqual(
			{
				status: 500,
				forbidden: [["GET", "/get_tree_data/"]],
				reads: 1,
			},
		);
	});
});
