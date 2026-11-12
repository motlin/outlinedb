import {useQuery, useQueryClient} from "@tanstack/react-query";
import type {QueryClient} from "@tanstack/react-query";
import {useCallback, useEffect, useRef, useState} from "react";
import {filterBySearch} from "../export-entry.js";
import {cachedAncestorLayouts} from "../layouts-cache.js";
import type {ExportRequest} from "../export-entry.js";
import
{
	EXPORT_DEFAULT,
	EXPORT_FORMATS,
	EXPORT_OPTIONS,
	exportFileName,
	generateExport,
	preparingLabel,
	toExportItems,
	usesIframeCopy,
} from "../export-format.js";
import type {AccountResponse, ExportTreeResponse} from "../../node-types.js";
import type {ExportFormatType, ExportItem} from "../export-format.js";
import {currentSearchFilter} from "../hooks/use-tree-search.js";
import {readJson} from "../read-json.js";
import {activeZoomedId, useOutlineStore} from "../stores/outline.js";
import {DialogCloseButton, DialogShell, DialogTitle} from "./dialog-shell.js";

const STORAGE_KEY = "export.format.last";

const TAB_CLASS =
	"flex-1 py-s px-s text-s border border-primary border-solid rounded-none first:rounded-l-md last:rounded-r-md -ml-px first:ml-0 text-primary hover:!bg-secondary";

const PREVIEW_CLASS =
	"_theme-default bg-primary border border-solid border-primary h-[50vh] max-h-[468px] w-full box-border rounded";

const PLACEHOLDER_CLASS =
	"_theme-default bg-primary border border-solid border-primary h-[50vh] max-h-[468px] p-m w-full box-border rounded flex items-center justify-center text-secondary text-s";

function isFormat(value: string | null): value is ExportFormatType
{
	return EXPORT_FORMATS.some((format) => format === value);
}

/** The remembered tab, else upstream's default, else the first tab when storage throws. */
function initialFormat(): ExportFormatType
{
	try
	{
		const stored = localStorage.getItem(STORAGE_KEY);
		return isFormat(stored) ? stored : EXPORT_DEFAULT;
	}
	catch
	{
		return EXPORT_FORMATS[0] ?? EXPORT_DEFAULT;
	}
}

function rememberFormat(format: ExportFormatType): void
{
	try
	{
		localStorage.setItem(STORAGE_KEY, format);
	}
	catch
	{
		// Storage is only a convenience.
	}
}

/** The roots and everything below them, as the formatters take them, with completed and search visibility applied. */
async function fetchExportItems(queryClient: QueryClient, request: ExportRequest): Promise<ExportItem[]>
{
	const search = request.ignoreSearch ? null : currentSearchFilter(queryClient);
	const showCompleted = useOutlineStore.getState().showCompleted || search?.result.revealsCompleted === true;
	const response = await fetch(
		"/api/v1/nodes/export-tree",
		{
			method: "POST",
			headers:
			{
				"Content-Type": "application/json",
			},
			body: JSON.stringify(
				{
					ids: request.nodeIds,
					includeCompleted: showCompleted,
				},
			),
		},
	);
	if (!response.ok)
	{
		throw new Error("Failed to load export.");
	}
	const {items} = await readJson<ExportTreeResponse>(response);
	const visible =
		search === null
			? items
			: filterBySearch(
					items,
					(id, parentId) =>
						search.matchIds.has(id) ||
						search.ancestorIds.has(id) ||
						search.createdIds.has(id) ||
						(parentId !== null && search.expansion.get(parentId) === true),
				);
	const roots = toExportItems(visible);
	for (const root of roots)
	{
		root.aboveLayouts = cachedAncestorLayouts(queryClient, root.id).layouts.map((layout) => layout.layoutMode);
	}
	return roots;
}

async function fetchOwnerEmail(): Promise<string>
{
	const response = await fetch("/api/v1/account");
	if (!response.ok)
	{
		return "";
	}
	const {email} = await readJson<AccountResponse>(response);
	return email;
}

interface Generated
{
	blob: Blob;
	url: string;
}

/** One generation: what it formats, how far along it is, and the finished blob once there is one. */
interface Run
{
	format: ExportFormatType;
	items: ExportItem[];
	bytes: number;
	generated: Generated | null;
}

/** Copies Formatted by selecting the preview iframe's body, as upstream does on Android. */
function copyIframeSelection(iframe: HTMLIFrameElement | null): void
{
	const body = iframe?.contentDocument?.body;
	const selection = iframe?.contentWindow?.getSelection();
	if (body === undefined || selection === undefined || selection === null)
	{
		throw new Error("Export preview is unavailable.");
	}
	selection.selectAllChildren(body);
	// oxlint-disable-next-line typescript/no-deprecated -- upstream copies the iframe's selection this way; no async clipboard path covers it
	const copiedOk = iframe?.contentDocument?.execCommand("copy") === true;
	selection.removeAllRanges();
	if (!copiedOk)
	{
		throw new Error("Copy command failed.");
	}
}

async function copyBlob(blob: Blob): Promise<void>
{
	await navigator.clipboard.write([
		new ClipboardItem(
			{
				[blob.type]: blob,
			},
		),
	]);
}

function ExportDialogBody({request, onClose}: {request: ExportRequest; onClose: () => void})
{
	const queryClient = useQueryClient();
	const showAppMessage = useOutlineStore((state) => state.showAppMessage);
	const [format, setFormat] = useState<ExportFormatType>(initialFormat);
	const [run, setRun] = useState<Run | null>(null);
	const [downloading, setDownloading] = useState(false);
	const [copied, setCopied] = useState(false);
	const iframeRef = useRef<HTMLIFrameElement>(null);

	// Upstream's closeOnNav: zooming elsewhere closes the dialog.
	const zoomedId = useOutlineStore(activeZoomedId);
	const [openedAt] = useState(zoomedId);
	useEffect(() =>
	{
		if (zoomedId !== openedAt)
		{
			onClose();
		}
	}, [zoomedId, openedAt, onClose]);

	useEffect(() =>
	{
		rememberFormat(format);
	}, [format]);

	const {data: items} = useQuery(
		{
			queryKey: ["export-tree", request.nodeIds, request.ignoreSearch],
			queryFn: async () => fetchExportItems(queryClient, request),
			staleTime: 0,
			gcTime: 0,
		},
	);
	const {data: ownerEmail} = useQuery(
		{
			queryKey: ["export-owner-email"],
			queryFn: fetchOwnerEmail,
			staleTime: Infinity,
			retry: false,
		},
	);

	// Each tab switch aborts the previous run; a run that is not for the current tab and items counts as no run.
	useEffect(() =>
	{
		if (items === undefined || ownerEmail === undefined)
		{
			return () =>
			{
			};
		}
		const controller = new AbortController();
		let url: string | null = null;
		void generateExport(
			format,
			items,
			ownerEmail,
			controller.signal,
			(bytes) =>
			{
				setRun(
					{
						format,
						items,
						bytes,
						generated: null,
					},
				);
			},
			navigator.userAgent,
		)
			.then((blob) =>
			{
				const preview = new Blob(
					[blob],
					{
						type: `${blob.type};charset=utf-8`,
					},
				);
				url = URL.createObjectURL(preview);
				setRun(
					{
						format,
						items,
						bytes: blob.size,
						generated:
						{
							blob,
							url,
						},
					},
				);
				return url;
			})
			.catch(() => null);
		return () =>
		{
			controller.abort();
			if (url !== null)
			{
				URL.revokeObjectURL(url);
			}
		};
	}, [items, ownerEmail, format]);
	const current = run?.format === format && run.items === items ? run : null;
	const generated = current?.generated ?? null;
	const generating = generated === null;
	const bytes = current?.bytes ?? 0;

	const download = useCallback(() =>
	{
		if (generated === null || items === undefined)
		{
			return;
		}
		setDownloading(true);
		try
		{
			const url = URL.createObjectURL(generated.blob);
			const anchor = document.createElement("a");
			anchor.href = url;
			anchor.download = exportFileName(items, EXPORT_OPTIONS[format].extension, new Date());
			anchor.style.display = "none";
			document.body.append(anchor);
			anchor.click();
			anchor.remove();
			setTimeout(() =>
			{
				URL.revokeObjectURL(url);
			}, 0);
		}
		catch
		{
			showAppMessage(
				"Failed to export file.",
				{
					type: "failure",
				},
			);
		}
		setDownloading(false);
	}, [format, generated, items, showAppMessage]);

	const copy = useCallback(async () =>
	{
		if (generated === null)
		{
			return;
		}
		try
		{
			if (usesIframeCopy(format, navigator.userAgent))
			{
				copyIframeSelection(iframeRef.current);
			}
			else
			{
				await copyBlob(generated.blob);
			}
			setCopied(true);
			setTimeout(() =>
			{
				setCopied(false);
			}, 2000);
		}
		catch
		{
			showAppMessage(
				"Failed to copy export.",
				{
					type: "failure",
				},
			);
		}
	}, [format, generated, showAppMessage]);

	// oxlint-disable-next-line typescript/no-unnecessary-condition -- navigator.clipboard is absent outside secure contexts
	const canCopy = typeof navigator.clipboard?.write === "function" && typeof ClipboardItem === "function";
	const busy = generating || downloading;
	const label = preparingLabel(generating, bytes);

	return (
		<>
			<DialogTitle>Export</DialogTitle>
			<div className="w-full mt-m flex flex-row items-center justify-around text-s leading-base mr-3xl [&_input]:mr-ml">
				{EXPORT_FORMATS.map((key) => (
					<button
						className={format === key ? TAB_CLASS : `${TAB_CLASS} !bg-primary`}
						key={key}
						onClick={() =>
						{
							setFormat(key);
						}}
						type="button"
					>
						{EXPORT_OPTIONS[key].label}
					</button>
				))}
			</div>
			{generated === null ? (
				<div className={PLACEHOLDER_CLASS}>{label}</div>
			) : (
				<iframe
					className={PREVIEW_CLASS}
					ref={iframeRef}
					sandbox={usesIframeCopy(format, navigator.userAgent) ? "allow-same-origin" : ""}
					src={generated.url}
					style={
					{
						colorScheme: "light",
					}}
					title="Export preview"
				/>
			)}
			<div className="flex flex-row gap-l items-center justify-center text-secondary text-xs leading-base mt-m mobile:items-stretch mobile:flex-col-reverse">
				<button
					className="tertiary min-w-[128px] large cursor-pointer disabled:cursor-default"
					disabled={busy}
					onClick={download}
					onMouseDown={(event) =>
					{
						event.preventDefault();
					}}
					type="button"
				>
					{downloading ? "Downloading..." : "Download"}
				</button>
				{canCopy && (
					<button
						className="primary large min-w-[128px] disabled:cursor-default"
						disabled={busy || copied}
						onClick={() =>
						{
							void copy();
						}}
						type="button"
					>
						{copied ? "Copied!" : "Copy"}
					</button>
				)}
			</div>
			<DialogCloseButton onClose={onClose} />
		</>
	);
}

export function ExportDialog()
{
	const open = useOutlineStore((state) => state.exportDialogOpen);
	const request = useOutlineStore((state) => state.exportContext);
	const closeExportDialog = useOutlineStore((state) => state.closeExportDialog);

	// The body outlives `open` for the shell's exit animation.
	const [shown, setShown] = useState(request);
	if (request !== null && request !== shown)
	{
		setShown(request);
	}

	if (shown === null)
	{
		return null;
	}
	return (
		<DialogShell onClose={closeExportDialog} open={open}>
			<ExportDialogBody onClose={closeExportDialog} request={shown} />
		</DialogShell>
	);
}
