// Run: node --test plugins/gtd/scripts/render-overview.test.mts
/* eslint-disable @typescript-eslint/no-floating-promises -- node:test test() calls are fire-and-forget by design */
import {test} from "node:test";
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {renderOverview} from "./render-overview.mts";

const script = new URL("render-overview.mts", import.meta.url).pathname;

function withDirectory(body: (directory: string) => void): void
{
	const directory = mkdtempSync(join(tmpdir(), "render-overview-test-"));
	try
	{
		body(directory);
	}
	finally
	{
		rmSync(
			directory,
			{
				recursive: true,
				force: true,
			},
		);
	}
}

function run(args: string[])
{
	const result = spawnSync(
		process.execPath,
		[script, ...args],
		{
			encoding: "utf8",
		},
	);
	return {
		status: result.status,
		stdout: result.stdout,
		stderr: result.stderr,
	};
}

function main(html: string): string
{
	const match = /<main>([\s\S]*)<\/main>/u.exec(html);
	const content = match?.[1];
	assert.ok(content !== undefined, "page has a <main>");
	return content.trim();
}

test("renders every section, group, item, link, and note in order", () =>
{
	const html = renderOverview(
		{
			title: "Morning overview",
			subtitle: "Tue, Nov 3",
			sections: [
				{
					heading: "📅 Today — Tue, Nov 3",
					link:
					{
						label: "Open Fantastical",
						href: "fantastical://",
					},
					groups: [
						{
							heading: "Fantastical",
							items: [
								{
									text: "10:00 AM - Team standup",
									note: "Work",
								},
							],
						},
						{
							heading: "Workflowy",
							items: [],
						},
					],
				},
				{
					heading: "☑️ Next Actions",
					groups: [
						{
							items: [
								{
									text: "Call the plumber",
									href: "https://workflowy.com/#/abc123",
									highlight: true,
								},
							],
						},
					],
					notes: ["Quick win: Call the plumber"],
				},
			],
		},
	);
	assert.equal(
		main(html),
		[
			'<header><h1>Morning overview</h1><p class="subtitle">Tue, Nov 3</p></header>',
			'<section><h2>📅 Today — Tue, Nov 3 <a class="section-link" href="fantastical://">Open Fantastical</a></h2>',
			'<h3>Fantastical</h3><ul><li>10:00 AM - Team standup <span class="note">Work</span></li></ul>',
			'<h3>Workflowy</h3><p class="empty">None</p>',
			"</section>",
			"<section><h2>☑️ Next Actions</h2>",
			'<ul><li class="highlight"><a href="https://workflowy.com/#/abc123">Call the plumber</a></li></ul>',
			'<p class="section-note">Quick win: Call the plumber</p>',
			"</section>",
		].join("\n"),
	);
	assert.match(html, /<title>Morning overview<\/title>/u);
});

test("escapes text once, decoding Workflowy entities first", () =>
{
	const html = renderOverview(
		{
			title: "A <b> & B",
			sections: [
				{
					heading: "H",
					groups: [
						{
							items: [
								{
									text: "Tom &amp; Jerry <script>",
								},
							],
						},
					],
				},
			],
		},
	);
	assert.equal(
		main(html),
		[
			"<header><h1>A &lt;b&gt; &amp; B</h1></header>",
			"<section><h2>H</h2>",
			"<ul><li>Tom &amp; Jerry &lt;script&gt;</li></ul>",
			"</section>",
		].join("\n"),
	);
});

test("CLI writes the page and prints its path", () =>
{
	withDirectory((directory) =>
	{
		const input = join(directory, "overview.json");
		const output = join(directory, "overview.html");
		const spec =
		{
			title: "T",
			sections: [
				{
					heading: "H",
					groups: [
						{
							items: [
								{
									text: "x",
								},
							],
						},
					],
				},
			],
		};
		writeFileSync(input, JSON.stringify(spec));
		assert.deepStrictEqual(
			run([input, output]),
			{
				status: 0,
				stdout: `${output}\n`,
				stderr: "",
			},
		);
		assert.equal(readFileSync(output, "utf8"), renderOverview(spec));
	});
});

test("CLI refuses a spec missing its sections", () =>
{
	withDirectory((directory) =>
	{
		const input = join(directory, "overview.json");
		writeFileSync(
			input,
			JSON.stringify(
				{
					title: "T",
				},
			),
		);
		assert.deepStrictEqual(
			run([input, join(directory, "out.html")]),
			{
				status: 2,
				stdout: "",
				stderr: "overview.sections must be a JSON array\n",
			},
		);
	});
});

test("CLI prints usage without two paths", () =>
{
	assert.deepStrictEqual(
		run(["only-one.json"]),
		{
			status: 2,
			stdout: "",
			stderr: "Usage: render-overview.mts <overview.json> <overview.html>\n",
		},
	);
});
