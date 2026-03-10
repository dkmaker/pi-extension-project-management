import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { matchesKey, Key, truncateToWidth, visibleWidth, type Component, CURSOR_MARKER, type Focusable } from "@mariozechner/pi-tui";
import { load, activeEpics, nextEpic } from "./store.js";
import { formatBrief, formatIssue, formatAssetsContext } from "./format.js";
import { resolveEpicFocus } from "./priorities.js";
import { ISSUE_TYPE_ICON } from "./constants.js";
import { startServer, stopServer, isServerRunning } from "./dashboard-server.js";
import { CONFIG_REGISTRY, getConfig, setConfigValue, resetConfigKey, resetAllConfig, type ConfigEntry } from "./config.js";

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

  pi.registerCommand("project-serve", {
    description: "Start a live-updating web dashboard for the project",
    handler: async (_args, ctx) => {
      try {
        const result = await startServer();
        ctx.ui.notify(
          `🌐 Dashboard running at ${result.url}\nProject ID: ${result.projectId}\nPress Ctrl+C or run /project-serve-stop to stop.`,
          "info"
        );
      } catch (e: any) {
        ctx.ui.notify(`❌ Failed to start dashboard: ${e.message}`, "error");
      }
    },
  });

  pi.registerCommand("project-serve-stop", {
    description: "Stop the project dashboard web server",
    handler: async (_args, ctx) => {
      if (stopServer()) {
        ctx.ui.notify("🛑 Dashboard server stopped.", "info");
      } else {
        ctx.ui.notify("No dashboard server is running.", "warn");
      }
    },
  });

  pi.registerCommand("project-config", {
    description: "View and toggle project manager config settings",
    handler: async (_args, ctx) => {
      await ctx.ui.custom<void>(
        (tui, theme, _keybindings, done) => new ConfigWidget(theme, done),
        { overlay: true, overlayOptions: { width: "70%", minWidth: 60, maxHeight: "80%", anchor: "center" } }
      );
    },
  });
}

// --- /config TUI widget ---

class ConfigWidget implements Component, Focusable {
  focused = false;

  private selected = 0;
  private editingIndex: number | null = null;
  private editBuffer = "";
  private editCursorPos = 0; // cursor position within editBuffer
  private message = "";
  private cachedLines?: string[];
  private cachedWidth?: number;

  constructor(private theme: any, private done: (v: void) => void) {}

  private getEntries(): { entry: ConfigEntry; value: unknown }[] {
    const r = load();
    const cfg = getConfig(r);
    return CONFIG_REGISTRY.map(entry => ({ entry, value: cfg[entry.key] }));
  }

  handleInput(data: string): void {
    const entries = this.getEntries();

    // Editing a string value
    if (this.editingIndex !== null) {
      const entry = entries[this.editingIndex].entry;
      if (matchesKey(data, Key.enter)) {
        const err = setConfigValue(entry.key, this.editBuffer);
        this.message = err ? `❌ ${err}` : `✅ Saved`;
        this.editingIndex = null;
        this.editBuffer = "";
        this.editCursorPos = 0;
        this.invalidate();
        return;
      }
      if (matchesKey(data, Key.escape)) {
        this.editingIndex = null;
        this.editBuffer = "";
        this.editCursorPos = 0;
        this.message = "Cancelled";
        this.invalidate();
        return;
      }
      if (matchesKey(data, Key.backspace)) {
        if (this.editCursorPos > 0) {
          this.editBuffer = this.editBuffer.slice(0, this.editCursorPos - 1) + this.editBuffer.slice(this.editCursorPos);
          this.editCursorPos--;
          this.invalidate();
        }
        return;
      }
      if (matchesKey(data, Key.left)) {
        if (this.editCursorPos > 0) { this.editCursorPos--; this.invalidate(); }
        return;
      }
      if (matchesKey(data, Key.right)) {
        if (this.editCursorPos < this.editBuffer.length) { this.editCursorPos++; this.invalidate(); }
        return;
      }
      // Printable character
      if (data.length === 1 && data >= " ") {
        this.editBuffer = this.editBuffer.slice(0, this.editCursorPos) + data + this.editBuffer.slice(this.editCursorPos);
        this.editCursorPos++;
        this.invalidate();
      }
      return;
    }

    // Normal navigation
    if (matchesKey(data, Key.up) && this.selected > 0) {
      this.selected--;
      this.message = "";
      this.invalidate();
    } else if (matchesKey(data, Key.down) && this.selected < entries.length - 1) {
      this.selected++;
      this.message = "";
      this.invalidate();
    } else if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
      this.done();
    } else if (matchesKey(data, Key.enter) || matchesKey(data, Key.space)) {
      this.activate(entries, this.selected);
    } else if (data === "r" || data === "R") {
      const entry = entries[this.selected].entry;
      const err = resetConfigKey(entry.key);
      this.message = err ? `❌ ${err}` : `↩ Reset to default`;
      this.invalidate();
    } else if (data === "R" || (data === "r" && matchesKey(data, Key.shift("r")))) {
      // handled above
    } else if (matchesKey(data, Key.ctrl("r"))) {
      resetAllConfig();
      this.message = "↩ All settings reset to defaults";
      this.invalidate();
    }
  }

  private activate(entries: { entry: ConfigEntry; value: unknown }[], idx: number): void {
    const { entry, value } = entries[idx];
    if (entry.type === "bool") {
      const err = setConfigValue(entry.key, !value);
      this.message = err ? `❌ ${err}` : `✅ Saved`;
      this.invalidate();
    } else if (entry.type === "select") {
      const opts = (entry as any).options as string[];
      const cur = opts.indexOf(value as string);
      const next = opts[(cur + 1) % opts.length];
      const err = setConfigValue(entry.key, next);
      this.message = err ? `❌ ${err}` : `✅ Saved`;
      this.invalidate();
    } else if (entry.type === "string") {
      this.editingIndex = idx;
      this.editBuffer = (value as string) ?? "";
      this.editCursorPos = this.editBuffer.length;
      this.message = "Edit value — Enter to save, Esc to cancel";
      this.invalidate();
    }
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

    const t = this.theme;
    const entries = this.getEntries();
    const lines: string[] = [];

    // Header
    const title = " ⚙ Project Config ";
    const pad = Math.max(0, width - visibleWidth(title));
    lines.push(truncateToWidth(t.fg("accent", title) + " ".repeat(pad), width));
    lines.push(t.fg("dim", "─".repeat(width)));

    // Group by prefix
    let lastGroup = "";
    for (let i = 0; i < entries.length; i++) {
      const { entry, value } = entries[i];
      const [group] = entry.key.split(".");
      if (group !== lastGroup) {
        if (i > 0) lines.push("");
        lines.push(t.fg("dim", ` ${group}`));
        lastGroup = group;
      }

      const isSelected = i === this.selected;
      const isEditing = this.editingIndex === i;
      const prefix = isSelected ? t.fg("accent", " ▶ ") : "   ";

      // Value rendering
      let valueStr: string;
      if (isEditing) {
        const before = this.editBuffer.slice(0, this.editCursorPos);
        const at = this.editBuffer[this.editCursorPos] ?? " ";
        const after = this.editBuffer.slice(this.editCursorPos + 1);
        valueStr = `[${before}${CURSOR_MARKER}\x1b[7m${at}\x1b[27m${after}]`;
      } else if (entry.type === "bool") {
        valueStr = value ? t.fg("success", "✓ on ") : t.fg("error", "✗ off");
      } else if (entry.type === "select") {
        const opts = (entry as any).options as string[];
        const parts = opts.map((o: string) => o === value ? t.fg("accent", `[${o}]`) : t.fg("dim", o));
        valueStr = parts.join(t.fg("dim", " / "));
      } else {
        valueStr = t.fg("text", `"${value}"`);
      }

      // Row: prefix + label + dots + value
      const labelText = entry.label;
      const descText = isSelected ? t.fg("dim", ` — ${entry.description}`) : "";

      const rowLeft = `${prefix}${isSelected ? t.fg("text", labelText) : t.fg("dim", labelText)}`;
      const rowRight = `  ${valueStr}`;

      const leftLen = visibleWidth(rowLeft);
      const rightLen = visibleWidth(rowRight);
      const dotsLen = Math.max(1, width - leftLen - rightLen - visibleWidth(descText));
      const dots = t.fg("dim", ".".repeat(dotsLen));

      const row = truncateToWidth(`${rowLeft}${dots}${rowRight}${descText}`, width);
      lines.push(isSelected ? row : row);
    }

    // Footer
    lines.push("");
    lines.push(t.fg("dim", "─".repeat(width)));
    const help = this.editingIndex !== null
      ? " Enter:save  Esc:cancel  ←/→:cursor"
      : " ↑↓:navigate  Enter/Space:toggle  r:reset  Ctrl+R:reset all  Esc:close";
    lines.push(truncateToWidth(t.fg("dim", help), width));

    if (this.message) {
      lines.push(truncateToWidth(t.fg("warning", ` ${this.message}`), width));
    }

    this.cachedLines = lines;
    this.cachedWidth = width;
    return lines;
  }

  invalidate(): void {
    this.cachedLines = undefined;
    this.cachedWidth = undefined;
  }
}
