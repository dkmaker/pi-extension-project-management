import { registerRule, type ContextState } from "./context-engine.js";
import { formatBrief, formatAssetsContext } from "./format.js";
import { activeEpics, nextEpic } from "./store.js";
import { resolveEpicFocus } from "./priorities.js";
import { getConfigValue } from "./config.js";
import { getServerInfo } from "./dashboard-server.js";

// ---------------------------------------------------------------------------
// All context rules — registered at extension init
// ---------------------------------------------------------------------------

export function registerAllRules(): void {
  // =========================================================================
  // TOOL_RESULT rules
  // =========================================================================

  registerRule({
    id: "write-gate",
    label: "Write Gate — warn on file writes with no in-progress issue",
    channel: "tool_result",
    priority: 10,
    condition: (s) => {
      if (!s.toolName) return false;
      const writeGateEnabled = getConfigValue<boolean>(s.store, "workflow.write_gate");
      if (!writeGateEnabled) return false;
      // Check if this is a write operation
      const FILE_WRITE_TOOLS = new Set(["edit", "write"]);
      const BASH_WRITE_PATTERN = /(?:^|\s|&&|\|)(?:>|>>|tee\s|sed\s+-i|mv\s|cp\s|install\s|chmod\s|mkdir\s|rm\s|touch\s|cat\s+.*>)/;
      const isWrite = FILE_WRITE_TOOLS.has(s.toolName) ||
        (s.toolName === "bash" && BASH_WRITE_PATTERN.test(s.toolInput?.command || ""));
      if (!isWrite) return false;
      // Only fire if no issue is in-progress
      return !s.store.issues.some(i => i.status === "in-progress");
    },
    content: (s) => {
      const openIssues = s.store.issues.filter(i => i.status !== "closed");
      let hint = "";
      if (openIssues.length) {
        const active = activeEpics(s.store);
        const focusEpic = active.find(e => e.status === "in-progress");
        const focusIssue = (focusEpic
          ? s.store.issues.find(i => i.epicId === focusEpic.id && i.status !== "closed")
          : undefined) || openIssues[0];
        if (focusIssue) {
          hint = ` Next issue: [${focusIssue.id}] "${focusIssue.title}" (${focusIssue.status}) — advance it with \`issue_advance\` first.`;
        }
      }
      return `⚠️ WORKFLOW GATE: No issue is in-progress. File writes require an active issue.${hint}`;
    },
  });

  // =========================================================================
  // USER_DISPLAY rules (session_start)
  // =========================================================================

  registerRule({
    id: "session-dashboard",
    label: "Session start — project brief dashboard",
    channel: "user_display",
    priority: 10,
    condition: (s) => s.event === "session_start",
    content: (s) => {
      let brief = (s.store.epics.length || s.store.issues.length || s.store.assets.length)
        ? formatBrief(s.store)
        : "# 📦 Project Status\n\n*No epics, issues, or assets yet.* Use `epic_add`, `issue_add`, or `asset_add` to get started.";
      const serverInfo = s.extra?.serverInfo;
      if (serverInfo) {
        brief += `\n\n🌐 **Dashboard:** Live at ${serverInfo.url}`;
      }
      return brief;
    },
  });

  // =========================================================================
  // AGENT_CONTEXT rules
  // =========================================================================

  registerRule({
    id: "session-assets",
    label: "Session start — asset context hints",
    channel: "agent_context",
    priority: 10,
    condition: (s) => s.event === "session_start",
    content: (s) => formatAssetsContext(s.store.assets) || undefined,
  });

  registerRule({
    id: "status-line",
    label: "Per-turn current issue status",
    channel: "agent_context",
    priority: 10,
    condition: (s) => s.event === "before_agent_start",
    content: (s) => {
      const ip = s.store.issues.find(i => i.status === "in-progress");
      if (ip) {
        return `📍 Current: [${ip.id}] ${ip.title} (in-progress)`;
      }
      const open = s.store.issues.filter(i => i.status !== "closed");
      if (open.length) {
        return `⚠️ No issue in-progress — advance one with \`issue_advance\` before doing any file changes.`;
      }
      return undefined;
    },
  });

  registerRule({
    id: "workflow-policy",
    label: "Per-turn workflow policy injection",
    channel: "agent_context",
    priority: 15,
    condition: (s) => s.event === "before_agent_start",
    content: () =>
      `[WORKFLOW POLICY] Issue lifecycle: draft→researched→ready→in-progress→closed. You MUST NOT write files, edit code, or run write commands unless an issue is in "in-progress" status. Advance it first with \`issue_advance\`.`,
  });

  registerRule({
    id: "epic-steering",
    label: "Per-turn epic focus steering",
    channel: "agent_context",
    priority: 20,
    condition: (s) => {
      if (s.event !== "before_agent_start") return false;
      const active = activeEpics(s.store);
      const epic = nextEpic(active);
      return !!(epic && epic.status === "in-progress");
    },
    content: (s) => {
      const active = activeEpics(s.store);
      const epic = nextEpic(active)!;
      const focus = resolveEpicFocus(epic, s.store.issues);
      if (!focus) return undefined;

      const lines: string[] = [];
      const openCount = s.store.issues.filter(i => i.epicId === epic.id && i.status !== "closed").length;
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
      return lines.join("\n");
    },
  });

  registerRule({
    id: "unassigned-bugs",
    label: "Per-turn unassigned bugs alert",
    channel: "agent_context",
    priority: 30,
    condition: (s) => {
      if (s.event !== "before_agent_start") return false;
      const bugsInSteering = getConfigValue<boolean>(s.store, "context.unassigned_bugs_in_steering");
      if (!bugsInSteering) return false;
      return s.store.issues.some(i => !i.epicId && i.status !== "closed" && i.type === "bug");
    },
    content: (s) => {
      const bugs = s.store.issues.filter(i => !i.epicId && i.status !== "closed" && i.type === "bug");
      return `[UNASSIGNED BUGS] ${bugs.length} bug(s) need attention: ${bugs.map(i => `[${i.id}] ${i.title} (${i.status})`).join(", ")}`;
    },
  });

  registerRule({
    id: "unassigned-other",
    label: "Per-turn unassigned non-bug issues count",
    channel: "agent_context",
    priority: 35,
    condition: (s) => {
      if (s.event !== "before_agent_start") return false;
      return s.store.issues.some(i => !i.epicId && i.status !== "closed" && i.type !== "bug");
    },
    content: (s) => {
      const other = s.store.issues.filter(i => !i.epicId && i.status !== "closed" && i.type !== "bug");
      const byType: Record<string, number> = {};
      for (const i of other) byType[i.type] = (byType[i.type] || 0) + 1;
      const summary = Object.entries(byType).map(([t, c]) => `${c} ${t}(s)`).join(", ");
      return `[UNASSIGNED] ${summary} in parking lot — assign to an epic before working on them (use \`issue_list\` with \`unassigned: true\`)`;
    },
  });

  registerRule({
    id: "dashboard-url",
    label: "Per-turn dashboard URL",
    channel: "agent_context",
    priority: 40,
    condition: (s) => s.event === "before_agent_start" && !!s.extra?.serverInfo,
    content: (s) => `[DASHBOARD] Live dashboard running at ${s.extra!.serverInfo.url}`,
  });

  registerRule({
    id: "policy-trigger",
    label: "Asset policy trigger on tool events",
    channel: "agent_context",
    priority: 20,
    condition: (s) => s.event === "tool_result" && !!s.extra?.policyEvent,
    content: (s) => {
      const triggered = s.store.assets.filter(a => a.trigger?.event === s.extra!.policyEvent);
      if (!triggered.length) return undefined;
      return `## 📋 Triggered Policies\n\n${triggered.map(a => `**[Policy: ${a.title}]** ${a.body}`).join("\n\n")}`;
    },
  });
}
