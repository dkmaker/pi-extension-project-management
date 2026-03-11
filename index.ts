import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { getMarkdownTheme } from "@mariozechner/pi-coding-agent";
import { Markdown, Text, visibleWidth, truncateToWidth } from "@mariozechner/pi-tui";
import { load, save } from "./store.js";
import { statusBarText, focusWidgetData, renderFocusLine } from "./format.js";
import { registerEpicTools } from "./epics.js";
import { registerIssueTools } from "./issues.js";
import { registerNextWork } from "./next-work.js";
import { registerAssetTools } from "./assets.js";
import { registerToolDocsTool } from "./tool-docs.js";
import { registerDashboard } from "./dashboard.js";
import { registerCommands } from "./commands.js";
import { getServerInfo, initFromLock } from "./dashboard-server.js";
import { compose, type ContextState } from "./context-engine.js";
import { registerAllRules } from "./context-rules.js";
import { dispatch, type HookHelpers } from "./hook-registry.js";
import { registerAllHooks } from "./hook-rules.js";
import { enableDebug, isDebugEnabled, nextTurn } from "./debug-log.js";
import { registerDebugTools } from "./debug-tools.js";
import { registerDebugConfigEntries, getConfigValue } from "./config.js";

export default function (pi: ExtensionAPI) {
  // --- Register all context rules and hooks ---
  registerAllRules();
  registerAllHooks();

  // --- ENV-gated debug mode ---
  if (process.env.PI_PM_DEBUG) {
    enableDebug();
    registerDebugConfigEntries();
    registerDebugTools(pi);

    // Wrap sendMessage to show agent-only messages when debug.show_agent_context is enabled
    const origSendMessage = pi.sendMessage.bind(pi);
    pi.sendMessage = (msg: any, opts?: any) => {
      origSendMessage(msg, opts);
      // If this is an agent-only message, duplicate as visible debug panel
      if (msg && msg.display === false) {
        try {
          const r = load();
          if (getConfigValue<boolean>(r, "debug.show_agent_context")) {
            origSendMessage(
              { customType: "debug-mirror", content: `🔍 **Agent-only [${msg.customType || "unknown"}]:**\n\`\`\`\n${msg.content}\n\`\`\``, display: true },
              { triggerTurn: false },
            );
          }
        } catch {}
      }
    };
  }

  // --- Status bar ---
  function refreshStatus(ctx?: any) {
    try {
      const r = load();
      const uiCtx = ctx || lastCtx;
      if (!uiCtx) return;
      const debugBadge = isDebugEnabled() ? uiCtx.ui.theme.fg("warning", " 🔍 DEBUG") : "";
      uiCtx.ui.setStatus("project", statusBarText(r, uiCtx.ui.theme) + debugBadge);

      const data = focusWidgetData(r);
      if (data) {
        uiCtx.ui.setWidget("project-focus", (_tui: any, theme: any) => {
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
        uiCtx.ui.setWidget("project-focus", undefined);
      }
    } catch {}
  }

  // Track last ctx for hooks that need UI access
  let lastCtx: any;

  // Hook helpers — bridge between Hook Registry and pi API
  function makeHelpers(): HookHelpers {
    return {
      sendMessage: (msg, opts) => pi.sendMessage(msg, opts),
      save: (store) => save(store),
      refreshStatus: () => refreshStatus(),
    };
  }

  // --- Tool result: delegate to Hook Registry ---
  pi.on("tool_result", async (event, ctx) => {
    lastCtx = ctx;

    const r = load();
    const result = dispatch("tool_result", {
      store: r,
      toolName: event.toolName,
      toolInput: event.input,
      toolContent: event.content,
    }, makeHelpers());

    // Debug: show hook activity as visible message
    if (isDebugEnabled() && result.fired.length) {
      try {
        const r2 = load();
        if (getConfigValue<boolean>(r2, "debug.show_hook_activity")) {
          const firedList = result.fired.map(f => `\`${f.id}\` (${f.kind})`).join(", ");
          pi.sendMessage(
            { customType: "debug-hooks", content: `🔍 **Hooks fired:** ${firedList}`, display: true },
            { triggerTurn: false },
          );
        }
      } catch {}
    }

    // If any result-modifier fired, augment the tool result
    if (result.resultText) {
      return {
        content: [
          ...(event.content || []),
          { type: "text", text: `\n\n${result.resultText}` },
        ],
      };
    }
  });

  // --- Session start: via Context Engine ---
  pi.on("session_start", async (_event, ctx) => {
    lastCtx = ctx;
    refreshStatus(ctx);

    const alreadyDone = ctx.sessionManager.getEntries().some(
      (e) => e.type === "custom" && (e as any).customType === "project-init"
    );
    if (alreadyDone) return;

    const r = load();
    pi.appendEntry("project-init", { ts: Date.now() });

    const serverInfo = getServerInfo();
    const state: ContextState = {
      store: r,
      event: "session_start",
      extra: { serverInfo },
    };

    const dashboard = compose("user_display", state);
    if (dashboard.text) {
      const debugBanner = isDebugEnabled()
        ? "\n\n> 🔍 **DEBUG MODE ACTIVE** — `PI_PM_DEBUG` is set. Debug tools (`debug_rules`, `debug_log`, `debug_clear`, `debug_context`) are available. All context/hook activity is being logged."
        : "";
      pi.sendMessage(
        { customType: "project-dashboard", content: dashboard.text + debugBanner, display: true },
        { triggerTurn: false },
      );
    }

    const agentCtx = compose("agent_context", state);
    if (agentCtx.text) {
      pi.sendMessage(
        { customType: "project-assets", content: agentCtx.text, display: false },
        { triggerTurn: false },
      );
    }
  });

  // --- Per-turn steering: via Context Engine ---
  pi.on("before_agent_start", async (_event, _ctx) => {
    if (isDebugEnabled()) nextTurn();
    try {
      const r = load();
      const serverInfo = getServerInfo();
      const state: ContextState = {
        store: r,
        event: "before_agent_start",
        extra: { serverInfo },
      };

      const result = compose("agent_context", state);
      if (result.text) {
        // Debug: show which context rules fired
        if (isDebugEnabled()) {
          if (getConfigValue<boolean>(r, "debug.show_context_rules")) {
            const firedList = result.fired.map(f => `\`${f.id}\``).join(", ");
            const skippedList = result.skipped.map(s => `\`${s.id}\``).join(", ");
            pi.sendMessage(
              { customType: "debug-context-rules", content: `🔍 **Context rules fired:** ${firedList}\n**Skipped:** ${skippedList}`, display: true },
              { triggerTurn: false },
            );
          }
          // Debug: show agent-only context as visible
          if (getConfigValue<boolean>(r, "debug.show_agent_context")) {
            pi.sendMessage(
              { customType: "debug-agent-context", content: `🔍 **Agent receives:**\n\`\`\`\n${result.text}\n\`\`\``, display: true },
              { triggerTurn: false },
            );
          }
        }

        return {
          message: {
            customType: "project-steering",
            content: result.text,
            display: false,
          },
        };
      }
    } catch {}
  });

  // --- Wrap registerTool to add default markdown rendering ---
  const origRegisterTool = pi.registerTool.bind(pi);
  pi.registerTool = (def: any) => {
    if (!def.renderResult) {
      def.renderResult = (result: any, { expanded, isPartial }: any, theme: any) => {
        const text = result.content?.[0]?.text ?? "";
        if (!text) return new Text("", 0, 0);
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
