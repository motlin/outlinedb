/**
 * The Node host's {@link DecisionStore}: `<slug>.json` and `<slug>.answers.json`
 * in one directory, the repo's `.llm/gtd/review/decisions` unless
 * `WORKFLOWY_DECISIONS_DIR` points elsewhere. Item images are read from the
 * repo's `.llm/photos` unless `WORKFLOWY_DECISION_PHOTOS_DIR` points elsewhere.
 */

import {randomUUID} from "node:crypto";
import {mkdir, readFile, realpath, rename, writeFile} from "node:fs/promises";
import {isAbsolute, join, relative, sep} from "node:path";
import {DECISION_SLUG, decisionImageType} from "./decisions.js";
import type {DecisionStore} from "./decisions.js";

/** src/server and dist/server both sit four levels below the repo root. */
const REPO_ROOT = join(import.meta.dirname, "../../../..");
const DEFAULT_DIRECTORY = join(REPO_ROOT, ".llm/gtd/review/decisions");
const DEFAULT_PHOTOS_DIRECTORY = join(REPO_ROOT, ".llm/photos");

export function decisionsDirectory(env: {WORKFLOWY_DECISIONS_DIR?: string | undefined}): string {
	return env.WORKFLOWY_DECISIONS_DIR ?? DEFAULT_DIRECTORY;
}

export function decisionPhotosDirectory(env: {WORKFLOWY_DECISION_PHOTOS_DIR?: string | undefined}): string {
	return env.WORKFLOWY_DECISION_PHOTOS_DIR ?? DEFAULT_PHOTOS_DIRECTORY;
}

/** `photosDirectory` undefined means the host serves no images. */
export function fileDecisionStore(directory: string, photosDirectory?: string): DecisionStore {
	const path = (slug: string, suffix: string): string => {
		if (!DECISION_SLUG.test(slug)) {
			throw new Error(`Decision slug must match [a-z0-9-]+, got "${slug}"`);
		}
		return join(directory, `${slug}${suffix}`);
	};
	return {
		readDocument: async (slug) => readIfPresent(path(slug, ".json"), "utf8"),
		readAnswers: async (slug) => readIfPresent(path(slug, ".answers.json"), "utf8"),
		writeAnswers: async (slug, text) => {
			const destination = path(slug, ".answers.json");
			await mkdir(directory, {recursive: true});
			const temporary = `${destination}.${randomUUID()}.tmp`;
			await writeFile(temporary, text);
			await rename(temporary, destination);
		},
		readImage: async (src) => {
			if (photosDirectory === undefined || decisionImageType(src) === null) {
				return null;
			}
			const file = await realIfPresent(join(photosDirectory, src));
			const root = await realIfPresent(photosDirectory);
			// Resolving symlinks first means a link inside the directory cannot reach a file outside it.
			if (file === null || root === null || !isInside(root, file)) {
				return null;
			}
			return readIfPresent(file);
		},
	};
}

function isInside(root: string, file: string): boolean {
	const path = relative(root, file);
	return path !== "" && !isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`);
}

function isMissing(error: unknown): boolean {
	return (
		error instanceof Error &&
		"code" in error &&
		(error.code === "ENOENT" || error.code === "ENOTDIR" || error.code === "EISDIR")
	);
}

async function realIfPresent(file: string): Promise<string | null> {
	try {
		return await realpath(file);
	} catch (error) {
		if (isMissing(error)) {
			return null;
		}
		throw error;
	}
}

async function readIfPresent(file: string): Promise<Uint8Array<ArrayBuffer> | null>;
async function readIfPresent(file: string, encoding: "utf8"): Promise<string | null>;
async function readIfPresent(file: string, encoding?: "utf8"): Promise<string | Uint8Array<ArrayBuffer> | null> {
	try {
		return encoding === undefined ? new Uint8Array(await readFile(file)) : await readFile(file, encoding);
	} catch (error) {
		if (isMissing(error)) {
			return null;
		}
		throw error;
	}
}
