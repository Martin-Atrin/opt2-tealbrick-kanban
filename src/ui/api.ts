// Typed person-op calls for the owner board (op ids and I/O types from the generated kit; types only, erased at build).
import { callOp } from "@opt2-tealbrick/miniapp-sdk/client";
import type { PersonOps } from "#kit";
import { errorMessage } from "./standard.tsx";

export type In<K extends keyof PersonOps> = PersonOps[K]["input"];
export type Out<K extends keyof PersonOps> = PersonOps[K]["output"];
export type BoardData = Out<"board_view">;
export type Issue = BoardData["issues"][number];
export type Project = BoardData["projects"][number];
export type Agent = BoardData["agents"][number];
export type Goal = BoardData["goals"][number];
export type Activity = BoardData["activity"][number];
export type IssueDetail = Out<"board_issue">;
export type Status = Issue["status"];
export type Priority = Issue["priority"];

export function run<K extends keyof PersonOps>(op: K, input: In<K>): Promise<Out<K>> {
  return callOp<Out<K>>(op, input as never);
}

export const COLUMNS: { status: Status; label: string }[] = [
  { status: "backlog", label: "Backlog" },
  { status: "todo", label: "Todo" },
  { status: "in_progress", label: "In progress" },
  { status: "in_review", label: "In review" },
  { status: "blocked", label: "Blocked" },
  { status: "done", label: "Done" },
];
export const STATUS_LABEL = Object.fromEntries(COLUMNS.map((c) => [c.status, c.label])) as Record<Status, string>;
export const PRIORITIES: { value: Priority; label: string }[] = [
  { value: "high", label: "High" },
  { value: "medium", label: "Medium" },
  { value: "low", label: "Low" },
];

/** Plain sentence for a failed call (L18): the cause and what to do, never the upstream text. */
export function explain(e: unknown): string {
  switch ((e as { code?: unknown } | null)?.code) {
    case "not_found":
      return "That item is gone. Refresh the board and try again.";
    case "link_cycle":
      return "That dependency would make a loop. Pick another issue.";
    case "link_invalid":
      return "That issue can’t be a dependency here. Pick another issue.";
    case "comment_empty":
      return "Write a comment first.";
    case "assignee_invalid":
    case "assignee_unknown":
      return "That assignee isn’t available. Pick another one.";
    case "goal_invalid":
      return "That goal belongs to another project. Pick another one.";
    default:
      return errorMessage(e);
  }
}
/** The mockup's time form (C185): "Today 09:41", "Yesterday", else "9 Oct 2026"; en-GB, 24-hour, the same for everyone. */
const LOCALE = "en-GB";
const dayKey = (d: Date) => d.toDateString();
export function when(isoTime: string, now: Date = new Date()): string {
  const d = new Date(isoTime);
  if (dayKey(d) === dayKey(now)) return `Today ${d.toLocaleTimeString(LOCALE, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" })}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  return dayKey(d) === dayKey(yesterday) ? "Yesterday" : dateOf(isoTime);
}
/** The date only, "9 Oct 2026" (en-GB). */
export function dateOf(isoTime: string): string {
  return new Date(isoTime).toLocaleDateString(LOCALE, { day: "numeric", month: "short", year: "numeric" });
}

/** Moving to blocked or done asks for the reason / result (optional), as the agent ops do. Every move path (drag,
 *  the issue dialog's Column select) goes through this rule. */
export const needsNote = (status: Status) => status === "blocked" || status === "done";
