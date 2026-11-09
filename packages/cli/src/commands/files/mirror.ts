import {WorkflowyInternalClient} from "@outlinedb/shared/api";
import {readInternalAuth} from "@outlinedb/shared/node";
import {Command, Flags} from "@oclif/core";
import {createDatabase} from "../../db/index.js";
import {defaultStoreDir, mirrorFiles} from "../../services/files-mirror.js";
import type {FileUrlSigner} from "../../services/files-mirror.js";

/** Signs `/file-proxy/signed-original/<ownerId>/<nodeId>/` with the internal session, as the web server's files route does. */
function sessionSigner(client: WorkflowyInternalClient): FileUrlSigner {
	let ownerId: Promise<number> | undefined;
	return {
		async signedOriginalUrl(nodeId) {
			ownerId ??= client.bootstrap().then((session) => session.ownerId);
			return client.signedFileUrl(`/file-proxy/signed-original/${await ownerId}/${nodeId}/?attempt=1`);
		},
	};
}

export default class FilesMirror extends Command {
	static override description =
		"Download attachment bytes (photos, PDFs, videos) out of Workflowy into a local content-addressed store, recording each in file_blobs. Resumable: attachments already on disk are skipped and failures are retried on the next run.";

	static override examples = [
		"<%= config.bin %> files mirror --dry-run",
		"<%= config.bin %> files mirror --limit 3",
		"<%= config.bin %> files mirror --dir /Volumes/archive/workflowy-files --concurrency 4",
	];

	static override flags = {
		dir: Flags.string({
			description: "Store directory (default: OUTLINEDB_FILES_DIR, else files-mirror/ beside the cache database)",
		}),
		limit: Flags.integer({description: "Download at most this many attachments not yet mirrored", min: 1}),
		concurrency: Flags.integer({description: "Downloads in flight at once", default: 3, min: 1, max: 16}),
		"dry-run": Flags.boolean({
			char: "d",
			description: "Show what would be downloaded without fetching",
			default: false,
		}),
	};

	public async run(): Promise<void> {
		const {flags} = await this.parse(FilesMirror);
		const storeDir = flags.dir ?? defaultStoreDir(process.env, process.cwd());
		const database = createDatabase();

		let signer: FileUrlSigner | undefined;
		if (!flags["dry-run"]) {
			const auth = readInternalAuth();
			if (!auth) {
				this.error(
					"No internal session: run 'internal login' or set WORKFLOWY_USERNAME and WORKFLOWY_PASSWORD.",
				);
			}
			signer = sessionSigner(new WorkflowyInternalClient(auth));
		}

		this.log(`Store: ${storeDir}`);
		const report = await mirrorFiles({
			database,
			signer,
			fetch: async (input, init) => fetch(input, init),
			storeDir,
			limit: flags.limit,
			dryRun: flags["dry-run"],
			concurrency: flags.concurrency,
			onProgress: (line) => {
				this.log(line);
			},
		});

		const prefix = flags["dry-run"] ? "[DRY RUN] would download" : "Downloaded";
		this.log(
			`${report.live} live attachments, ${report.alreadyMirrored} already mirrored, ${report.selected} selected. ${prefix} ${flags["dry-run"] ? report.selected : report.downloaded}${flags["dry-run"] ? "." : ` (${report.bytes.toLocaleString()} bytes), ${report.failed} failed.`}`,
		);
		if (report.failed > 0) {
			process.exitCode = 1;
		}
	}
}
