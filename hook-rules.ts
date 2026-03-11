import { registerHook, type HookState, type HookHelpers } from "./hook-registry.js";
import { compose, type ContextState } from "./context-engine.js";
import { getConfigValue } from "./config.js";

// Map tool names to policy events
const TOOL_TO_EVENT: Record<string, string> = {
  epic_add: "epic_create",
  epic_close: "epic_close",
  epic_advance: "epic_advance",
  issue_add: "issue_create",
  issue_close: "issue_close",
  issue_advance: "issue_advance",
};

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

const FILE_WRITE_TOOLS = new Set(["edit", "write"]);

// ---------------------------------------------------------------------------
// All hook rules — registered at extension init
// ---------------------------------------------------------------------------

export function registerAllHooks(): void {

  // =========================================================================
  // Side-effect: Refresh status bar on project tool calls
  // =========================================================================
  registerHook({
    id: "refresh-status",
    label: "Refresh status bar + focus widget on project tool calls",
    event: "tool_result",
    kind: "side-effect",
    priority: 1, // run first
    condition: (s) => PROJECT_TOOLS.has(s.toolName),
    handler: (_s, helpers) => {
      helpers.refreshStatus();
    },
  });

  // =========================================================================
  // Result modifier: Write gate (bridges to Context Engine)
  // =========================================================================
  registerHook({
    id: "write-gate",
    label: "Write Gate — augment result with warning when no in-progress issue",
    event: "tool_result",
    kind: "result-modifier",
    priority: 10,
    condition: () => true, // Context Engine rule handles the real condition
    handler: (s) => {
      const state: ContextState = {
        store: s.store,
        event: "tool_result",
        toolName: s.toolName,
        toolInput: s.toolInput,
        toolContent: s.toolContent,
      };
      const result = compose("tool_result", state);
      if (result.text) {
        return { text: result.text };
      }
      return undefined;
    },
  });

  // =========================================================================
  // Side-effect: Auto-capture edited files as issue references
  // =========================================================================
  registerHook({
    id: "auto-capture-files",
    label: "Auto-capture edited file paths as issue references",
    event: "tool_result",
    kind: "side-effect",
    priority: 20,
    condition: (s) => FILE_WRITE_TOOLS.has(s.toolName) && !!s.toolInput?.path,
    handler: (s, helpers) => {
      if (!getConfigValue<boolean>(s.store, "issues.capture_edited_files")) return;
      const inProgressIssue = s.store.issues.find(i => i.status === "in-progress");
      if (!inProgressIssue) return;

      const filePath: string = s.toolInput.path;
      const autoTag = `[auto] ${filePath}`;
      const alreadyCaptured = inProgressIssue.research.some(
        n => n.type === "reference" && n.content === autoTag
      );
      if (!alreadyCaptured) {
        inProgressIssue.research.push({
          type: "reference",
          content: autoTag,
          addedAt: new Date().toISOString(),
        });
        helpers.save(s.store);
      }
    },
  });

  // =========================================================================
  // Side-effect: Policy triggers (bridges to Context Engine)
  // =========================================================================
  registerHook({
    id: "policy-trigger",
    label: "Fire asset policy triggers on tool events",
    event: "tool_result",
    kind: "side-effect",
    priority: 30,
    condition: (s) => !!TOOL_TO_EVENT[s.toolName],
    handler: (s, helpers) => {
      const policyEvent = TOOL_TO_EVENT[s.toolName];
      const state: ContextState = {
        store: s.store,
        event: "tool_result",
        extra: { policyEvent },
      };
      const result = compose("agent_context", state);
      if (result.text) {
        helpers.sendMessage(
          { customType: "policy-directive", content: result.text, display: false },
          { triggerTurn: false },
        );
      }
    },
  });
}
