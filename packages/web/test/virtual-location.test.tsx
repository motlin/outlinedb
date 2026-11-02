// @vitest-environment happy-dom
import {describe, expect, it} from "vite-plus/test";
import {nodeUrl} from "../src/client/navigation.js";

describe("nodeUrl", () =>
{
	it("links a row inside a mirror by its virtual location", () =>
	{
		const child = "7b1c2d3e-aaaa-4bbb-8ccc-c910f3eac9b3";
		const root = "0e9f8d7c-1111-4222-8333-d4f14a54f384";

		expect(
			{
				plain: nodeUrl(child),
				inMirror: nodeUrl(
					child,
					{
						rootId: root,
						path: "0e9f",
					},
				),
				deeper: nodeUrl(
					child,
					{
						rootId: root,
						path: "0e9f7b1c",
					},
				),
			},
		).toStrictEqual(
			{
				plain: "/#/c910f3eac9b3",
				inMirror: "/#/v_c910f3eac9b3_d4f14a54f384_0e9f",
				deeper: "/#/v_c910f3eac9b3_d4f14a54f384_0e9f7b1c",
			},
		);
	});
});
