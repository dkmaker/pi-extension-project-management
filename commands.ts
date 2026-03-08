import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { load, activeEpics, nextEpic } from "./store.js";
import { formatBrief, formatIssue, formatAssetsContext } from "./format.js";
import { resolveEpicFocus } from "./priorities.js";
import { ISSUE_TYPE_ICON } from "./constants.js";

export function registerCommands(pi: ExtensionAPI) {
  pi.registerCommand("project-stats", {
    description: "Show token overhead diagnostics — what the project extension injects into LLM context",
    handler: async (_args, ctx) => {
      const r = load();

      // 1. Brief dashboard (session start injection)
      const brief = formatBrief(r);
      const briefChars = brief.length;

      // 2. Asset context (session start injection)
      const assetsCtx = formatAssetsContext(r.assets);
      const assetsChars = assetsCtx.length;

      // 3. Per-turn steering
      let steeringChars = 0;
      const active = activeEpics(r);
      const epic = nextEpic(active);
      if (epic && epic.status === "in-progress") {
        const focus = resolveEpicFocus(epic, r.issues);
        if (focus) {
          // Approximate steering message size
          const openCount = r.issues.filter(i => i.epicId === epic.id && i.status !== "closed").length;
          const line1 = `[PROJECT] Epic: [${epic.id}] ${epic.title} (${openCount} open issues, todos: ${epic.todos.filter(t => t.done).length}/${epic.todos.length})`;
          const line2 = `→ ${focus.type}: [${focus.issue?.id || ""}] ${focus.issue?.title || focus.todoText || ""}`;
          const line3 = `Advance issues as you work: draft→researched→ready→in-progress→closed. Verify implementations before closing.`;
          steeringChars = line1.length + line2.length + line3.length + 4;
        }
      }

      const totalChars = briefChars + assetsChars + steeringChars;
      const totalTokens = Math.round(totalChars / 4);

      const lines = [
        `📊 Project Extension — LLM Context Injection`,
        ``,
        `Source                     │ Chars  │ ~Tokens │ When`,
        `───────────────────────────┼────────┼─────────┼──────────────`,
        `Brief dashboard            │ ${String(briefChars).padStart(6)} │ ${String(Math.round(briefChars / 4)).padStart(7)} │ Session start`,
        `Asset context              │ ${String(assetsChars).padStart(6)} │ ${String(Math.round(assetsChars / 4)).padStart(7)} │ Session start`,
        `Per-turn steering          │ ${String(steeringChars).padStart(6)} │ ${String(Math.round(steeringChars / 4)).padStart(7)} │ Every turn`,
        `───────────────────────────┼────────┼─────────┼──────────────`,
        `TOTAL                      │ ${String(totalChars).padStart(6)} │ ${String(totalTokens).padStart(7)} │`,
        ``,
        `Note: Tool schemas (${pi.getActiveTools().length} total) are sent separately via API tools param, not in prompt context.`,
      ];

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  pi.registerCommand("continue", {
    description: "Resume work — reads project state and proposes the next concrete step",
    handler: async (args, ctx) => {
      const r = load();
      const userHint = (args ?? "").trim();

      // Build a rich status summary
      const lines: string[] = ["## 📍 Project Status for Resumption\n"];

      // Active epic + focus
      const active = activeEpics(r);
      const epic = nextEpic(active);
      if (epic) {
        const openIssues = r.issues.filter(i => i.epicId === epic.id && i.status !== "closed");
        const todosDone = epic.todos.filter(t => t.done).length;
        lines.push(`### Active Epic: [${epic.id}] ${epic.title} (${epic.status})`);
        lines.push(`${epic.description}`);
        lines.push(`Todos: ${todosDone}/${epic.todos.length} · Open issues: ${openIssues.length}\n`);

        // Detailed issue breakdown by status
        const byStatus: Record<string, typeof openIssues> = {};
        for (const i of openIssues) {
          (byStatus[i.status] ??= []).push(i);
        }
        for (const [status, issues] of Object.entries(byStatus)) {
          lines.push(`**${status}:**`);
          for (const i of issues) {
            let line = `- ${formatIssue(i)}`;
            // Show unanswered questions
            const unansweredReq = (i.questions || []).filter((q: any) => !q.answer && q.required !== false);
            if (unansweredReq.length) line += ` (${unansweredReq.length} required ❓)`;
            lines.push(line);
          }
        }

        // Focus recommendation
        const focus = resolveEpicFocus(epic, r.issues);
        if (focus) {
          lines.push("");
          switch (focus.type) {
            case "in-progress":
              lines.push(`**→ Continue:** [${focus.issue!.id}] ${focus.issue!.title}`);
              break;
            case "ready":
              lines.push(`**→ Start next:** [${focus.issue!.id}] ${focus.issue!.title}`);
              break;
            case "todo":
              lines.push(`**→ Next todo:** ${focus.todoText}`);
              break;
            case "close-epic":
              lines.push(`**→ All done — close the epic**`);
              break;
            default:
              lines.push(`**→ Next:** [${focus.issue?.id}] ${focus.issue?.title} (${focus.type})`);
          }
        }
      } else {
        lines.push("*No active epic.* Use `epic_list` or `next_work` to find what to work on.");
      }

      // Unplanned issues
      const unplanned = r.issues.filter(i => !i.epicId && i.status !== "closed");
      if (unplanned.length) {
        lines.push(`\n### Unplanned Issues (${unplanned.length})`);
        for (const i of unplanned) lines.push(`- ${formatIssue(i)}`);
      }

      if (userHint) {
        lines.push(`\n### User Direction\n> ${userHint}`);
      }

      lines.push(`\n---\n**Your task:** Based on the above, propose the single most impactful next step. Be specific — name the issue/todo, what to do, and what the first action is. If the user gave direction, prioritize that.`);

      pi.sendMessage(
        {
          customType: "continue-prompt",
          content: lines.join("\n"),
          display: false,
        },
        { triggerTurn: true, deliverAs: "steer" },
      );
    },
  });

  pi.registerCommand("idea", {
    description: "Capture a quick idea — AI fleshes it out and creates an issue",
    handler: async (args, ctx) => {
      const text = (args ?? "").trim();
      if (!text) {
        ctx.ui.notify("Usage: /idea <your idea in a sentence>", "warn");
        return;
      }

      pi.sendMessage(
        {
          customType: "idea-prompt",
          content: [
            `## 💡 New Idea Proposal\n`,
            `The user has a quick idea:`,
            `> ${text}\n`,
            `**Your task:**`,
            `1. Consider project context (epics, issues, assets, current state)`,
            `2. Propose a concrete idea: short **title** + **description** (2-4 sentences, markdown)`,
            `3. Present for approval — do NOT create until the user approves`,
            `4. On approval, call \`issue_add\` with type \`idea\``,
          ].join("\n"),
          display: false,
        },
        { triggerTurn: true, deliverAs: "steer" },
      );
    },
  });

  pi.registerCommand("feature", {
    description: "Request a feature — AI shapes it into a concrete proposal with implementation approach",
    handler: async (args, ctx) => {
      const text = (args ?? "").trim();
      if (!text) {
        ctx.ui.notify("Usage: /feature <describe the feature in a sentence>", "warn");
        return;
      }

      pi.sendMessage(
        {
          customType: "feature-request",
          content: [
            `## ✨ Feature Request\n`,
            `The user wants a feature:`,
            `> ${text}\n`,
            `**Your task:**`,
            `1. Consider project context (epics, issues, assets, current state)`,
            `2. Propose: short **title**, **description** (what problem it solves, 2-3 sentences), and **implementation approach** (key changes, files affected)`,
            `3. Present for approval — do NOT create until the user approves`,
            `4. On approval, call \`issue_add\` with type \`feature\``,
          ].join("\n"),
          display: false,
        },
        { triggerTurn: true, deliverAs: "steer" },
      );
    },
  });

  pi.registerCommand("bug", {
    description: "Report a bug — AI triages against closed issues and proposes a linked fix",
    handler: async (args, ctx) => {
      const text = (args ?? "").trim();
      if (!text) {
        ctx.ui.notify("Usage: /bug <describe the bug in a sentence>", "warn");
        return;
      }

      pi.sendMessage(
        {
          customType: "bug-triage",
          content: [
            `## 🐛 Bug Triage Request\n`,
            `The user is reporting a bug:`,
            `> ${text}\n`,
            `**Your triage process:**`,
            `1. **Search for related implementations:** Use \`issue_list\` with \`include_closed: true\` to find closed issues related to the broken functionality.`,
            `2. **Review the original work:** Use \`issue_show\` on candidates — check description, research notes, validations, and close messages.`,
            `3. **Identify root cause:** Analyze what likely went wrong based on the original implementation.`,
            `4. **Propose a bug issue:** Present related issue(s), root cause analysis, proposed title, and description. Wait for user approval.`,
            `5. **On approval:** Create with \`issue_add\` (type: \`bug\`), then \`issue_link\` to originating issue(s).`,
          ].join("\n"),
          display: false,
        },
        { triggerTurn: true, deliverAs: "steer" },
      );
    },
  });
}
