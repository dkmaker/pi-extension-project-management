import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { listRules } from "./context-engine.js";
import { listHooks } from "./hook-registry.js";
import { getLog, clearLog, getLogSize, getTurn, type DebugLogFilter } from "./debug-log.js";

export function registerDebugTools(pi: ExtensionAPI): void {

  // =========================================================================
  // debug_rules — list all registered context rules and hooks
  // =========================================================================
  pi.registerTool({
    name: "debug_rules",
    description: "List all registered context rules and hook rules with IDs, labels, priorities, and modes. Only available when PI_PM_DEBUG is set.",
    parameters: {
      type: "object",
      properties: {
        source: {
          type: "string",
          enum: ["all", "context", "hooks"],
          description: "Filter by source (default: all)",
        },
      },
    },
    execute: async (params: any) => {
      const source = params?.source || "all";
      const lines: string[] = ["# 🔍 Debug: Registered Rules\n"];

      if (source === "all" || source === "context") {
        const rules = listRules();
        lines.push(`## Context Engine Rules (${rules.length})\n`);
        lines.push("| Priority | ID | Label | Channel | Modes |");
        lines.push("|----------|----|-------|---------|-------|");
        for (const r of [...rules].sort((a, b) => a.priority - b.priority)) {
          lines.push(`| ${r.priority} | \`${r.id}\` | ${r.label} | ${r.channel} | ${r.modes?.join(", ") || "all"} |`);
        }
        lines.push("");
      }

      if (source === "all" || source === "hooks") {
        const hooks = listHooks();
        lines.push(`## Hook Registry Rules (${hooks.length})\n`);
        lines.push("| Priority | ID | Label | Event | Kind | Modes |");
        lines.push("|----------|----|-------|-------|------|-------|");
        for (const h of [...hooks].sort((a, b) => a.priority - b.priority)) {
          lines.push(`| ${h.priority} | \`${h.id}\` | ${h.label} | ${h.event} | ${h.kind} | ${h.modes?.join(", ") || "all"} |`);
        }
        lines.push("");
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  });

  // =========================================================================
  // debug_log — show recent debug log entries
  // =========================================================================
  pi.registerTool({
    name: "debug_log",
    description: "Show debug log entries from context engine and hook registry. Filter by source, turn, rule ID, or last N entries. Only available when PI_PM_DEBUG is set.",
    parameters: {
      type: "object",
      properties: {
        source: {
          type: "string",
          enum: ["context-engine", "hook-registry"],
          description: "Filter by source",
        },
        turn: {
          type: "number",
          description: "Filter by turn number",
        },
        rule_id: {
          type: "string",
          description: "Filter entries where this rule ID fired or was skipped",
        },
        last: {
          type: "number",
          description: "Show only the last N entries (default: 20)",
        },
      },
    },
    execute: async (params: any) => {
      const filter: DebugLogFilter = {};
      if (params?.source) filter.source = params.source;
      if (params?.turn !== undefined) filter.turn = params.turn;
      if (params?.rule_id) filter.ruleId = params.rule_id;
      filter.last = params?.last || 20;

      const entries = getLog(filter);
      const lines: string[] = [
        `# 🔍 Debug Log (${entries.length} entries, turn ${getTurn()}, ${getLogSize()} total in buffer)\n`,
      ];

      if (!entries.length) {
        lines.push("*No matching entries.*");
      } else {
        for (const e of entries) {
          lines.push(`### Turn ${e.turn} — ${e.source}${e.channel ? ` [${e.channel}]` : ""}${e.event ? ` (${e.event})` : ""}`);
          lines.push(`*${e.timestamp}*\n`);

          if (e.fired.length) {
            lines.push(`**Fired:** ${e.fired.map(f => `\`${f.id}\`${f.kind ? ` (${f.kind})` : ""}`).join(", ")}`);
          }
          if (e.skipped.length) {
            const summary = e.skipped.slice(0, 5).map(s => `\`${s.id}\`: ${s.reason}`).join(", ");
            const extra = e.skipped.length > 5 ? ` +${e.skipped.length - 5} more` : "";
            lines.push(`**Skipped:** ${summary}${extra}`);
          }
          if (e.output) {
            lines.push(`\n\`\`\`\n${e.output}\n\`\`\`\n`);
          }
          lines.push("---");
        }
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  });

  // =========================================================================
  // debug_clear — clear the debug log
  // =========================================================================
  pi.registerTool({
    name: "debug_clear",
    description: "Clear the debug log buffer and reset turn counter. Only available when PI_PM_DEBUG is set.",
    parameters: { type: "object", properties: {} },
    execute: async () => {
      const size = getLogSize();
      clearLog();
      return { content: [{ type: "text", text: `🗑️ Debug log cleared (${size} entries removed, turn counter reset)` }] };
    },
  });

  // =========================================================================
  // debug_context — show last compose output per channel
  // =========================================================================
  pi.registerTool({
    name: "debug_context",
    description: "Show the most recent context engine output for each channel (agent_context, user_display, tool_result). Useful for seeing exactly what the agent received last turn. Only available when PI_PM_DEBUG is set.",
    parameters: { type: "object", properties: {} },
    execute: async () => {
      const entries = getLog({ source: "context-engine" });
      const byChannel: Record<string, typeof entries[number]> = {};

      // Get the latest entry per channel
      for (const e of entries) {
        if (e.channel) {
          byChannel[e.channel] = e;
        }
      }

      const lines: string[] = [`# 🔍 Debug: Latest Context Per Channel (turn ${getTurn()})\n`];

      if (!Object.keys(byChannel).length) {
        lines.push("*No context entries logged yet.*");
      } else {
        for (const [channel, entry] of Object.entries(byChannel)) {
          lines.push(`## ${channel} (turn ${entry.turn})`);
          lines.push(`**Fired:** ${entry.fired.map(f => `\`${f.id}\``).join(", ") || "none"}`);
          if (entry.output) {
            lines.push(`\n\`\`\`\n${entry.output}\n\`\`\`\n`);
          } else {
            lines.push("*(empty output)*\n");
          }
        }
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  });
}
