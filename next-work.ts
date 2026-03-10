import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { load, activeEpics, nextEpic } from "./store.js";
import { formatIssue } from "./format.js";
import { resolveEpicFocus } from "./priorities.js";

export function registerNextWork(pi: ExtensionAPI) {
  pi.registerTool({
    name: "next_work",
    label: "Next Work",
    description: "Find next work item by priority. Use project_tool_docs('next_work') for usage.",
    parameters: Type.Object({}),
    async execute() {
      const r = load();
      const active = activeEpics(r);
      const focus = nextEpic(active);

      const sections: string[] = [];

      // 1. In-progress epic: check todos and issues
      if (focus && focus.status === "in-progress") {
        const linkedIssues = r.issues.filter((i) => i.epicId === focus.id && i.status !== "closed");
        const todosDone = focus.todos.filter((t) => t.done).length;

        sections.push(`## 🔧 Active Epic: [${focus.id}] ${focus.title}`);
        sections.push(`Todos: ${todosDone}/${focus.todos.length} · Issues: ${linkedIssues.length} open`);

        const resolved = resolveEpicFocus(focus, r.issues);
        if (resolved) {
          switch (resolved.type) {
            case "in-progress": {
              const cur = resolved.issue!;
              sections.push(`\n### → Continue: ${formatIssue(cur)}`);
              const others = linkedIssues.filter(i => i.status === "in-progress" && i.id !== cur.id);
              if (others.length) {
                sections.push(`\n**Also in-progress:**`);
                for (const i of others) sections.push(`- ${formatIssue(i)}`);
              }
              break;
            }
            case "ready": {
              const rq = (resolved.issue!.questions || []).filter(q => !q.answer && q.required !== false);
              if (rq.length) {
                sections.push(`\n### → Resolve questions first: ${formatIssue(resolved.issue!)}`);
                sections.push(`${rq.length} required question(s) block advancement — use \`issue_question\``);
              } else {
                sections.push(`\n### → Start: ${formatIssue(resolved.issue!)}`);
              }
              break;
            }
            case "todo":
              sections.push(`\n### → Next todo: ⬜ ${resolved.todoText}`);
              break;
            case "researched":
              sections.push(`\n### → Advance: ${formatIssue(resolved.issue!)} (researched → ready)`);
              break;
            case "draft":
              sections.push(`\n### → Research: ${formatIssue(resolved.issue!)}`);
              break;
            case "close-epic":
              sections.push(`\n### → Ready to close this epic`);
              break;
          }
        }
      }
      // 2. Planned epic — suggest starting it
      else if (focus && focus.status === "planned") {
        const linkedTotal = r.issues.filter((i) => i.epicId === focus.id && i.status !== "closed").length;
        sections.push(`## 📋 Next Planned: [${focus.id}] ${focus.title}`);
        sections.push(`${focus.description}\nIssues: ${linkedTotal} open`);
        sections.push(`\n### → Advance to in-progress to start`);
      }
      // 3. Draft epic — suggest advancing
      else if (focus && focus.status === "draft") {
        sections.push(`## 📝 Next Draft: [${focus.id}] ${focus.title}`);
        sections.push(`${focus.description}`);

        const gaps: string[] = [];
        if (!focus.body) gaps.push("Add detailed body");
        if (!focus.successCriteria.length) gaps.push("Define success criteria");
        if (!focus.research.length) gaps.push("Add research notes");

        if (gaps.length) {
          sections.push(`\n### → Prepare:\n${gaps.map((g) => `- ${g}`).join("\n")}`);
        } else {
          sections.push(`\n### → Ready to advance to planned`);
        }
      }

      // 4. Unassigned bugs — always surface (even without epic), they're urgent
      const unassignedBugs = r.issues.filter((i) => !i.epicId && i.status !== "closed" && i.type === "bug");
      if (unassignedBugs.length) {
        sections.push(`\n---\n## 🐛 Unassigned Bugs (${unassignedBugs.length}) — assign to an epic to action`);
        for (const i of unassignedBugs) sections.push(`- ${formatIssue(i)}`);
      }

      // Note: other unassigned issues (features, chores, etc.) are intentionally excluded —
      // they live in the "unassigned" parking-lot bucket and must be assigned to an epic first.
      // Use `issue_list --unassigned true` to triage them.

      // 5. Nothing at all
      if (!sections.length) {
        return { content: [{ type: "text", text: "🎉 **All clear!** No epics, no issues. Create one with `epic_add` or `issue_add`." }] };
      }

      return { content: [{ type: "text", text: `# 🎯 Next Work\n\n${sections.join("\n")}` }] };
    },
  });
}
