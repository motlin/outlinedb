/**
 * Decision pages: a review agent stages a list of questions as `<slug>.json`,
 * the user answers them in the browser, and the agent reads `<slug>.answers.json`
 * back. The page only records choices; every Workflowy write stays with the agent.
 *
 * Host-neutral: the files live behind a {@link DecisionStore} the host supplies.
 */

import {z} from "zod";

export const DECISION_SLUG = /^[a-z0-9-]+$/u;

/** Where staged documents and their answers are kept, as raw JSON text keyed by slug. */
export interface DecisionStore {
	/** The staged `<slug>.json` text, or null when nothing is staged. */
	readDocument(slug: string): Promise<string | null>;
	/** The `<slug>.answers.json` text, or null before the first answer. */
	readAnswers(slug: string): Promise<string | null>;
	/** Replace `<slug>.answers.json` atomically. */
	writeAnswers(slug: string, text: string): Promise<void>;
	/**
	 * The bytes of an item image by its `src`, or null when the path is missing or
	 * is not a {@link decisionImageType} image inside the host's photos directory.
	 */
	readImage(src: string): Promise<Uint8Array<ArrayBuffer> | null>;
}

const IMAGE_TYPES: Record<string, string> = {
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	png: "image/png",
	webp: "image/webp",
	gif: "image/gif",
};

/**
 * The content type of an image `src`, or null unless it is a relative path with
 * an image extension and no empty, `.` or `..` segment that could leave the photos directory.
 */
export function decisionImageType(src: string): string | null {
	if (src.includes("\\") || src.includes("\0")) {
		return null;
	}
	if (src.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
		return null;
	}
	const extension = /\.([^./]+)$/u.exec(src)?.[1]?.toLowerCase();
	return extension === undefined ? null : (IMAGE_TYPES[extension] ?? null);
}

const LinkSchema = z.strictObject({label: z.string(), href: z.string()});

const ImageSchema = z.strictObject({
	src: z
		.string()
		.refine(
			(src) => decisionImageType(src) !== null,
			"Image src must be a relative .jpg, .jpeg, .png, .webp or .gif path under .llm/photos",
		),
	alt: z.string(),
});

const OptionSchema = z.strictObject({
	value: z.string().min(1),
	label: z.string(),
	description: z.string().optional(),
});

const ItemSchema = z.strictObject({
	// `submittedAt` shares the answers file's top level, so no item may take that name.
	id: z
		.string()
		.min(1)
		.refine((id) => id !== "submittedAt", "submittedAt is reserved"),
	title: z.string(),
	body: z.array(z.string()).default([]),
	links: z.array(LinkSchema).default([]),
	/** Photos shown above the body; `src` is relative to the host's photos directory (`.llm/photos`). */
	images: z.array(ImageSchema).optional(),
	options: z.array(OptionSchema).min(1),
	default: z.string().nullable().default(null),
});

const GroupSchema = z.strictObject({
	heading: z.string(),
	link: z.string().optional(),
	items: z.array(ItemSchema),
});

const DecisionDocumentSchema = z.strictObject({
	slug: z.string(),
	title: z.string(),
	intro: z.string().optional(),
	groups: z.array(GroupSchema),
});

export type DecisionDocument = z.infer<typeof DecisionDocumentSchema>;
export type DecisionItem = z.infer<typeof ItemSchema>;

const DecisionAnswerSchema = z.strictObject({
	choice: z.string().nullable(),
	note: z.string(),
	answeredAt: z.string(),
});

export type DecisionAnswer = z.infer<typeof DecisionAnswerSchema>;

/** The body of `PUT /api/v1/decisions/:slug/:itemId`. */
export const DecisionAnswerInputSchema = DecisionAnswerSchema.omit({answeredAt: true});

const AnswersFileSchema = z.object({submittedAt: z.string().optional()}).catchall(DecisionAnswerSchema);

export interface DecisionAnswers {
	answers: Record<string, DecisionAnswer>;
	submittedAt: string | null;
}

/** What `GET /api/v1/decisions/:slug` answers: the staged document with each item's saved answer. */
export interface DecisionPage extends Omit<DecisionDocument, "groups"> {
	groups: (Omit<DecisionDocument["groups"][number], "items"> & {
		items: (DecisionItem & {answer: DecisionAnswer | null})[];
	})[];
	submittedAt: string | null;
}

/** A staged or saved file that cannot be used; the route answers 500 with its message. */
export class DecisionFileError extends Error {}

function parseJsonText(fileName: string, text: string): unknown {
	try {
		return JSON.parse(text);
	} catch (error) {
		throw new DecisionFileError(
			`${fileName} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

/** Parse and check a staged document, naming the file and the first problem in the error. */
export function parseDecisionDocument(slug: string, text: string): DecisionDocument {
	const fileName = `${slug}.json`;
	const result = DecisionDocumentSchema.safeParse(parseJsonText(fileName, text));
	if (!result.success) {
		throw new DecisionFileError(
			`${fileName} does not match the decision page shape: ${z.prettifyError(result.error)}`,
		);
	}
	const document = result.data;
	if (document.slug !== slug) {
		throw new DecisionFileError(`${fileName} declares slug "${document.slug}"`);
	}
	const seen = new Set<string>();
	for (const item of document.groups.flatMap((group) => group.items)) {
		if (seen.has(item.id)) {
			throw new DecisionFileError(`${fileName} repeats item id "${item.id}"`);
		}
		seen.add(item.id);
		if (item.default !== null && !item.options.some((option) => option.value === item.default)) {
			throw new DecisionFileError(
				`${fileName} item "${item.id}" defaults to "${item.default}", which is not one of its options`,
			);
		}
	}
	return document;
}

/** Parse the answers file; null text (no answers yet) is an empty set. */
export function parseDecisionAnswers(slug: string, text: string | null): DecisionAnswers {
	if (text === null) {
		return {answers: {}, submittedAt: null};
	}
	const fileName = `${slug}.answers.json`;
	const result = AnswersFileSchema.safeParse(parseJsonText(fileName, text));
	if (!result.success) {
		throw new DecisionFileError(`${fileName} does not match the answers shape: ${z.prettifyError(result.error)}`);
	}
	const {submittedAt, ...answers} = result.data;
	return {answers, submittedAt: submittedAt ?? null};
}

/** The answers file text: one entry per item, plus `submittedAt` once the user submits. */
export function serializeDecisionAnswers({answers, submittedAt}: DecisionAnswers): string {
	return `${JSON.stringify({...answers, ...(submittedAt === null ? {} : {submittedAt})}, null, 2)}\n`;
}

export function mergeDecisionPage(document: DecisionDocument, {answers, submittedAt}: DecisionAnswers): DecisionPage {
	return {
		...document,
		groups: document.groups.map((group) => ({
			...group,
			items: group.items.map((item) => ({...item, answer: answers[item.id] ?? null})),
		})),
		submittedAt,
	};
}
