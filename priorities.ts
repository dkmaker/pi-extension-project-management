import type { Epic, Issue } from "./types.js";

export interface FocusResult {
  type: "in-progress" | "ready" | "todo" | "researched" | "draft" | "close-epic" | "none";
  epic: Epic;
  issue?: Issue;
  todoIndex?: number;
  todoText?: string;
}

/**
 * Given an in-progress epic, determine the highest-priority next action.
 */
export function resolveEpicFocus(epic: Epic, issues: Issue[]): FocusResult | null {
  if (epic.status !== "in-progress") return null;

  const open = issues.filter(i => i.epicId === epic.id && i.status !== "closed");
  const inProgress = open.filter(i => i.status === "in-progress");
  const ready = open.filter(i => i.status === "ready");
  const researched = open.filter(i => i.status === "researched");
  const draft = open.filter(i => i.status === "draft");
  const unfinishedTodos = epic.todos.filter(t => !t.done);

  if (inProgress.length) return { type: "in-progress", epic, issue: inProgress[0] };
  if (ready.length) return { type: "ready", epic, issue: ready[0] };
  if (unfinishedTodos.length) {
    const idx = epic.todos.indexOf(unfinishedTodos[0]);
    return { type: "todo", epic, todoIndex: idx, todoText: unfinishedTodos[0].text };
  }
  if (researched.length) return { type: "researched", epic, issue: researched[0] };
  if (draft.length) return { type: "draft", epic, issue: draft[0] };

  if (!open.length && !unfinishedTodos.length) return { type: "close-epic", epic };

  return null;
}
