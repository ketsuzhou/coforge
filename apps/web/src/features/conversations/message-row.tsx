import { memo, useCallback, useEffect, useRef, useState } from "react";
import {
  WeeklyReportMessageCard,
  type WeeklyReportMessageSuggestion,
} from "#src/features/records/weekly-report-message-card";
import { FileIcon as FileTypeIcon } from "@untitledui/file-icons";
import {
  Bookmark,
  BookmarkCheck,
  Code02,
  Copy01,
  CornerUpLeft,
  Download01,
  XClose,
} from "@untitledui/icons";
import { Modal as AriaModal, ModalOverlay as AriaModalOverlay } from "react-aria-components";

import { getReadableFileSize } from "#src/components/application/file-upload/file-upload-base";
import { Avatar } from "#src/components/base/avatar/avatar";
import { Button } from "#src/components/base/buttons/button";
import { Tooltip, TooltipTrigger } from "#src/components/base/tooltip/tooltip";
import { useAppToast } from "#src/components/ui/toast";
import { Skeleton } from "#src/components/ui/skeleton";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import {
  Dialog,
  DialogTrigger,
  Modal,
  ModalOverlay,
} from "#src/components/application/modals/modal";
import { AgentDisplayAvatar } from "#src/features/agents/agent-display-avatar";
import { AgentHoverCard } from "#src/features/agents/agent-hover-card";
import type { OpenAgentProfile } from "#src/features/agents/profile-panel/open-agent-profile";
import { useLiveAgentDisplay } from "#src/features/agents/workspace-agents-realtime";
import { AgentModelLabel } from "#src/features/agents/agent-model-label";
import { avatarInitial, avatarToneClassName } from "#src/lib/avatar-tone";
import { DELETED_AGENT_AVATAR_CLASS, DeletedAgentBadge } from "#src/features/agents/deleted-agent";
import { useBreakpoint } from "#src/hooks/use-breakpoint";
import { useCoarsePointer } from "#src/hooks/use-coarse-pointer";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { ActionCard, type ActionCardView } from "./action-card";
import { AttachmentPreview } from "./attachment-preview";
import { attachmentPreviewKind } from "./attachment-preview-kind";
import { useIsMessageSaved } from "./conversation-host";
import { CollapsibleMessageBody } from "./collapsible-message-body";
import type { ChipMention } from "./message-markdown";
import { formatSelectionQuote, selectionAffordancePlacement } from "./message-quote";
import { MessageReactionPicker, QUICK_REACTION_EMOJIS } from "./message-reaction-picker";
import type { ReactionSummary } from "./message-reactions";
import { ThreadPreview, ThreadSheetEntry, ThreadToolbarEntry } from "./thread-summary";
import {
  copyFragmentMarkdown,
  copyFragmentStyled,
  messagePlainText,
  selectionFragmentHtml,
} from "./selection-copy";
import { copyText } from "#src/features/records/report-editor/lib/clipboard";
import { MessageTask } from "#src/features/tasks/message-task";
import { useTimeFormat } from "#src/lib/time-format-context";
import { useTimeZone } from "#src/lib/time-zone-context";
import { hour12For, type TimeFormat } from "#src/lib/time-format";
import { dateTimeFormat } from "#src/lib/dates";

export type MessageView = {
  id: string;
  sequence: number;
  threadRootId?: string;
  senderKind: "user" | "agent" | "system";
  senderMemberId?: string | null;
  /** What the reader sees: a display name, falling back to the handle (Slack's convention). */
  senderName: string;
  /** The handle behind that name, kept separate because a display name is not an identity.
   * Absent for a server-authored message. */
  senderHandle?: string;
  /** The sender's Agent id, present only when `senderKind === "agent"`; opens the Agent profile
   * panel (`features/agents/profile-panel/`) from the avatar or the sender name. */
  senderAgentId?: string;
  /** True when the sending Agent has since been deleted: the sender renders greyed
   * with a `DELETED` marker, and no longer opens that Agent's profile. */
  senderDeleted?: boolean;
  senderAvatarUrl?: string | null;
  body: string;
  createdAt: Date | string;
  /** Always present, possibly empty; order matches send/upload order. */
  attachments: {
    id: string;
    fileName: string;
    contentType: string;
    sizeBytes: number;
    /** Short-lived signed CDN URL for an inline image; see `attachmentView` on the server.
     * Preferred over `attachmentUrl` when present so `<img>` never round-trips the backend. */
    previewUrl?: string;
  }[];
  /** Resolved mention rows for the body's embedded `<@kind:uuid>` tokens; absent/empty for
   * DMs and pre-token history, which render as written (token-only highlight by design). */
  mentions?: {
    kind: "user" | "agent";
    actorId: string;
    handle: string;
    label: string;
  }[];
  reactions?: ReactionSummary[];
  /** Present when this message is the summary posted for an Agent-prepared action card.
   * Replaces the plain-text draft hint line with the interactive card; the
   * underlying `body` stays available to assistive technology. */
  actionCard?: ActionCardView;
  weeklyReportSuggestion?: WeeklyReportMessageSuggestion;
  weeklyReportDisplayBody?: string;
};

export const GROUPING_WINDOW_MS = 5 * 60 * 1000;

/** The vertical edges of the visible region a floating control must stay inside: the nearest
 * scrollport ancestor's box, or the viewport when the element is not inside a scroller. */
function visibleBoundary(el: HTMLElement): { top: number; bottom: number } {
  let node = el.parentElement;
  while (node) {
    const overflowY = getComputedStyle(node).overflowY;
    if (overflowY === "auto" || overflowY === "scroll") {
      const { top, bottom } = node.getBoundingClientRect();
      return { top, bottom };
    }
    node = node.parentElement;
  }
  return { top: 0, bottom: window.innerHeight };
}

/**
 * The day a message was sent on, in `timeZone` (`useTimeZone`; the host's when omitted). Without a
 * `locale` it is the UTC date.
 */
export function dayLabel(value: Date | string, locale?: string, timeZone?: string): string {
  if (!locale) return new Date(value).toISOString().slice(0, 10);
  return dateTimeFormat(locale, {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone,
  }).format(new Date(value));
}

/** The time of day a message was sent at, in `timeZone`; empty without a `locale`. */
export function clockLabel(
  value: Date | string,
  locale?: string,
  timeFormat: TimeFormat | null = null,
  timeZone?: string,
): string {
  if (!locale) return "";
  return dateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: hour12For(timeFormat),
    timeZone,
  }).format(new Date(value));
}

/**
 * The full date and time a message was sent at, down to the second, in `timeZone`; the same
 * shape as {@link clockLabel} so a caller passes the same four arguments. The row shows
 * `clockLabel` (hour and minute only), which hides the day; this is what its hover tooltip
 * reveals. Empty without a `locale`, matching `clockLabel`.
 */
export function fullLabel(
  value: Date | string,
  locale?: string,
  timeFormat: TimeFormat | null = null,
  timeZone?: string,
): string {
  if (!locale) return "";
  return dateTimeFormat(locale, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: hour12For(timeFormat),
    timeZone,
  }).format(new Date(value));
}

/** Whether two consecutive messages collapse into one visual group. */
export function groupsWithPrevious(
  message: MessageView,
  previous: MessageView | undefined,
  own: boolean,
  previousOwn: boolean,
  locale?: string,
  timeZone?: string,
) {
  if (!previous) return { dayChanged: true, grouped: false };
  const dayChanged =
    dayLabel(previous.createdAt, locale, timeZone) !==
    dayLabel(message.createdAt, locale, timeZone);
  const sameSender =
    !dayChanged &&
    previousOwn === own &&
    (previous.senderMemberId ?? previous.senderName) ===
      (message.senderMemberId ?? message.senderName);
  const grouped =
    sameSender &&
    Math.abs(new Date(message.createdAt).getTime() - new Date(previous.createdAt).getTime()) <=
      GROUPING_WINDOW_MS;
  return { dayChanged, grouped };
}

// The file-type icons the icon set ships, by extension.
const FILE_ICON_TYPES = new Set([
  "aep",
  "ai",
  "avi",
  "css",
  "csv",
  "dmg",
  "doc",
  "docx",
  "eps",
  "exe",
  "fig",
  "gif",
  "html",
  "indd",
  "java",
  "jpeg",
  "jpg",
  "js",
  "json",
  "mkv",
  "mp3",
  "mp4",
  "mpeg",
  "pdf",
  "png",
  "ppt",
  "pptx",
  "psd",
  "rar",
  "rss",
  "sql",
  "svg",
  "tiff",
  "txt",
  "wav",
  "webp",
  "xls",
  "xlsx",
  "xml",
  "zip",
]);

/** The icon-set type for a file: its extension when there is a dedicated icon, else its media kind. */
export function fileIconType(fileName: string, contentType: string) {
  const extension = fileName.includes(".") ? fileName.split(".").pop()!.toLowerCase() : "";
  if (FILE_ICON_TYPES.has(extension)) return extension;
  if (contentType.startsWith("image/")) return "image";
  if (contentType.startsWith("video/")) return "video";
  if (contentType.startsWith("audio/")) return "audio";
  if (contentType.startsWith("text/")) return "txt";
  return "empty";
}

/** The authenticated backend fallback: forced downloads, and inline images once their signed
 * CDN preview URL has expired or fails to load (the route then redirects to a fresh one, or
 * streams the bytes when CDN delivery is not configured). */
export function attachmentUrl(attachment: { id: string }) {
  return `/api/attachments/${attachment.id}`;
}

/**
 * The short kind shown before a file's size: its extension, or the media type when the name has no
 * usable one (`LICENSE`, `Dockerfile`, a dotfile) so such a file still says what it is rather than
 * showing a bare size. `application/octet-stream` is the upload default for "unknown", so it names
 * nothing, and a dotted phrase ("notes.final version") is not an extension.
 *
 * Not exported and not unit-tested: this is display text, and `docs/agents/testing.md` reserves UI
 * verification for a browser. The cases above are in this PR's verification Todo list instead.
 */
function attachmentTypeLabel(fileName: string, contentType: string): string | undefined {
  const dot = fileName.lastIndexOf(".");
  const suffix = dot > 0 ? fileName.slice(dot + 1) : "";
  // A long tail is part of the name rather than an extension ("notes.final version").
  if (suffix && suffix.length <= 8 && !suffix.includes(" ")) return suffix.toUpperCase();
  const subtype = contentType.split(";")[0]?.split("/")[1]?.trim() ?? "";
  const named = subtype.replace(/^(x-|vnd\.)/, "");
  if (!named || named === "octet-stream") return undefined;
  return named.slice(0, 12).toUpperCase();
}

/** An uploaded file on a message: images preview inline, other files show as a file card. */
export function AttachmentCard({ attachment }: { attachment: MessageView["attachments"][number] }) {
  const href = attachmentUrl(attachment);
  // Prefer the signed CDN preview URL so the image never round-trips the backend; fall back to
  // the authenticated proxy once (it expires after a fixed TTL, or may not be configured).
  const [previewFailed, setPreviewFailed] = useState(false);
  // Both sources failed (or the "image" is one the route will not serve inline, such as SVG —
  // it streams as octet-stream, which <img> refuses): drop to the plain file row below rather
  // than leaving a broken thumbnail behind.
  const [imgBroken, setImgBroken] = useState(false);
  const [imgLoaded, setImgLoaded] = useState(false);
  const previewSrc = !previewFailed && attachment.previewUrl ? attachment.previewUrl : href;
  const handlePreviewError = () => {
    setImgLoaded(false);
    if (previewFailed || !attachment.previewUrl) setImgBroken(true);
    else setPreviewFailed(true);
  };
  const downloadButton = (className?: string) => (
    <ButtonUtility
      icon={Download01}
      size="xs"
      color="secondary"
      tooltip={m.conversation_attachment_download()}
      href={`${href}?download`}
      className={cn("shrink-0", className)}
    />
  );
  /** Inside a file row the control is part of the row, so it stays visible. */
  const download = downloadButton();
  /** Separates the file from its actions. Both row variants carry it, so a previewable file and a
   * download-only one are the same shape. */
  const actionDivider = (
    <span className="mx-1 h-8 w-px shrink-0 bg-border-secondary" aria-hidden="true" />
  );
  /** One bordered row holding the file and its actions: an IM file row rather than a wide banner.
   * Bounded width so a long name cannot stretch the bubble, and the name truncates inside it. */
  const attachmentRowClassName =
    "group/attachment mt-1 flex w-full max-w-sm min-w-0 items-center rounded-xl bg-primary ring-1 ring-secondary ring-inset";
  if (attachment.contentType.startsWith("image/") && !imgBroken)
    return (
      <div className="relative mt-1 w-fit max-w-full">
        {/* Clicking the preview opens the image at full size in a lightbox. */}
        <DialogTrigger>
          <Button
            color="tertiary"
            noTextPadding
            aria-label={attachment.fileName}
            // The min footprint centers degenerate images (a 1×1 png, a still-loading one) inside
            // a card-sized box while the image loads.
            className="grid h-auto min-h-16 min-w-16 place-items-center overflow-hidden rounded-lg p-0 ring-1 ring-secondary ring-inset hover:bg-transparent"
          >
            {!imgLoaded && (
              <Skeleton className="pointer-events-none absolute inset-0 rounded-lg bg-secondary/70" />
            )}
            <img
              src={previewSrc}
              onError={handlePreviewError}
              onLoad={() => setImgLoaded(true)}
              alt={attachment.fileName}
              loading="lazy"
              className="block max-h-80 max-w-full object-contain"
            />
          </Button>
          <ModalOverlay isDismissable>
            {/* The lightbox fills the viewport: the action bar owns a top strip so it pins to the
                page's top-right corner and never overlaps the image, even for viewport-filling
                images; the image is centered in the remaining space below. */}
            <Modal className="h-full w-full max-w-full bg-transparent shadow-none">
              <Dialog aria-label={attachment.fileName} className="h-full">
                {({ close }) => {
                  // The modal covers the whole overlay, so backdrop dismissal is handled here:
                  // pressing a backdrop area itself (not the image or the actions) closes,
                  // matching ModalOverlay's dismiss behavior.
                  const dismissOnBackdrop = (event: React.PointerEvent) => {
                    if (event.target === event.currentTarget) close();
                  };
                  return (
                    <div className="flex h-full w-full flex-col">
                      <div
                        className="flex shrink-0 justify-end p-4"
                        onPointerDown={dismissOnBackdrop}
                      >
                        <div className="flex items-center gap-1 rounded-lg bg-primary/90 p-1 shadow-xs">
                          <ButtonUtility
                            icon={Download01}
                            size="sm"
                            color="tertiary"
                            tooltip={m.conversation_attachment_download()}
                            href={`${href}?download`}
                          />
                          <ButtonUtility
                            icon={XClose}
                            size="sm"
                            color="tertiary"
                            tooltip={m.controls_close()}
                            onClick={close}
                          />
                        </div>
                      </div>
                      <div
                        className="flex min-h-0 flex-1 items-center justify-center"
                        onPointerDown={dismissOnBackdrop}
                      >
                        <img
                          src={previewSrc}
                          onError={handlePreviewError}
                          alt={attachment.fileName}
                          className="block max-h-full max-w-[min(96vw,80rem)] rounded-lg object-contain"
                        />
                      </div>
                    </div>
                  );
                }}
              </Dialog>
            </Modal>
          </ModalOverlay>
        </DialogTrigger>
      </div>
    );
  const typeLabel = attachmentTypeLabel(attachment.fileName, attachment.contentType);
  const iconType = fileIconType(attachment.fileName, attachment.contentType);
  const previewKind = attachmentPreviewKind(
    attachment.fileName,
    attachment.contentType,
    attachment.previewUrl,
  );
  // The row owns its own flex: `Button` puts its children inside one `display: block` span, so an
  // icon and a text block handed to it directly stack vertically instead of sitting side by side.
  const card = (
    <span className="flex min-w-0 items-center gap-3">
      <FileTypeIcon className="size-10 shrink-0 dark:hidden" type={iconType} theme="light" />
      <FileTypeIcon className="size-10 shrink-0 not-dark:hidden" type={iconType} theme="dark" />
      <span className="min-w-0 text-left">
        <span className="block truncate text-sm font-medium text-secondary">
          {attachment.fileName}
        </span>
        <span className="block truncate text-xs text-tertiary">
          {typeLabel ? `${typeLabel} · ` : ""}
          {getReadableFileSize(attachment.sizeBytes)}
          {previewKind ? ` · ${m.conversation_attachment_preview_hint()}` : ""}
        </span>
      </span>
    </span>
  );
  // A file we can show reads in place instead of forcing a download: the card becomes the control
  // that opens the preview, with the download still one click away inside it. The preview lives in
  // a dialog rather than expanding inline so opening one never changes a message row's height.
  if (previewKind)
    return (
      <div className={attachmentRowClassName}>
        <DialogTrigger>
          <Button
            color="tertiary"
            noTextPadding
            aria-label={m.conversation_attachment_preview_open({ name: attachment.fileName })}
            // `Button` wraps its children in one `display: block` span of intrinsic width; without
            // `w-full min-w-0` on it the name cannot shrink, so it overflows under the download
            // control instead of truncating.
            className="h-auto min-w-0 flex-1 justify-start rounded-xl rounded-r-none p-3 hover:bg-secondary [&>span]:w-full [&>span]:min-w-0"
          >
            {card}
          </Button>
          <ModalOverlay isDismissable>
            {/* Full height on a phone (where the overlay already reserves its own padding), a
                centered panel from `sm` up. The panel owns its scrolling so the preview pane
                keeps its height instead of the whole dialog growing. */}
            <Modal className="h-full max-h-full w-full max-sm:overflow-hidden sm:h-[85vh] sm:max-w-4xl">
              <Dialog
                aria-label={attachment.fileName}
                className="flex h-full flex-col overflow-hidden"
              >
                {({ close }) => (
                  <>
                    <div className="flex shrink-0 items-center gap-2 border-b border-secondary p-3 pl-4 sm:pl-5">
                      <p className="min-w-0 flex-1 truncate text-sm font-semibold text-primary">
                        {attachment.fileName}
                      </p>
                      <ButtonUtility
                        icon={Download01}
                        size="sm"
                        color="tertiary"
                        tooltip={m.conversation_attachment_download()}
                        href={`${href}?download`}
                      />
                      <ButtonUtility
                        icon={XClose}
                        size="sm"
                        color="tertiary"
                        tooltip={m.controls_close()}
                        onClick={close}
                      />
                    </div>
                    <div className="flex min-h-0 flex-1 flex-col">
                      <AttachmentPreview
                        fileName={attachment.fileName}
                        kind={previewKind}
                        href={href}
                        previewUrl={attachment.previewUrl}
                      />
                    </div>
                  </>
                )}
              </Dialog>
            </Modal>
          </ModalOverlay>
        </DialogTrigger>
        {actionDivider}
        <div className="shrink-0 pr-2">{download}</div>
      </div>
    );
  return (
    <div className={attachmentRowClassName}>
      <div className="min-w-0 flex-1 p-3">{card}</div>
      {actionDivider}
      <div className="shrink-0 pr-2">{download}</div>
    </div>
  );
}

/** The "new messages" divider (Slack-style): a brand rule naming where unread begins. */
export function UnreadDivider() {
  return (
    <div
      role="separator"
      aria-label={m.conversation_unread_divider()}
      className="flex items-center gap-3 px-4 py-2 md:px-6"
    >
      {/* A neutral rule with the label at its end: the divider marks where reading resumes, so
          it has to be findable, but a coloured bar across the middle of the pane is the loudest
          thing on screen. The day divider above uses the same rule. */}
      <span aria-hidden="true" className="h-px flex-1 bg-secondary" />
      <span className="shrink-0 text-xs text-brand-secondary">
        {m.conversation_unread_divider()}
      </span>
    </div>
  );
}

/** The date rule drawn above the first message of a day. */
export function DayDivider({ value, locale }: { value: Date | string; locale?: string }) {
  const timeZone = useTimeZone();
  return (
    <div className="flex items-center gap-3 px-4 py-2 md:px-6">
      <span aria-hidden="true" className="h-px flex-1 bg-secondary" />
      <span className="shrink-0 bg-primary px-2 text-xs text-tertiary tabular-nums">
        {dayLabel(value, locale, timeZone)}
      </span>
      <span aria-hidden="true" className="h-px flex-1 bg-secondary" />
    </div>
  );
}

/** A row is a plain flow item: its height is whatever its content needs, and nothing — neither
 * this file nor the conversation around it — estimates that height in advance.
 *
 * Off-screen skipping (`content-visibility: auto` with `contain-intrinsic-size: auto 160px`) was
 * tried here and removed: it gives every never-rendered row a 160px placeholder, and prepending
 * older history at the top of the pane then forces a batch of those placeholders to resolve to
 * their real heights inside the viewport. The resulting shift re-triggers scroll anchoring, which
 * changes which rows count as near the viewport, which lays out more of them — a feedback loop
 * that pins the main thread until the renderer is killed. */
const ROW_CLASS = "flex flex-col";

/** An Agent's avatar in the stream, with that Agent's live status dot: it reads that one Agent, so
 * another Agent's activity never repaints this row. */
function MessageAgentAvatar({
  agentId,
  name,
  src,
  deleted,
}: {
  agentId: string;
  name: string;
  src?: string | null;
  deleted: boolean;
}) {
  const display = useLiveAgentDisplay(agentId);
  return <AgentDisplayAvatar name={name} src={src} display={display} deleted={deleted} size="sm" />;
}

/** One history row: optional day divider, then the message with its hover actions. */
/**
 * Memoized: a conversation re-renders on every send, poll, page and pane change, and a row only
 * needs to when its own message or row state does. Callers keep its props stable (`useCallback`,
 * `useLatestCallback` for event handlers) so an unrelated change skips the row.
 */
export const MessageRow = memo(function MessageRow({
  message,
  showsTask = false,
  own,
  dayChanged,
  grouped,
  expanded,
  onToggleExpanded,
  collapsible = true,
  unreadStartsHere,
  highlighted,
  dateLocale,
  onOpenThread,
  onToggleReaction,
  onToggleSave,
  onOpenAgentProfile,
  viewerId,
  plainMentions,
  onOpenTask,
  channelNames,
  onQuoteSelection,
}: {
  message: MessageView;
  own: boolean;
  dayChanged: boolean;
  grouped: boolean;
  /** Whether this message's very long body is showing in full. Owned by the conversation rather
   * than the row, so a row that re-renders (or is skipped and rendered again as you scroll) never
   * collapses behind the reader. */
  expanded: boolean;
  /** Called with this row's message id, so one stable handler serves every row. */
  onToggleExpanded: (messageId: string) => void;
  /** Whether a long body may fold at all (the viewer's "Collapse long messages" preference). */
  collapsible?: boolean;
  /** The conversation's unread run begins at this row: draws the divider above. */
  unreadStartsHere?: boolean;
  /** A position jump just landed on this row, so it wears the anchor highlight for a moment. The
   * `#message-<id>` deep link gets that from `:target` below; a saved jump carries no hash
   * (#713) and the pane highlights the row by id instead — same classes, either way. */
  highlighted?: boolean;
  dateLocale?: string;
  /** Opens a root's thread. Present, the row offers its thread (the toolbar and sheet entries,
   * and the preview card), each reading its own root's thread summary (`thread-summary.tsx`). */
  onOpenThread?: (rootId: string) => void;
  /** Shows the Task the message became under it (`MessageTask`): the conversation's own stream
   * does, a thread pane (whose root the Task popup already shows) does not. */
  showsTask?: boolean;
  /** Toggles the viewer's own emoji reaction on a message; the conversation refreshes it. */
  onToggleReaction?: (messageId: string, emoji: string, active: boolean) => void;
  /** Saves/unsaves this message for the viewer (#127): the conversation owns the write, the
   * Chat page's Saved context supplies `saved`. Absent, the row offers no save action. */
  onToggleSave?: (messageId: string, saved: boolean) => Promise<void>;
  /** Opens the Agent profile panel, on a given tab when one is named; present only where the
   * conversation owns that slot (`features/agents/profile-panel/`'s `openAgentProfile`). Absent, the
   * avatar/name render inert and the avatar has no hover card. */
  onOpenAgentProfile?: OpenAgentProfile;
  /** The viewing user's id; a mention of them renders with the stronger "me" chip, and a reaction
   * with them among its reactors is theirs. */
  viewerId?: string;
  /** The conversation's member directory as handle → chip, so a plain `@handle` in the body
   * (DM text, or a channel body written without the completion) still renders the member's
   * display label. Absent, plain handles render as literal text. */
  plainMentions?: Map<string, ChipMention>;
  /** Opens a task reference's detail popup (see `MessageBody`). */
  onOpenTask?: (number: number) => void;
  /** Channel id → current name, for the channel links in the body (see `MessageBody`). */
  channelNames?: ReadonlyMap<string, string>;
  /** Offers "reply to this selection" on a highlight inside this row's body: the row hands back
   * the finished markdown quote, credited to the message it came from. Absent (e.g. the
   * conversation has no composer to put it in), no affordance is offered and no selection is
   * read at all. */
  onQuoteSelection?: (quote: string) => void;
}) {
  const timeFormat = useTimeFormat();
  const timeZone = useTimeZone();
  const displayName = own ? m.conversation_you() : message.senderName;
  const deleted = Boolean(message.senderDeleted);
  const openableAgentId =
    !own &&
    !deleted &&
    message.senderKind === "agent" &&
    message.senderAgentId &&
    onOpenAgentProfile
      ? message.senderAgentId
      : undefined;
  // A deleted sender is inert and visually muted: no profile affordance, a grey avatar tone, and
  // a `DELETED` badge beside the name.
  // An Agent's avatar in the stream carries the same online/working/thinking/error/offline dot the
  // sidebar, conversation header and @-mention popup use, so you can tell whether the Agent that
  // wrote a message is around right now without opening its profile. The avatar reads that one
  // Agent from the app shell's live Agent store (`MessageAgentAvatar`). A person's avatar
  // stays plain here (people's presence is drawn on the Members page); a deleted Agent shows no dot
  // either (`AgentDisplayAvatar` greys it and drops the dot) — a deletion is not a presence state.
  const avatar =
    message.senderKind === "agent" && message.senderAgentId ? (
      <MessageAgentAvatar
        agentId={message.senderAgentId}
        name={message.senderName}
        src={message.senderAvatarUrl}
        deleted={deleted}
      />
    ) : (
      <Avatar
        size="sm"
        alt=""
        src={message.senderAvatarUrl}
        initials={avatarInitial(message.senderName)}
        contentClassName={
          deleted ? DELETED_AGENT_AVATAR_CLASS : avatarToneClassName(message.senderName)
        }
      />
    );
  // Reply-to-selection: the browser owns the highlight, this row only decides whether to *offer*
  // the action. The offer is made from a completed pointer gesture, so a drag that merely passes
  // over this message while selecting another one never raises it.
  const bodyRef = useRef<HTMLDivElement>(null);
  const quoteAffordanceRef = useRef<HTMLDivElement>(null);
  /** Whether the latest pointer press was a finger or a pen rather than a mouse: a selection made
   * that way raises the platform's own edit menu above the highlight, so the bar goes below it. */
  const touchSelectionRef = useRef(false);
  const toast = useAppToast();
  const saveSaved = useIsMessageSaved(message.id);
  const [quoteOffer, setQuoteOffer] = useState<
    { quote: string; html: string; text: string; top: number; left: number } | undefined
  >(undefined);
  /**
   * Reads the current highlight, and offers the quote only when the whole selection lives inside
   * this message's body: a highlight that spans rows cannot be credited to one of them, and a
   * quote that silently dropped half the selected text would be worse than no affordance.
   */
  const readQuoteSelection = useCallback(() => {
    if (!onQuoteSelection) return;
    const container = bodyRef.current;
    const selection = typeof window === "undefined" ? null : window.getSelection();
    if (!container || !selection || selection.isCollapsed || selection.rangeCount === 0) {
      setQuoteOffer(undefined);
      return;
    }
    const range = selection.getRangeAt(0);
    if (!container.contains(range.commonAncestorContainer)) {
      setQuoteOffer(undefined);
      return;
    }
    const quote = formatSelectionQuote(
      {
        author: displayName,
        time: clockLabel(message.createdAt, dateLocale, timeFormat, timeZone),
      },
      selection.toString(),
    );
    if (!quote) {
      setQuoteOffer(undefined);
      return;
    }
    // Centered on the highlight, above it for a mouse selection and below it for a touch one
    // (the platform's own edit menu takes the space above); the visible history scroller is the
    // flip boundary, so the bar only changes side when it would scroll out of view. The
    // fragment and its text are captured now: clicking a bar button may collapse the live
    // selection, but the copy actions must still carry what the reader highlighted.
    const placement = selectionAffordancePlacement(
      range.getBoundingClientRect(),
      container.getBoundingClientRect(),
      visibleBoundary(container),
      touchSelectionRef.current ? "below" : "above",
    );
    setQuoteOffer({
      quote,
      html: selectionFragmentHtml(range),
      text: selection.toString(),
      ...placement,
    });
  }, [onQuoteSelection, displayName, message.createdAt, dateLocale, timeFormat, timeZone]);
  // A gesture anywhere else (a click, a scroll, Escape) withdraws the offer. The affordance
  // itself is exempt: pointerdown on it would otherwise unmount the button before its click.
  useEffect(() => {
    if (!quoteOffer) return;
    const dismiss = (event: Event) => {
      if (event.target instanceof Node && quoteAffordanceRef.current?.contains(event.target))
        return;
      setQuoteOffer(undefined);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") dismiss(event);
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("scroll", dismiss, true);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("scroll", dismiss, true);
    };
  }, [quoteOffer]);
  // The mobile shell (single-pane below `lg`) has no hover to reveal the reply/reaction
  // actions, and keeping the toolbar always visible puts two buttons on every message.
  // Instead a tap on the row's non-interactive surface opens a bottom action sheet holding
  // the same actions (the wide desktop shell keeps hover/focus reveal); the modal overlay
  // owns dismissal (backdrop press, Escape). The switch follows the shell, not only the
  // pointer: a narrow desktop window shows the mobile shell, so it gets sheet interactions
  // too, and a large touchscreen still prefers tapping. The tap target check runs against
  // the DOM, so it also covers portaled overlays, whose React events still bubble through
  // this row.
  const coarsePointer = useCoarsePointer();
  const desktopShell = useBreakpoint("lg");
  const sheetActions = coarsePointer || !desktopShell;
  const [actionsOpen, setActionsOpen] = useState(false);
  const openActions = useCallback(
    (event: React.MouseEvent) => {
      if (!sheetActions || !(event.target instanceof Element)) return;
      if (
        event.target.closest(
          "button, a, input, textarea, select, [role='button'], [data-message-actions-popover]",
        )
      )
        return;
      setActionsOpen(true);
    },
    [sheetActions],
  );
  // Touch selection ends without a mouseup: the long-press and the OS selection handles fire no
  // usable mouse events, so on touch the offer is driven by `selectionchange` (debounced, so a
  // handle drag settles first) and by pointer release. While a pointer is down — a mouse drag
  // mid-selection — selection events are ignored and `onMouseUp` stays the trigger, keeping the
  // desktop bar tied to the completed gesture.
  const pointerDownRef = useRef(false);
  useEffect(() => {
    if (!onQuoteSelection) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(readQuoteSelection, 200);
    };
    const onPointerDown = (event: PointerEvent) => {
      pointerDownRef.current = true;
      touchSelectionRef.current = event.pointerType !== "mouse";
    };
    const onPointerUp = () => {
      pointerDownRef.current = false;
      schedule();
    };
    const onSelectionChange = () => {
      if (!pointerDownRef.current) schedule();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("pointerup", onPointerUp, true);
    document.addEventListener("pointercancel", onPointerUp, true);
    document.addEventListener("selectionchange", onSelectionChange);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("pointerup", onPointerUp, true);
      document.removeEventListener("pointercancel", onPointerUp, true);
      document.removeEventListener("selectionchange", onSelectionChange);
    };
  }, [onQuoteSelection, readQuoteSelection]);
  // A system message (task/membership notices, etc.) is not a person talking: it carries no
  // avatar and no sender heading, and renders as a compact, muted line of plain text in the
  // stream — like Slack's channel notices. It still carries the unread divider and the jump
  // highlight, since the unread run can begin at a notice and a jump can land on one. The
  // wrapper (`li`) is the same in both branches, so a system row costs the browser exactly what a
  // normal one does. A run of two or more notices is folded into one summary line by
  // `SystemMessageGroup`, which renders these rows when opened.
  if (message.senderKind === "system") {
    return (
      <li data-message-id={message.id} className={ROW_CLASS}>
        {unreadStartsHere && <UnreadDivider />}
        {dayChanged && <DayDivider value={message.createdAt} locale={dateLocale} />}
        <div
          id={`message-${message.id}`}
          data-message="system"
          data-scroll-anchor
          className={cn(
            "group/message flex scroll-m-6 items-baseline gap-2 px-4 py-1 text-xs text-tertiary transition-[background-color,box-shadow] duration-500 target:bg-tertiary target:ring-2 target:ring-brand/50 target:ring-offset-4 target:ring-offset-primary md:px-6",
            highlighted && "bg-tertiary ring-2 ring-brand/50 ring-offset-4 ring-offset-primary",
          )}
        >
          {/* System bodies are short plain text (task/membership notices, authored with a plain
              `@handle`, not a mention token), so they render as a single muted line rather than
              full Markdown. One line, never wrapped: overflow becomes an ellipsis (the boss's
              ruling on the phone — a notice is skimmable or it is noise). The span is a flex
              item with min-w-0, so `truncate` collapses against the hover timestamp and works. */}
          {/* The tooltip wraps the span itself: our `Tooltip` already renders RAC's
              `TooltipTrigger` around its child, and the wrapper version put a `<button>` between
              the flex row and this span — so the span's `min-w-0 flex-1` stopped governing the
              row, the row grew past the container, and the whole stream scrolled sideways on a
              phone. As a direct child the span is the flex item again, so `truncate` clips. */}
          <Tooltip title={message.body}>
            <span className="min-w-0 flex-1 truncate">{message.body}</span>
          </Tooltip>
          <Tooltip title={fullLabel(message.createdAt, dateLocale, timeFormat, timeZone)}>
            <time
              dateTime={new Date(message.createdAt).toISOString()}
              className="shrink-0 tabular-nums opacity-0 group-hover/message:opacity-100"
            >
              {clockLabel(message.createdAt, dateLocale, timeFormat, timeZone)}
            </time>
          </Tooltip>
        </div>
      </li>
    );
  }
  // #544's whole-message copy (the IM-standard "Copy text", the only copy path for a collapsed,
  // unselectable body) rides the action strip on desktop and the tap action sheet on the mobile
  // shell; the sheet therefore also opens for a message with no thread and no reactions.
  const copyable = Boolean(messagePlainText(message, channelNames).trim());
  return (
    <li data-message-id={message.id} className={ROW_CLASS}>
      {unreadStartsHere && <UnreadDivider />}
      {dayChanged && <DayDivider value={message.createdAt} locale={dateLocale} />}
      <div
        id={`message-${message.id}`}
        data-message={own ? "own" : "other"}
        onClick={openActions}
        className={cn(
          "group/message relative flex scroll-m-6 gap-3 px-4 transition-[background-color,box-shadow] duration-500 hover:bg-secondary focus-within:bg-secondary target:bg-tertiary target:ring-2 target:ring-brand/50 target:ring-offset-4 target:ring-offset-primary md:px-6",
          highlighted && "bg-tertiary ring-2 ring-brand/50 ring-offset-4 ring-offset-primary",
          grouped ? "py-0.5" : "py-2",
        )}
      >
        <div className="flex w-9 shrink-0 items-start justify-center">
          {grouped ? (
            <Tooltip title={fullLabel(message.createdAt, dateLocale, timeFormat, timeZone)}>
              <time
                dateTime={new Date(message.createdAt).toISOString()}
                className="mt-0.5 text-xs text-quaternary tabular-nums opacity-0 group-hover/message:opacity-100 group-focus-within/message:opacity-100"
              >
                {clockLabel(message.createdAt, dateLocale, timeFormat, timeZone)}
              </time>
            </Tooltip>
          ) : openableAgentId && onOpenAgentProfile ? (
            <AgentHoverCard
              agentId={openableAgentId}
              name={message.senderName}
              handle={message.senderHandle}
              src={message.senderAvatarUrl}
              trigger={avatar}
              onOpenProfile={onOpenAgentProfile}
            />
          ) : (
            avatar
          )}
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          {!grouped && (
            <p className="flex min-h-5 items-baseline gap-2 pr-8">
              {openableAgentId ? (
                <Button
                  color="tertiary"
                  noTextPadding
                  onPress={() => onOpenAgentProfile?.(openableAgentId)}
                  className="h-auto min-w-0 truncate rounded p-0 text-sm font-semibold text-primary hover:bg-transparent hover:text-primary hover:underline"
                >
                  {displayName}
                </Button>
              ) : (
                <span className="min-w-0 truncate text-sm font-semibold text-primary">
                  {displayName}
                </span>
              )}
              {message.senderKind === "agent" && message.senderAgentId && !deleted && (
                <AgentModelLabel agentId={message.senderAgentId} seenAt={message.createdAt} />
              )}
              {deleted && <DeletedAgentBadge />}
              <Tooltip title={fullLabel(message.createdAt, dateLocale, timeFormat, timeZone)}>
                <time
                  dateTime={new Date(message.createdAt).toISOString()}
                  className="shrink-0 text-xs text-tertiary tabular-nums"
                >
                  {clockLabel(message.createdAt, dateLocale, timeFormat, timeZone)}
                </time>
              </Tooltip>
            </p>
          )}
          {message.actionCard ? (
            <>
              {/* The raw summary (and draft hint) stay accessible; the card renders them. */}
              <span className="sr-only">{message.body}</span>
              <ActionCard card={message.actionCard} />
            </>
          ) : (
            // `relative` anchors the reply-to-selection affordance to the body it was highlighted
            // out of; the gesture handlers live here rather than on the row so dragging from a
            // message's text (its timestamp, say) cannot raise an offer for it. It is also the text
            // the scroll anchor holds in place across a load (`data-scroll-anchor`).
            <div
              ref={bodyRef}
              data-scroll-anchor
              onMouseUp={readQuoteSelection}
              onKeyUp={readQuoteSelection}
              className={cn(
                "relative min-w-0 text-md leading-6 text-primary [overflow-wrap:anywhere]",
                // A grouped row has no sender header, so the touch-visible action strip would
                // sit on its first text line; reserve the strip's width (thread + reaction +
                // copy buttons) up front instead.
                grouped && "pr-20",
              )}
            >
              <CollapsibleMessageBody
                body={message.weeklyReportDisplayBody ?? message.body}
                mentions={message.mentions}
                plainMentions={plainMentions}
                viewerId={viewerId}
                onOpenTask={onOpenTask}
                channelNames={channelNames}
                onOpenAgentProfile={onOpenAgentProfile}
                expanded={expanded}
                collapsible={collapsible}
                onToggleExpanded={() => onToggleExpanded(message.id)}
              />
              {message.weeklyReportSuggestion ? (
                <WeeklyReportMessageCard
                  messageId={message.id}
                  suggestion={message.weeklyReportSuggestion}
                  onOpenAgentProfile={onOpenAgentProfile}
                  disabled={deleted}
                />
              ) : null}
              {quoteOffer && onQuoteSelection && (
                <div
                  ref={quoteAffordanceRef}
                  style={{ top: quoteOffer.top, left: quoteOffer.left }}
                  className="absolute z-10 flex items-center gap-0.5 rounded-md border border-secondary bg-primary p-0.5 shadow-lg"
                >
                  <ButtonUtility
                    size="xs"
                    color="tertiary"
                    icon={CornerUpLeft}
                    tooltip={m.conversation_quote_selection()}
                    onClick={() => {
                      onQuoteSelection(quoteOffer.quote);
                      setQuoteOffer(undefined);
                    }}
                  />
                  <span aria-hidden="true" className="h-4 w-px shrink-0 bg-secondary" />
                  <ButtonUtility
                    size="xs"
                    color="tertiary"
                    icon={Copy01}
                    tooltip={m.conversation_copy_as_style()}
                    onClick={() => {
                      void copyFragmentStyled(quoteOffer.html, quoteOffer.text).then((copied) => {
                        if (copied) toast.success(m.conversation_copy_as_style_success());
                        else toast.error(m.conversation_copy_failed());
                      });
                      setQuoteOffer(undefined);
                    }}
                  />
                  <span aria-hidden="true" className="h-4 w-px shrink-0 bg-secondary" />
                  <ButtonUtility
                    size="xs"
                    color="tertiary"
                    icon={Code02}
                    tooltip={m.conversation_copy_as_markdown()}
                    onClick={() => {
                      void copyFragmentMarkdown(quoteOffer.html).then((copied) => {
                        if (copied) toast.success(m.conversation_copy_as_markdown_success());
                        else toast.error(m.conversation_copy_failed());
                      });
                      setQuoteOffer(undefined);
                    }}
                  />
                </div>
              )}
            </div>
          )}
          {message.attachments.map((attachment) => (
            <AttachmentCard key={attachment.id} attachment={attachment} />
          ))}
          {message.reactions && message.reactions.length > 0 && (
            <div className="flex flex-wrap gap-1 pt-0.5">
              {message.reactions.map((reaction) => {
                // A badge counts as mine when a reactor is the viewer, and flips to brand to show it.
                const mine = viewerId
                  ? reaction.reactors.some((reactor) => reactor.id === viewerId)
                  : false;
                return (
                  <Tooltip
                    key={reaction.emoji}
                    title={reaction.reactors.map((reactor) => reactor.label).join(", ")}
                  >
                    <TooltipTrigger>
                      <Button
                        color="tertiary"
                        size="sm"
                        noTextPadding
                        onPress={() => onToggleReaction?.(message.id, reaction.emoji, !mine)}
                        aria-pressed={mine}
                        className={cn(
                          "h-auto rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset",
                          mine
                            ? "bg-utility-brand-50 text-utility-brand-700 ring-utility-brand-200 hover:bg-utility-brand-100"
                            : "bg-utility-neutral-50 text-utility-neutral-700 ring-utility-neutral-200 hover:bg-utility-neutral-100",
                        )}
                      >
                        {reaction.emoji} {reaction.count}
                      </Button>
                    </TooltipTrigger>
                  </Tooltip>
                );
              })}
            </div>
          )}
          {showsTask && <MessageTask messageId={message.id} />}
          {onOpenThread && <ThreadPreview rootId={message.id} onOpen={onOpenThread} />}
        </div>
        {(onOpenThread || onToggleReaction || onToggleSave || copyable) && (
          /* Hidden until revealed: hover/focus in the wide desktop shell (`lg` and up, with
             a hover-capable fine pointer). An unread-thread badge stays inside this bar, but
             does not force it open: the thread preview already exposes the unread count, so
             showing both would duplicate the same signal. Everywhere else the row tap opens
             the action sheet instead. The reveal needs all three conditions: below `lg` the
             mobile shell is in charge even on a mouse-driven narrow window; mobile browsers
             stick `:hover` onto a tapped row (it has a click handler); and some touch devices
             (iOS Safari) report `hover: hover` anyway — any missing gate would leave the bar
             visible after the sheet closes. Hidden also means `pointer-events-none` — an
             invisible bar must not swallow taps aimed at the message under it. Order is thread,
             reactions, then whole-message copy last — the IM-standard order (#546). */
          <div
            className={cn(
              "pointer-events-none absolute top-0.5 right-3 flex items-center gap-0.5 rounded-lg border border-secondary bg-primary p-0.5 opacity-0 shadow-lg transition-opacity",
              "lg:[@media(hover:hover)_and_(pointer:fine)]:group-focus-within/message:pointer-events-auto lg:[@media(hover:hover)_and_(pointer:fine)]:group-focus-within/message:opacity-100",
              "lg:[@media(hover:hover)_and_(pointer:fine)]:group-hover/message:pointer-events-auto lg:[@media(hover:hover)_and_(pointer:fine)]:group-hover/message:opacity-100",
            )}
          >
            {onOpenThread && <ThreadToolbarEntry rootId={message.id} onOpen={onOpenThread} />}
            {onToggleReaction && (
              <MessageReactionPicker
                onPick={(emoji) => onToggleReaction(message.id, emoji, true)}
              />
            )}
            {onToggleSave && (
              <ButtonUtility
                size="xs"
                color="tertiary"
                icon={saveSaved ? BookmarkCheck : Bookmark}
                tooltip={saveSaved ? m.conversation_unsave() : m.conversation_save()}
                aria-label={saveSaved ? m.conversation_unsave() : m.conversation_save()}
                onClick={() => {
                  void onToggleSave(message.id, !saveSaved).catch(() => {
                    toast.error(m.conversation_save_failed());
                  });
                }}
                className="p-1 *:data-icon:size-3.5"
              />
            )}
            <ButtonUtility
              size="xs"
              color="tertiary"
              icon={Copy01}
              tooltip={m.conversation_message_copy_text()}
              onClick={() => {
                void copyText(messagePlainText(message, channelNames)).then((copied) => {
                  if (copied) toast.success(m.conversation_message_copied());
                  else toast.error(m.conversation_copy_failed());
                });
              }}
              className="p-1 *:data-icon:size-3.5"
            />
          </div>
        )}
        {sheetActions && (onOpenThread || onToggleReaction || onToggleSave || copyable) && (
          /* The mobile-shell counterpart of the hover toolbar: a bottom action sheet in the
             Slack/Discord mobile layout — the quoted message card, a quick-reaction row,
             then full-width actions (thread row, whole-message copy last) — opened by a tap
             on the message. Dismissal (backdrop press, Escape) and focus containment come
             from the modal overlay. The overlay carries `data-message-actions-popover` so
             its backdrop press doesn't bubble back into the row's tap-to-open handler. */
          <AriaModalOverlay
            isOpen={actionsOpen}
            onOpenChange={setActionsOpen}
            isDismissable
            data-message-actions-popover
            className={(state) =>
              cn(
                "fixed inset-0 z-50 flex min-h-dvh items-end justify-center bg-overlay/70 outline-hidden backdrop-blur-[6px]",
                state.isEntering && "duration-300 ease-out animate-in fade-in",
                state.isExiting && "duration-200 ease-in animate-out fade-out",
              )
            }
          >
            <AriaModal
              className={(state) =>
                cn(
                  "w-full rounded-t-2xl bg-primary shadow-xl outline-hidden",
                  state.isEntering && "duration-300 ease-out animate-in slide-in-from-bottom",
                  state.isExiting && "duration-200 ease-in animate-out slide-out-to-bottom",
                )
              }
            >
              <Dialog
                aria-label={m.conversation_message_actions()}
                className="pb-[env(safe-area-inset-bottom)]"
              >
                <div
                  aria-hidden="true"
                  className="mx-auto mt-2 h-1 w-9 rounded-full bg-quaternary/40"
                />
                {/* The tapped message, quoted in a muted card at the top — the Slack/Discord
                    mobile signature that tells you which message the actions belong to. */}
                <div className="mx-3 mt-3 flex gap-2.5 rounded-xl bg-secondary/60 p-3">
                  <span className="shrink-0">{avatar}</span>
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <p className="flex items-baseline gap-2">
                      <span className="min-w-0 truncate text-sm font-semibold text-primary">
                        {displayName}
                      </span>
                      <Tooltip
                        title={fullLabel(message.createdAt, dateLocale, timeFormat, timeZone)}
                      >
                        <time
                          dateTime={new Date(message.createdAt).toISOString()}
                          className="shrink-0 text-xs text-tertiary tabular-nums"
                        >
                          {clockLabel(message.createdAt, dateLocale, timeFormat, timeZone)}
                        </time>
                      </Tooltip>
                    </p>
                    <p className="line-clamp-2 text-sm leading-5 text-secondary [overflow-wrap:anywhere]">
                      {messagePlainText(message, channelNames)}
                    </p>
                  </div>
                </div>
                {onToggleReaction && (
                  <div
                    role="group"
                    aria-label={m.conversation_add_reaction()}
                    className="flex items-center px-3 pt-2 pb-1"
                  >
                    {QUICK_REACTION_EMOJIS.map((emoji) => (
                      <Button
                        key={emoji}
                        color="tertiary"
                        size="sm"
                        noTextPadding
                        onPress={() => {
                          setActionsOpen(false);
                          onToggleReaction(message.id, emoji, true);
                        }}
                        // `px-0!` overrides the size's horizontal padding so the eight
                        // cells share the row's width evenly instead of overflowing it.
                        className="h-auto min-w-0 flex-1 rounded-full px-0! py-3 text-2xl leading-none"
                      >
                        {emoji}
                      </Button>
                    ))}
                  </div>
                )}
                <div className="flex flex-col px-3 pt-1 pb-3">
                  {onToggleSave && (
                    <Button
                      color="tertiary"
                      size="md"
                      noTextPadding
                      iconLeading={saveSaved ? BookmarkCheck : Bookmark}
                      onPress={() => {
                        setActionsOpen(false);
                        void onToggleSave(message.id, !saveSaved).catch(() => {
                          toast.error(m.conversation_save_failed());
                        });
                      }}
                      className="w-full justify-start rounded-lg py-3 *:data-icon:size-5 [&>[data-text]]:flex-1 [&>[data-text]]:text-left"
                    >
                      {saveSaved ? m.conversation_unsave() : m.conversation_save()}
                    </Button>
                  )}
                  {(onToggleReaction || onToggleSave) && (copyable || onOpenThread) && (
                    <div aria-hidden="true" className="mx-1 mt-1 mb-1 h-px bg-secondary" />
                  )}
                  {onOpenThread && (
                    <ThreadSheetEntry
                      rootId={message.id}
                      onOpen={(rootId) => {
                        setActionsOpen(false);
                        onOpenThread(rootId);
                      }}
                    />
                  )}
                  {copyable && onOpenThread && (
                    <div aria-hidden="true" className="mx-1 my-1 h-px bg-secondary" />
                  )}
                  {copyable && (
                    <Button
                      color="tertiary"
                      size="md"
                      noTextPadding
                      iconLeading={Copy01}
                      onPress={() => {
                        setActionsOpen(false);
                        void copyText(messagePlainText(message, channelNames)).then((copied) => {
                          if (copied) toast.success(m.conversation_message_copied());
                          else toast.error(m.conversation_copy_failed());
                        });
                      }}
                      className="w-full justify-start rounded-lg py-3 *:data-icon:size-5 [&>[data-text]]:flex-1 [&>[data-text]]:text-left"
                    >
                      {m.conversation_message_copy_text()}
                    </Button>
                  )}
                </div>
              </Dialog>
            </AriaModal>
          </AriaModalOverlay>
        )}
      </div>
    </li>
  );
});
