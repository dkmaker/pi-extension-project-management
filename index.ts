import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { getMarkdownTheme } from "@mariozechner/pi-coding-agent";
import { Markdown, Text, visibleWidth, truncateToWidth } from "@mariozechner/pi-tui";
import { load, activeEpics, nextEpic } from "./store.js";
import { formatBrief, formatAssetsContext, statusBarText, focusWidgetData, renderFocusLine } from "./format.js";
import { registerEpicTools } from "./epics.js";
import { registerIssueTools } from "./issues.js";
import { registerNextWork } from "./next-work.js";
import { registerAssetTools } from "./assets.js";
import { registerToolDocsTool } from "./tool-docs.js";
import { registerDashboard } from "./dashboard.js";
import { registerCommands } from "./commands.js";
import { resolveEpicFocus } from "./priorities.js";
import { isServerRunning, getServerInfo, initFromLock } from "./dashboard-server.js";
import { getConfigValue } from "./config.js";

const PROJECT_TOOLS = new Set([
  "epic_add", "epic_show", "epic_list", "epic_update", "epic_advance",
  "epic_close", "epic_reopen", "epic_todo", "epic_research",
  "issue_add", "issue_show", "issue_list", "issue_update", "issue_advance",
  "issue_close", "issue_reopen", "issue_research",
  "issue_link", "issue_unlink", "issue_question",
  "asset_add", "asset_show", "asset_list", "asset_update", "asset_link",
  "asset_unlink", "asset_categories", "asset_source",
  "next_work",
  "project_tool_docs",
]);

export default function (pi: ExtensionAPI) {
  // --- Status bar ---
  function refreshStatus(ctx: any) {
    try {
      const r = load();
      ctx.ui.setStatus("project", statusBarText(r, ctx.ui.theme));

      // Focus widget above editor (full-width, dynamically truncated)
      const data = focusWidgetData(r);
      if (data) {
        ctx.ui.setWidget("project-focus", (_tui: any, theme: any) => {
          return {
            render(width: number): string[] {
              const line = renderFocusLine(data, theme, width);
              const visible = visibleWidth(line);
              const pad = Math.max(0, width - visible);
              return [truncateToWidth(line + " ".repeat(pad), width)];
            },
            invalidate() {},
          };
        });
      } else {
        ctx.ui.setWidget("project-focus", undefined);
      }
    } catch {}
  }

  // Map tool names to policy events
  const TOOL_TO_EVENT: Record<string, string> = {
    epic_add: "epic_create",
    epic_close: "epic_close",
    epic_advance: "epic_advance",
    issue_add: "issue_create",
    issue_close: "issue_close",
    issue_advance: "issue_advance",
  };

  // Detect bash commands that perform file writes
  const BASH_WRITE_PATTERN = /(?:^|\s|&&|\|)(?:>|>>|tee\s|sed\s+-i|mv\s|cp\s|install\s|chmod\s|mkdir\s|rm\s|touch\s|cat\s+.*>)/;

  const FILE_WRITE_TOOLS = new Set(["edit", "write"]);

  function isWriteOperation(toolName: string, input?: any): boolean {
    if (FILE_WRITE_TOOLS.has(toolName)) return true;
    if (toolName === "bash") {
      const cmd: string = input?.command || "";
      return BASH_WRITE_PATTERN.test(cmd);
    }
    return false;
  }

  pi.on("tool_result", async (event, ctx) => {
    if (PROJECT_TOOLS.has(event.toolName)) {
      refreshStatus(ctx);
    }

    // Gate: warn on file-write operations when no issue is in-progress
    if (isWriteOperation(event.toolName, event.input)) {
      try {
        const r = load();
        const writeGateEnabled = getConfigValue<boolean>(r, "workflow.write_gate");
        if (!writeGateEnabled) return undefined;
        const inProgressIssue = r.issues.find(i => i.status === "in-progress");
        if (!inProgressIssue) {
          const openIssues = r.issues.filter(i => i.status !== "closed");
          let hint = "";
          if (openIssues.length) {
            const active = r.epics.filter(e => e.status !== "closed").sort((a, b) => a.priority - b.priority);
            const focusEpic = active.find(e => e.status === "in-progress");
            const focusIssue = (focusEpic
              ? r.issues.find(i => i.epicId === focusEpic.id && i.status !== "closed")
              : undefined) || openIssues[0];
            hint = ` Next issue: [${focusIssue.id}] "${focusIssue.title}" (${focusIssue.status}) — advance it with \`issue_advance\` first.`;
          }
          return {
            content: [
              ...(event.content || []),
              { type: "text", text: `\n\n⚠️ WORKFLOW GATE: No issue is in-progress. File writes require an active issue.${hint}` },
            ],
          };
        }
      } catch {}
    }

    // Check for policy triggers
    const policyEvent = TOOL_TO_EVENT[event.toolName];
    if (policyEvent) {
      try {
        const r = load();
        const triggered = r.assets.filter(a => a.trigger?.event === policyEvent);
        if (triggered.length) {
          const directives = triggered.map(a => `**[Policy: ${a.title}]** ${a.body}`).join("\n\n");
          pi.sendMessage(
            {
              customType: "policy-directive",
              content: `## 📋 Triggered Policies\n\n${directives}`,
              display: false,
            },
            { triggerTurn: false },
          );
        }
      } catch {}
    }
  });

  // --- Session start: brief status + asset context ---
  pi.on("session_start", async (_event, ctx) => {
    refreshStatus(ctx);

    const alreadyDone = ctx.sessionManager.getEntries().some(
      (e) => e.type === "custom" && (e as any).customType === "project-init"
    );
    if (alreadyDone) return;

    const r = load();
    pi.appendEntry("project-init", { ts: Date.now() });

    // Brief status (visible + LLM context)
    let brief = (r.epics.length || r.issues.length || r.assets.length)
      ? formatBrief(r)
      : "# 📦 Project Status\n\n*No epics, issues, or assets yet.* Use `epic_add`, `issue_add`, or `asset_add` to get started.";

    const serverInfo = getServerInfo();
    if (serverInfo) {
      brief += `\n\n🌐 **Dashboard:** Live at ${serverInfo.url}`;
    }

    pi.sendMessage(
      { customType: "project-dashboard", content: brief, display: true },
      { triggerTurn: false }
    );

    // LLM context: project-level assets (brief hints for when to load)
    const assetsContext = formatAssetsContext(r.assets);
    if (assetsContext) {
      pi.sendMessage(
        { customType: "project-assets", content: assetsContext, display: false },
        { triggerTurn: false }
      );
    }
  });

  // --- Per-turn steering: workflow policy + status on every agent start ---
  pi.on("before_agent_start", async (_event, _ctx) => {
    try {
      const r = load();
      const lines: string[] = [];

      // Always inject current issue status line
      const inProgressIssue = r.issues.find(i => i.status === "in-progress");
      if (inProgressIssue) {
        lines.push(`📍 Current: [${inProgressIssue.id}] ${inProgressIssue.title} (in-progress)`);
      } else {
        const openIssues = r.issues.filter(i => i.status !== "closed");
        if (openIssues.length) {
          lines.push(`⚠️ No issue in-progress — advance one with \`issue_advance\` before doing any file changes.`);
        }
      }

      // Always inject workflow policy
      lines.push(`[WORKFLOW POLICY] Issue lifecycle: draft→researched→ready→in-progress→closed. You MUST NOT write files, edit code, or run write commands unless an issue is in "in-progress" status. Advance it first with \`issue_advance\`.`);

      // Epic steering (only when epic is in-progress)
      const active = activeEpics(r);
      const epic = nextEpic(active);
      if (epic && epic.status === "in-progress") {
        const focus = resolveEpicFocus(epic, r.issues);
        if (focus) {
          const openCount = r.issues.filter(i => i.epicId === epic.id && i.status !== "closed").length;
          const todosDone = epic.todos.filter(t => t.done).length;
          lines.push(`[PROJECT] Epic: [${epic.id}] ${epic.title} (${openCount} open issues, todos: ${todosDone}/${epic.todos.length})`);

          switch (focus.type) {
            case "in-progress": {
              const cur = focus.issue!;
              const vtype = cur.autoValidation?.type;
              let hint = "";
              if (vtype === "agent") hint = ` — verify: ${cur.autoValidation!.strategy}`;
              else if (vtype === "human") hint = ` — ⛔ requires user validation`;
              lines.push(`→ IN PROGRESS: [${cur.id}] ${cur.title}${hint}`);
              break;
            }
            case "ready": {
              const rq = (focus.issue!.questions || []).filter((q: any) => !q.answer && q.required !== false);
              if (rq.length) {
                lines.push(`→ NEXT: [${focus.issue!.id}] ${focus.issue!.title} — ⚠️ ${rq.length} required question(s) must be answered first (use \`issue_question\`)`);
              } else {
                lines.push(`→ NEXT: [${focus.issue!.id}] ${focus.issue!.title} — advance to in-progress first`);
              }
              break;
            }
            case "todo":
              lines.push(`→ TODO: ${focus.todoText}`);
              break;
            case "researched":
              lines.push(`→ ADVANCE: [${focus.issue!.id}] ${focus.issue!.title} — advance to ready`);
              break;
            case "draft":
              lines.push(`→ RESEARCH: [${focus.issue!.id}] ${focus.issue!.title} — needs research`);
              break;
            case "close-epic":
              lines.push(`→ All done — close epic with \`epic_close\``);
              break;
          }
        }
      }

      // Unassigned bugs — always listed (urgent regardless of epic), unless config disables it
      const bugsInSteering = getConfigValue<boolean>(r, "context.unassigned_bugs_in_steering");
      const unassignedBugs = r.issues.filter(i => !i.epicId && i.status !== "closed" && i.type === "bug");
      if (bugsInSteering && unassignedBugs.length) {
        lines.push(`[UNASSIGNED BUGS] ${unassignedBugs.length} bug(s) need attention: ${unassignedBugs.map(i => `[${i.id}] ${i.title} (${i.status})`).join(", ")}`);
      }

      // Other unassigned issues — count only, don't pollute context
      const unassignedOther = r.issues.filter(i => !i.epicId && i.status !== "closed" && i.type !== "bug");
      if (unassignedOther.length) {
        const byType: Record<string, number> = {};
        for (const i of unassignedOther) byType[i.type] = (byType[i.type] || 0) + 1;
        const summary = Object.entries(byType).map(([t, c]) => `${c} ${t}(s)`).join(", ");
        lines.push(`[UNASSIGNED] ${summary} in parking lot — assign to an epic before working on them (use \`issue_list\` with \`unassigned: true\`)`);
      }

      const serverInfo = getServerInfo();
      if (serverInfo) {
        lines.push(`[DASHBOARD] Live dashboard running at ${serverInfo.url}`);
      }

      return {
        message: {
          customType: "project-steering",
          content: lines.join("\n"),
          display: false,
        },
      };
    } catch {}
  });

  // --- Wrap registerTool to add default markdown rendering ---
  const origRegisterTool = pi.registerTool.bind(pi);
  pi.registerTool = (def: any) => {
    if (!def.renderResult) {
      def.renderResult = (result: any, { expanded, isPartial }: any, theme: any) => {
        const text = result.content?.[0]?.text ?? "";
        if (!text) return new Text("", 0, 0);
        // Short single-line results: plain text. Multi-line or markdown: render as markdown.
        const hasMarkdown = /[#*`>|]/.test(text) && (text.includes("\n") || text.includes("**"));
        if (!hasMarkdown) return new Text(text, 0, 0);
        return new Markdown(text, 0, 0, getMarkdownTheme());
      };
    }
    return origRegisterTool(def);
  };

  // --- Re-adopt dashboard server from previous session ---
  initFromLock().catch(() => {});

  // --- Register tools ---
  registerEpicTools(pi);
  registerIssueTools(pi);
  registerNextWork(pi);
  registerAssetTools(pi);
  registerToolDocsTool(pi);
  registerDashboard(pi);
  registerCommands(pi);
}
