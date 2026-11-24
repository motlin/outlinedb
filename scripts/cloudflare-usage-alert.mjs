// Daily Cloudflare cost and health check, run by .github/workflows/usage-alert.yml.
// Queries the GraphQL Analytics API for one UTC day of the outlinedb Worker's and its Durable Objects' usage, and the
// Analytics Engine SQL API for that day's whole-tree workflowy.com downloads (about 54 MB each), prints the totals and the busiest Durable Objects, and exits 1 when a total passes its budget, so the failed scheduled run notifies by GitHub's email.
// Usage: CLOUDFLARE_ANALYTICS_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... node scripts/cloudflare-usage-alert.mjs [YYYY-MM-DD]
import {appendFileSync} from "node:fs";

/**
 * @typedef {{
 * 	doRowsRead: number,
 * 	doRowsWritten: number,
 * 	doRequests: number,
 * 	doErrors: number,
 * 	doCpuMs: number,
 * 	workerRequests: number,
 * 	workerErrors: number,
 * 	workerCpuMs: number,
 * 	treeDownloads: number,
 * }} Totals
 * @typedef {Totals} Budgets
 * @typedef {{
 * 	namespaceId: string,
 * 	objectId: string,
 * 	rowsRead: number,
 * 	rowsWritten: number,
 * 	cpuMs: number,
 * 	requests: number,
 * 	errors: number,
 * }} ObjectUsage
 * @typedef {{
 * 	periodic: {dimensions: {namespaceId: string, objectId: string}, sum: {rowsRead: number, rowsWritten: number, cpuTime: number}}[],
 * 	invocations: {dimensions: {namespaceId: string, objectId: string, scriptName: string}, sum: {requests: number, errors: number}}[],
 * 	workers: {dimensions: {scriptName: string, status: string}, sum: {requests: number, errors: number, cpuTimeUs: number}}[],
 * }} UsageResponse
 * @typedef {{data?: {viewer: {accounts: UsageResponse[]}} | null, errors?: {message: string}[] | null}} GraphqlResponse
 */

// Workers Paid includes per month: 10M Worker requests, 30M CPU ms, 1M Durable Object requests, 25B SQLite rows read
// and 50M rows written. Each cost budget is a quarter of one day's share (monthly / 30 / 4), so a day trips it long
// before the month's allowance is at risk. Included amounts are account-wide, but the budgets count only the outlinedb
// script, so another project's traffic on the account never trips them. A syncing account's Durable Object costs about
// 24 requests a day (the hourly catch-up) plus one per edit made on workflowy.com while a tab is visible; Durable
// Object duration (400k GB-s a month included) is not budgeted here, though a visible tab keeps its object awake
// holding workflowy.com's signal socket: 8 visible hours a day is about 108k GB-s a month at 128 MB.
const script = "outlinedb";
/** @param {number} monthly */
const dailyQuarter = (monthly) => Math.round(monthly / 30 / 4);

/** @type {Budgets} */
const budgets =
{
	doRowsRead: dailyQuarter(25_000_000_000),
	doRowsWritten: dailyQuarter(50_000_000),
	doRequests: dailyQuarter(1_000_000),
	// Health, not cost: Durable Objects bill by duration, not CPU. A full workflowy.com import took about 90 s.
	doCpuMs: 5 * 60 * 1000,
	doErrors: 10,
	workerRequests: dailyQuarter(10_000_000),
	workerErrors: 10,
	workerCpuMs: dailyQuarter(30_000_000),
	// Health and memory, not billing: each import downloads the whole tree into a Durable Object once, so a day with more
	// than this many means something downloads it repeatedly.
	treeDownloads: 5,
};

/** @type {(keyof Totals)[]} */
const metrics = [
	"doRowsRead",
	"doRowsWritten",
	"doRequests",
	"doCpuMs",
	"doErrors",
	"workerRequests",
	"workerErrors",
	"workerCpuMs",
	"treeDownloads",
];

/** The Worker's Analytics Engine dataset with one data point per whole-tree download (see wrangler.jsonc). */
const treeDownloadsDataset = "outlinedb_tree_downloads";

const query = `query($account: String!, $date: Date!, $script: String!) { viewer { accounts(filter: {accountTag: $account}) {
	periodic: durableObjectsPeriodicGroups(limit: 10000, filter: {date: $date}) {
		dimensions { namespaceId objectId }
		sum { rowsRead rowsWritten cpuTime }
	}
	invocations: durableObjectsInvocationsAdaptiveGroups(limit: 10000, filter: {date: $date, scriptName: $script}) {
		dimensions { namespaceId objectId scriptName }
		sum { requests errors }
	}
	workers: workersInvocationsAdaptive(limit: 10000, filter: {date: $date, scriptName: $script}) {
		dimensions { scriptName status }
		sum { requests errors cpuTimeUs }
	}
} } }`;

/**
 * Storage rows carry no script name, so a Durable Object counts only when its namespace has an invocation by `scriptName`.
 * @param {UsageResponse} usage
 * @param {string} scriptName
 * @param {number} treeDownloads the day's whole-tree downloads, from {@link treeDownloadCount}
 * @returns {{totals: Totals, objects: ObjectUsage[]}}
 */
export function summarizeUsage(usage, scriptName, treeDownloads)
{
	/** @type {Map<string, ObjectUsage>} */
	const objects = new Map();
	/**
	 * @param {string} namespaceId
	 * @param {string} objectId
	 */
	const objectFor = (namespaceId, objectId) =>
	{
		const key = `${namespaceId}/${objectId}`;
		const existing = objects.get(key);
		if (existing)
		{
			return existing;
		}
		/** @type {ObjectUsage} */
		const created =
		{
			namespaceId,
			objectId,
			rowsRead: 0,
			rowsWritten: 0,
			cpuMs: 0,
			requests: 0,
			errors: 0,
		};
		objects.set(key, created);
		return created;
	};
	for (const {dimensions, sum} of usage.periodic)
	{
		const object = objectFor(dimensions.namespaceId, dimensions.objectId);
		object.rowsRead += sum.rowsRead;
		object.rowsWritten += sum.rowsWritten;
		object.cpuMs += sum.cpuTime / 1000;
	}
	for (const {dimensions, sum} of usage.invocations)
	{
		const object = objectFor(dimensions.namespaceId, dimensions.objectId);
		object.requests += sum.requests;
		object.errors += sum.errors;
	}
	const namespaces = new Set(
		usage.invocations
			.filter(({dimensions}) => dimensions.scriptName === scriptName)
			.map(({dimensions}) => dimensions.namespaceId),
	);
	const all = [...objects.values()].filter((object) => namespaces.has(object.namespaceId));
	const workers = usage.workers.filter(({dimensions}) => dimensions.scriptName === scriptName);
	/** @param {(object: ObjectUsage) => number} field */
	const total = (field) => all.reduce((acc, object) => acc + field(object), 0);
	return {
		totals:
		{
			doRowsRead: total((object) => object.rowsRead),
			doRowsWritten: total((object) => object.rowsWritten),
			doRequests: total((object) => object.requests),
			doErrors: total((object) => object.errors),
			doCpuMs: total((object) => object.cpuMs),
			workerRequests: workers.reduce((acc, {sum}) => acc + sum.requests, 0),
			workerErrors: workers.reduce((acc, {sum}) => acc + sum.errors, 0),
			workerCpuMs: workers.reduce((acc, {sum}) => acc + sum.cpuTimeUs, 0) / 1000,
			treeDownloads,
		},
		objects: all,
	};
}

/**
 * The day's whole-tree downloads from an Analytics Engine SQL answer. The dataset exists only after the Worker's first
 * write to it, so an error naming it as missing counts as none; any other error throws.
 * @param {boolean} ok whether the query answered with a 2xx
 * @param {unknown} body the parsed JSON answer, or the error text
 * @returns {number}
 */
export function treeDownloadCount(ok, body)
{
	if (!ok)
	{
		const text = typeof body === "string" ? body : JSON.stringify(body);
		if (text.includes(treeDownloadsDataset) && /does not exist|not found|unknown/iu.test(text))
		{
			return 0;
		}
		throw new Error(`Analytics Engine query failed: ${text}`);
	}
	/** @type {unknown} */
	const data = typeof body === "object" && body !== null ? Reflect.get(body, "data") : undefined;
	/** @type {unknown} */
	const row = Array.isArray(data) ? data[0] : undefined;
	/** @type {unknown} */
	const downloads = typeof row === "object" && row !== null ? Reflect.get(row, "downloads") : undefined;
	// Analytics Engine answers 64-bit sums as strings, and a sum over no rows as null.
	return downloads === null || downloads === undefined ? 0 : Number(downloads);
}

/**
 * Every total strictly above its budget, in the budgets' order.
 * @param {Totals} totals
 * @param {Budgets} limits
 * @returns {{metric: keyof Totals, value: number, budget: number}[]}
 */
export function findOverruns(totals, limits)
{
	return metrics
		.filter((metric) => totals[metric] > limits[metric])
		.map((metric) => (
		{
			metric,
			value: totals[metric],
			budget: limits[metric],
		}));
}

/** @param {number} value */
const format = (value) => Math.round(value).toLocaleString("en-US");

/**
 * @param {string} date
 * @param {{totals: Totals, objects: ObjectUsage[]}} summary
 * @param {{metric: keyof Totals, value: number, budget: number}[]} overruns
 */
function formatReport(date, summary, overruns)
{
	const over = new Set(overruns.map(({metric}) => metric));
	const busiest = summary.objects
		.toSorted((a, b) => b.rowsRead + b.rowsWritten - (a.rowsRead + a.rowsWritten))
		.slice(0, 10);
	return [
		`## Cloudflare usage of ${script} for ${date} (UTC)`,
		"",
		overruns.length === 0
			? "All totals are within budget."
			: `**${overruns.length} over budget:** ${[...over].join(", ")}`,
		"",
		"| Metric | Value | Budget | |",
		"| --- | ---: | ---: | --- |",
		...metrics.map(
			(metric) =>
				`| ${metric} | ${format(summary.totals[metric])} | ${format(budgets[metric])} | ${over.has(metric) ? "OVER" : "ok"} |`,
		),
		"",
		"### Busiest Durable Objects (by rows read + written)",
		"",
		"| Namespace | Object | Rows read | Rows written | CPU ms | Requests | Errors |",
		"| --- | --- | ---: | ---: | ---: | ---: | ---: |",
		...busiest.map(
			(object) =>
				`| ${object.namespaceId} | ${object.objectId.slice(0, 12)} | ${format(object.rowsRead)} | ${format(
					object.rowsWritten,
				)} | ${format(object.cpuMs)} | ${format(object.requests)} | ${format(object.errors)} |`,
		),
		"",
	].join("\n");
}

/** @returns {string} yesterday's UTC date as YYYY-MM-DD */
function yesterday()
{
	return new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** @param {string} name */
function requireEnv(name)
{
	const value = process.env[name];
	if (!value)
	{
		throw new Error(`${name} is not set`);
	}
	return value;
}

/**
 * One UTC day's whole-tree downloads across every account, each data point weighted by its sample interval.
 * @param {string} accountId
 * @param {string} token
 * @param {string} date YYYY-MM-DD
 */
async function fetchTreeDownloads(accountId, token, date)
{
	if (!/^\d{4}-\d{2}-\d{2}$/u.test(date))
	{
		throw new Error(`Expected a YYYY-MM-DD date, got ${date}`);
	}
	const next = new Date(Date.parse(`${date}T00:00:00Z`) + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
	const response = await fetch(
		`https://api.cloudflare.com/client/v4/accounts/${accountId}/analytics_engine/sql`,
		{
			method: "POST",
			headers:
			{
				Authorization: `Bearer ${token}`,
			},
			body: `SELECT SUM(_sample_interval) AS downloads FROM ${treeDownloadsDataset} WHERE timestamp >= toDateTime('${date} 00:00:00') AND timestamp < toDateTime('${next} 00:00:00') FORMAT JSON`,
		},
	);
	const text = await response.text();
	return treeDownloadCount(response.ok, response.ok ? JSON.parse(text) : text);
}

async function main()
{
	const date = process.argv[2] ?? yesterday();
	const treeDownloads = await fetchTreeDownloads(
		requireEnv("CLOUDFLARE_ACCOUNT_ID"),
		requireEnv("CLOUDFLARE_ANALYTICS_API_TOKEN"),
		date,
	);
	const response = await fetch(
		"https://api.cloudflare.com/client/v4/graphql",
		{
			method: "POST",
			headers:
			{
				Authorization: `Bearer ${requireEnv("CLOUDFLARE_ANALYTICS_API_TOKEN")}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(
				{
					query,
					variables:
					{
						account: requireEnv("CLOUDFLARE_ACCOUNT_ID"),
						date,
						script,
					},
				},
			),
		},
	);
	/** @type {unknown} */
	const parsed = await response.json();
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the GraphQL Analytics API's documented response shape
	const body = /** @type {GraphqlResponse} */ (parsed);
	const usage = body.data?.viewer.accounts[0];
	if (!response.ok || (body.errors ?? []).length > 0 || !usage)
	{
		throw new Error(
			`GraphQL Analytics query failed (HTTP ${response.status}): ${JSON.stringify(body.errors ?? body)}`,
		);
	}
	const summary = summarizeUsage(usage, script, treeDownloads);
	const overruns = findOverruns(summary.totals, budgets);
	const report = formatReport(date, summary, overruns);
	console.log(report);
	if (process.env.GITHUB_STEP_SUMMARY)
	{
		appendFileSync(process.env.GITHUB_STEP_SUMMARY, report);
	}
	if (overruns.length > 0)
	{
		process.exitCode = 1;
	}
}

if (process.argv[1] === import.meta.filename)
{
	await main();
}
