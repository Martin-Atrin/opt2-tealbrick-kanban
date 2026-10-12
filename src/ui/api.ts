// Typed person-op calls for the owner board (op ids and I/O types from the generated kit; types only, erased at build).
import { callOp } from "@opt2-tealbrick/miniapp-sdk/client";
import type { PersonOps } from "#kit";

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

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : "something went wrong";
}
export function when(isoTime: string): string {
  return new Date(isoTime).toLocaleString();
}
