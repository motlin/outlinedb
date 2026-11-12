import {useCallback, useEffect, useRef, useState} from "react";
import type {KeyboardEvent, ReactNode} from "react";
import {formatPillLabel} from "@outlinedb/shared";
import {dateFormatOptions, timeFormatOptions, weekStartPatch} from "../date-settings.js";
import type {FormatOption} from "../date-settings.js";
import {useFeatureOn, useFeatures} from "../hooks/use-features.js";
import {usePreferences} from "../hooks/use-preferences.js";
import type {Preferences, PreferencesPatch} from "../hooks/use-preferences.js";
import {currentVersionLabel} from "../app-version.js";
import {authClient} from "../auth/auth-client.js";
import {useAuthConfig} from "../auth/auth-config.js";
import {useFlash} from "../hooks/use-flash.js";
import {EMOJI_OPTIONS, applyEmoji, storedEmoji} from "../emoji-apply.js";
import {FONT_OPTIONS, applyFont} from "../font-apply.js";
import {allThemes, currentTheme} from "../themes.js";
import {useCustomThemesStore} from "../stores/custom-themes.js";
import {useOutlineStore} from "../stores/outline.js";
import {DialogCloseButton, DialogShell} from "./dialog-shell.js";
import {Dropdown, DropdownOption} from "./flyout/dropdown.js";
import {ActionBlock, ControlRow, ReadOnlyField, SectionBody, SettingsButton} from "./settings-rows.js";
import {SettingsSection, SettingsSectionRegistry} from "./settings-section.js";
import {Toggle} from "./toggle.js";

const MOMENT_FORMAT_DOCS = "https://momentjscom.readthedocs.io/en/latest/moment/04-displaying/01-format/";

/** The options, plus the current value rendered in itself when it is a custom format. */
function withCurrent(options: FormatOption[], current: string, label: () => string): FormatOption[]
{
	return options.some((option) => option.value === current)
		? options
		: [
				{
					value: current,
					label: label(),
				},
				...options,
			];
}

interface CustomFormatInputProps
{
	ariaLabel: string;
	className: string;
	disabled: boolean;
	id: string;
	value: string;
	onSave: (value: string) => void;
}

/** A text field holding a draft that is saved on blur or Enter, only when it changed. Key it by `value` to reset the draft. */
function CustomFormatInput({ariaLabel, className, disabled, id, value, onSave}: CustomFormatInputProps)
{
	const [draft, setDraft] = useState(value);
	const save = () =>
	{
		const next = draft.trim();
		if (next !== "" && next !== value)
		{
			onSave(next);
		}
	};
	return (
		<input
			aria-label={ariaLabel}
			className={`settings-input ${className}`}
			disabled={disabled}
			id={id}
			onBlur={save}
			onChange={(event) =>
			{
				setDraft(event.target.value);
			}}
			onKeyDown={(event: KeyboardEvent<HTMLInputElement>) =>
			{
				if (event.key === "Enter")
				{
					save();
				}
			}}
			type="text"
			value={draft}
		/>
	);
}

/**
 * Settings > Dates: date format, time format, start of week and custom formats,
 * stored in the account's root metadata through `/api/v1/preferences`.
 */
export function DatesSection({now: nowProp}: {now?: Date})
{
	const [openedAt] = useState(() => new Date());
	const now = nowProp ?? openedAt;
	const {available, error, dateSettings, setPreferences} = usePreferences();
	const {dateFormat, timeFormat, weekStartDay} = dateSettings;
	const disabled = !available;
	const change = (patch: PreferencesPatch) =>
	{
		setPreferences(patch).catch(() => {});
	};
	const today =
	{
		startYear: now.getFullYear(),
		startMonth: now.getMonth() + 1,
		startDay: now.getDate(),
	};
	const dateOptions = withCurrent(dateFormatOptions(now), dateFormat, () =>
		formatPillLabel(
			today,
			{
				dateFormat,
				now,
			},
		),
	);
	const timeOptions = withCurrent(timeFormatOptions(now), timeFormat, () => timeFormat);

	return (
		<div className="flex flex-col gap-xl" id="settings-dates">
			{error !== null && (
				<div className="settings-row">
					<span className="settings-info">{error}</span>
				</div>
			)}
			<div className="settings-row">
				<label className="settings-label" htmlFor="settings-date-format">
					Date format
				</label>
				<select
					className="settings-select"
					disabled={disabled}
					id="settings-date-format"
					onChange={(event) =>
					{
						change(
							{
								dateFormat: event.target.value,
							},
						);
					}}
					value={dateFormat}
				>
					{dateOptions.map((option) => (
						<option key={option.value} value={option.value}>
							{option.label}
						</option>
					))}
				</select>
			</div>
			<div className="settings-row">
				<label className="settings-label" htmlFor="settings-time-format">
					Time format
				</label>
				<select
					className="settings-select"
					disabled={disabled}
					id="settings-time-format"
					onChange={(event) =>
					{
						change(
							{
								timeFormat: event.target.value,
							},
						);
					}}
					value={timeFormat}
				>
					{timeOptions.map((option) => (
						<option key={option.value} value={option.value}>
							{option.label}
						</option>
					))}
				</select>
			</div>
			<div className="settings-row">
				<label className="settings-label" htmlFor="settings-week-start">
					Start of week
				</label>
				<select
					className="settings-select"
					disabled={disabled}
					id="settings-week-start"
					onChange={(event) =>
					{
						change(weekStartPatch(event.target.value === "1" ? 1 : 0));
					}}
					value={String(weekStartDay === 1 ? 1 : 0)}
				>
					<option value="0">Sunday</option>
					<option value="1">Monday</option>
				</select>
			</div>
			<div className="settings-row">
				<label className="settings-label" htmlFor="settings-custom-date-format">
					Custom date format
				</label>
				<div className="settings-custom-format">
					<CustomFormatInput
						ariaLabel="Custom date format"
						className="w-[200px]"
						disabled={disabled}
						id="settings-custom-date-format"
						key={dateFormat}
						onSave={(value) =>
						{
							change(
								{
									dateFormat: value,
								},
							);
						}}
						value={dateFormat}
					/>
					<CustomFormatInput
						ariaLabel="Custom time format"
						id="settings-custom-time-format"
						key={timeFormat}
						className="w-[120px]"
						disabled={disabled}
						onSave={(value) =>
						{
							change(
								{
									timeFormat: value,
								},
							);
						}}
						value={timeFormat}
					/>
					<a href={MOMENT_FORMAT_DOCS} rel="noreferrer" target="_blank">
						Learn more
					</a>
				</div>
			</div>
		</div>
	);
}

/** Upstream's `Account`, `Personalization`, ... in order; the cloud-only sections are not cloned. */
const SETTINGS_SECTION_TITLES = [
	"Account",
	"Personalization",
	"Dates",
	"Media & Previews",
	"Backup",
	"Notifications",
	"Features",
] as const;

const DAILY_SUMMARY_HINT =
	"Note: enabling this option means all content you add to OutlineDB will be emailed to you. You'll receive a breakdown of the number of additions, edits, moves, completions, uncompletions and deletions made the previous day \u2013 both in private and shared lists. If collaborators in shared lists have made any changes, the summary will indicate who has done what.";

interface SectionProps
{
	preferences: Preferences;
	change: (patch: PreferencesPatch) => void;
}

/** Upstream manages MFA from its own Settings > Account; the local app only links there. */
const MANAGE_MFA_URL = "https://workflowy.com/";

/**
 * Upstream `De4` (`SettingsAccount` order 10): shown only when `settings.mfa` exists, labelled
 * "Manage MFA" or "Setup MFA" by `mfa.enabled`. Upstream's button opens the disable/recovery
 * dialog or the TOTP setup via `/api/mfa/*`; locally it is read-only and links to workflowy.com.
 */
function MfaBlock({mfa}: {mfa: Preferences["mfa"]})
{
	if (mfa === null)
	{
		return null;
	}
	return (
		<ActionBlock
			label="Multi-factor authentication"
			hint="Require a code from an authenticator app when you sign in."
		>
			<a
				href={MANAGE_MFA_URL}
				tabIndex={0}
				className=" hover:no-underline button"
				target="_blank"
				rel="noreferrer"
			>
				<span className="">{mfa.enabled ? "Manage MFA" : "Setup MFA"}</span>
			</a>
		</ActionBlock>
	);
}

/** Ends the OutlineDB session and goes to login. Only the hosted app has one; the Node host never signs in. */
function LogOutBlock()
{
	return (
		<ActionBlock label="Log out" hint="Sign out of OutlineDB in this browser.">
			<SettingsButton
				onClick={() =>
				{
					void authClient.signOut().finally(() =>
					{
						globalThis.location.assign("/login");
					});
				}}
			>
				Log out
			</SettingsButton>
		</ActionBlock>
	);
}

function AccountSection({preferences}: SectionProps)
{
	const {account} = preferences;
	const hosted = useAuthConfig().data?.hosted === true;
	if (account === null && !hosted)
	{
		return null;
	}
	return (
		<SettingsSection title="Account">
			<SectionBody>
				{account !== null && (
					<>
						<ReadOnlyField label="Name" value={account.username} />
						<ReadOnlyField label="Email" value={account.email} />
						<MfaBlock mfa={preferences.mfa} />
					</>
				)}
				{hosted && <LogOutBlock />}
			</SectionBody>
		</SettingsSection>
	);
}

function PersonalizationSection({preferences, change}: SectionProps)
{
	const theme = useOutlineStore((state) => state.theme);
	const setTheme = useOutlineStore((state) => state.setTheme);
	const customThemes = useCustomThemesStore((state) => state.themes);
	const current = currentTheme(preferences.theme ?? theme);
	const emoji = preferences.emojiSelected ?? storedEmoji();
	const font = preferences.font ?? "system";
	return (
		<SettingsSection title="Personalization">
			<SectionBody>
				<ControlRow label="Theme">
					<Dropdown large>
						{allThemes(customThemes).map((option) => (
							<DropdownOption
								key={option.name}
								label={option.prettyName}
								isSelected={current === option.name}
								onSelect={() =>
								{
									change(
										{
											theme: option.name,
										},
									);
									setTheme(option.name);
								}}
							/>
						))}
					</Dropdown>
				</ControlRow>
				<ControlRow label="Font">
					<Dropdown large className="dropdownFont">
						{FONT_OPTIONS.map(([name, label]) => (
							<DropdownOption
								key={name}
								label={label}
								className={`fontOption ${name}`}
								isSelected={font === name}
								onSelect={() =>
								{
									change(
										{
											font: name,
										},
									);
									applyFont(name);
								}}
							/>
						))}
					</Dropdown>
				</ControlRow>
				<ControlRow label="Emojis" hint={"\u{1F973}\u{1F370}\u{1F41B}\u{1F60A}\u{1F451}\u{1F37B}"}>
					<Dropdown large>
						{EMOJI_OPTIONS.map(([name, label]) => (
							<DropdownOption
								key={name}
								label={label}
								isSelected={emoji === name}
								onSelect={() =>
								{
									change(
										{
											emojiSelected: name,
										},
									);
									applyEmoji(name);
								}}
							/>
						))}
					</Dropdown>
				</ControlRow>
			</SectionBody>
		</SettingsSection>
	);
}

function MediaSection({preferences, change}: SectionProps)
{
	const embeds = [
		["Embed YouTube videos", "ignoreYoutube"],
		["Embed YouTube Shorts", "ignoreYtShort"],
		["Embed Tweets", "ignoreTwitter"],
		["Embed Loom", "ignoreLoom"],
	] as const;
	return (
		<SettingsSection title="Media & Previews">
			<SectionBody>
				<ControlRow label="Image thumbnails size">
					<Dropdown large>
						<DropdownOption
							label="Small"
							isSelected={preferences.displayImagePreviewsAsThumbnails}
							onSelect={() =>
							{
								change(
									{
										displayImagePreviewsAsThumbnails: true,
									},
								);
							}}
						/>
						<DropdownOption
							label="Big"
							isSelected={!preferences.displayImagePreviewsAsThumbnails}
							onSelect={() =>
							{
								change(
									{
										displayImagePreviewsAsThumbnails: false,
									},
								);
							}}
						/>
					</Dropdown>
				</ControlRow>
				{embeds.map(([label, key]) => (
					<ControlRow key={key} label={label}>
						<Toggle
							on={!preferences[key]}
							onClick={() =>
							{
								change(
									{
										[key]: !preferences[key],
									},
								);
							}}
						/>
					</ControlRow>
				))}
			</SectionBody>
		</SettingsSection>
	);
}

/** Upstream's Dropbox connect page; it links the account's Dropbox and returns to workflowy.com. */
const AUTHORIZE_DROPBOX_URL = "https://workflowy.com/authorize_dropbox";
const RESTORE_FROM_BACKUP_URL = "https://workflowy.com/accounts/restore_from_backup";

/**
 * Upstream `w60`: Dropbox Auto-backup ("Turn off" while `backup_to_dropbox` is on, otherwise
 * "Set up Dropbox backup", which sets the flag and opens the authorize page) and Restore Backup.
 * Upstream hides it for non-Pro accounts; the local app has no plan state, so it always shows.
 */
function BackupSection({preferences, change}: SectionProps)
{
	const on = preferences.backupToDropbox;
	return (
		<SettingsSection title="Backup">
			<SectionBody>
				<ActionBlock
					label="Dropbox Auto-backup"
					hint="Automatically back up your workflowy.com account to Dropbox every day."
				>
					<SettingsButton
						onClick={() =>
						{
							change(
								{
									backupToDropbox: !on,
								},
							);
							if (!on)
							{
								window.open(AUTHORIZE_DROPBOX_URL, "_blank");
							}
						}}
					>
						{on ? "Turn off" : "Set up Dropbox backup"}
					</SettingsButton>
				</ActionBlock>
				<ActionBlock label="Restore Backup" hint="Recover your account from a Dropbox backup.">
					<a
						href={RESTORE_FROM_BACKUP_URL}
						tabIndex={0}
						className=" hover:no-underline button"
						target="_blank"
						rel="noreferrer"
					>
						<span className="">Restore from a Dropbox backup</span>
					</a>
				</ActionBlock>
			</SectionBody>
		</SettingsSection>
	);
}

function NotificationsSection({preferences, change}: SectionProps)
{
	return (
		<SettingsSection title="Notifications">
			<SectionBody>
				<ControlRow label="Show weekly report">
					<Toggle
						on={preferences.weeklyReportOn}
						onClick={() =>
						{
							change(
								{
									weeklyReportOn: !preferences.weeklyReportOn,
								},
							);
						}}
					/>
				</ControlRow>
				<ControlRow label="Daily change email summary" hint={DAILY_SUMMARY_HINT}>
					<Toggle
						on={!preferences.unsubscribeFromSummaryEmails}
						onClick={() =>
						{
							change(
								{
									unsubscribeFromSummaryEmails: !preferences.unsubscribeFromSummaryEmails,
								},
							);
						}}
					/>
				</ControlRow>
			</SectionBody>
		</SettingsSection>
	);
}

function FeaturesSection()
{
	const showKeyboardShortcuts = useOutlineStore((state) => state.showKeyboardShortcuts);
	const setShowKeyboardShortcuts = useOutlineStore((state) => state.setShowKeyboardShortcuts);
	const {visible, enabled, setFeature} = useFeatures();
	return (
		<SettingsSection title="Features">
			<SectionBody>
				<ControlRow label="Keyboard shortcuts helper">
					<Toggle
						className="showKeyboardShortcuts"
						on={showKeyboardShortcuts}
						onClick={() =>
						{
							setShowKeyboardShortcuts(!showKeyboardShortcuts);
						}}
					/>
				</ControlRow>
				{visible.map(({codename, name, label, description}) =>
				{
					const on = enabled[codename] === true;
					return (
						<ControlRow
							key={codename}
							label={name}
							badge={label === "LABS" || label === "DEV" ? label : undefined}
							hint={description === null || description === "" ? undefined : description}
						>
							<Toggle
								className={codename}
								on={on}
								onClick={() =>
								{
									void setFeature(codename, !on).catch(() => {});
								}}
							/>
						</ControlRow>
					);
				})}
			</SectionBody>
		</SettingsSection>
	);
}

/** Upstream `ll4`: the version and browser tags, copied on click, with a 2s "copied!" flash. */
function SettingsVersion({label = currentVersionLabel()}: {label?: string})
{
	const [flashing, flash] = useFlash(2000);
	const copy = async () =>
	{
		try
		{
			await navigator.clipboard.writeText(label);
			flash();
		}
		catch
		{
			// Clipboard access can be denied; nothing was copied.
		}
	};
	return (
		// oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- verbatim upstream markup: a plain div
		<div
			className="inline-block text-xs space-x-2xs"
			onClick={() =>
			{
				void copy();
			}}
		>
			<span className={`text-tertiary p-2xs ${flashing ? "" : "cursor-pointer"}`}>{label}</span>
			{flashing ? <span className="text-success">copied!</span> : null}
		</div>
	);
}

/** Scroll `title`'s section to the top of the dialog box without highlighting it. */
function jumpTo(root: HTMLElement | null, title: string): void
{
	const box = root?.closest<HTMLElement>(".dialog-box");
	const section = findSection(root, title);
	if (box && section)
	{
		box.scrollTop += section.getBoundingClientRect().top - box.getBoundingClientRect().top - box.clientTop;
	}
}

function findSection(root: HTMLElement | null, title: string): HTMLElement | undefined
{
	const sections = root?.querySelectorAll<HTMLElement>("[data-section-title]") ?? [];
	return [...sections].find((section) => section.dataset.sectionTitle === title);
}

interface SettingsHeaderProps
{
	titles: readonly string[];
	jump: string;
	onJump: (title: string) => void;
	onClose: () => void;
}

function SettingsHeader({titles, jump, onJump, onClose}: SettingsHeaderProps)
{
	return (
		<div className="-mx-xl mb-l box-border w-[calc(100%+3rem)] bg-primary px-xl mobile:pb-l">
			<div className="flex items-center gap-xl">
				<div className="flex min-w-0 flex-1 flex-col gap-2xs">
					<h1
						className="title text-l leading-xs font-bold whitespace-nowrap overflow-hidden text-ellipsis mr-3xl"
						style={
						{
							marginRight: 0,
						}}
					>
						Settings
					</h1>
					<SettingsVersion />
				</div>
				{titles.length > 0 && (
					<div className="shrink-0">
						<Dropdown maxHeight={360}>
							<DropdownOption
								label="Jump to"
								disabled
								isSelected={jump === ""}
								className="!cursor-default"
							/>
							{titles.map((title) => (
								<DropdownOption
									key={title}
									label={title}
									isSelected={jump === title}
									onSelect={() =>
									{
										onJump(title);
									}}
								/>
							))}
						</Dropdown>
					</div>
				)}
				<DialogCloseButton inline onClose={onClose} />
			</div>
		</div>
	);
}

/** Registered titles in the order of `SETTINGS_SECTION_TITLES`, so a section that mounts late keeps its place. */
function orderedTitles(titles: readonly string[]): string[]
{
	const order: readonly string[] = SETTINGS_SECTION_TITLES;
	return titles.toSorted((a, b) => order.indexOf(a) - order.indexOf(b));
}

function SettingsBody({initialSection, onClose}: {initialSection: string | null; onClose: () => void})
{
	const {preferences, setPreferences} = usePreferences();
	const datesOn = useFeatureOn("dates");
	const rootRef = useRef<HTMLDivElement>(null);
	const [titles, setTitles] = useState<string[]>([]);
	const [jump, setJump] = useState(initialSection ?? "");
	const change = (patch: PreferencesPatch) =>
	{
		setPreferences(patch).catch(() => {});
	};
	const register = useCallback((title: string) =>
	{
		setTitles((current) => [...current, title]);
		return () =>
		{
			setTitles((current) => current.filter((existing) => existing !== title));
		};
	}, []);

	useEffect(() =>
	{
		if (initialSection === null)
		{
			return () =>
			{
			};
		}
		const timer = window.setTimeout(() =>
		{
			const section = findSection(rootRef.current, initialSection);
			if (section)
			{
				section.scrollIntoView(
					{
						block: "center",
						inline: "nearest",
					},
				);
				section.dataset.sectionHighlight = "true";
			}
		}, 300);
		return () =>
		{
			window.clearTimeout(timer);
		};
	}, [initialSection]);

	const sectionProps: SectionProps =
	{
		preferences,
		change,
	};
	const sections: ReactNode[] = [
		<AccountSection key="Account" {...sectionProps} />,
		<PersonalizationSection key="Personalization" {...sectionProps} />,
		// Upstream renders the Dates section only while the `dates` flag is on.
		datesOn && (
			<SettingsSection key="Dates" title="Dates">
				<DatesSection />
			</SettingsSection>
		),
		<MediaSection key="Media & Previews" {...sectionProps} />,
		<BackupSection key="Backup" {...sectionProps} />,
		<NotificationsSection key="Notifications" {...sectionProps} />,
		<FeaturesSection key="Features" />,
	];
	return (
		<SettingsSectionRegistry value={register}>
			<div ref={rootRef} className="contents">
				<SettingsHeader
					titles={orderedTitles(titles)}
					jump={jump}
					onJump={(title) =>
					{
						setJump(title);
						jumpTo(rootRef.current, title);
					}}
					onClose={onClose}
				/>
				<div className="flex flex-col gap-3xl">{sections}</div>
			</div>
		</SettingsSectionRegistry>
	);
}

/** Upstream's Settings dialog, opened from the main menu and the date format gears. */
export function Settings()
{
	const settingsOpen = useOutlineStore((state) => state.settingsOpen);
	const closeSettings = useOutlineStore((state) => state.closeSettings);
	const settingsSection = useOutlineStore((state) => state.settingsSection);
	if (!settingsOpen)
	{
		return null;
	}
	return (
		<DialogShell onClose={closeSettings}>
			<SettingsBody initialSection={settingsSection} onClose={closeSettings} />
		</DialogShell>
	);
}
