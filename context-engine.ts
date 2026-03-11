import type { ProjectFile, Epic, Issue } from "./types.js";
import { isDebugEnabled, logEntry, getTurn } from "./debug-log.js";
import { getConfigValue } from "./config.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ContextChannel = "tool_result" | "agent_context" | "user_display";

export interface ContextState {
  store: ProjectFile;
  /** Which pi event triggered this compose (e.g. "before_agent_start", "session_start", "tool_result") */
  event?: string;
  /** For tool_result rules */
  toolName?: string;
  toolInput?: any;
  toolContent?: any[];
  /** Pre-resolved helpers (set by caller to avoid re-querying) */
  inProgressIssue?: Issue;
  focusEpic?: Epic;
  /** Current mode */
  mode?: string;
  /** Extra context (e.g. server info) */
  extra?: Record<string, any>;
}

export interface ContextRule {
  /** Unique rule identifier */
  id: string;
  /** Human-readable label for debug output */
  label: string;
  /** Which output channel this rule targets */
  channel: ContextChannel;
  /** Return true if this rule should fire for the given state */
  condition: (state: ContextState) => boolean;
  /** Produce the context string (only called when condition passes) */
  content: (state: ContextState) => string | undefined;
  /** Lower number = higher priority (rendered first). Default: 50 */
  priority: number;
  /** If set, rule only fires in these modes. Empty/undefined = all modes */
  modes?: string[];
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const rules: ContextRule[] = [];

export function registerRule(rule: ContextRule): void {
  rules.push(rule);
}

export function listRules(): ReadonlyArray<ContextRule> {
  return rules;
}

export function clearRules(): void {
  rules.length = 0;
}

// ---------------------------------------------------------------------------
// Composer
// ---------------------------------------------------------------------------

export interface ComposeResult {
  /** The composed text (all matching rules joined) */
  text: string;
  /** Which rules fired, in order */
  fired: { id: string; label: string; priority: number }[];
  /** Which rules were evaluated but didn't match */
  skipped: { id: string; label: string; reason: string }[];
}

/**
 * Evaluate all registered rules for a given channel + state.
 * Returns composed text and debug metadata.
 */
export function compose(channel: ContextChannel, state: ContextState): ComposeResult {
  const mode = state.mode || "normal";
  const fired: ComposeResult["fired"] = [];
  const skipped: ComposeResult["skipped"] = [];
  const parts: string[] = [];

  // Filter to channel, then sort by priority
  const candidates = rules
    .filter(r => r.channel === channel)
    .sort((a, b) => a.priority - b.priority);

  for (const rule of candidates) {
    // Mode filter
    if (rule.modes && rule.modes.length > 0 && !rule.modes.includes(mode)) {
      skipped.push({ id: rule.id, label: rule.label, reason: `mode "${mode}" not in [${rule.modes.join(", ")}]` });
      continue;
    }

    // Condition check
    let condResult: boolean;
    try {
      condResult = rule.condition(state);
    } catch {
      skipped.push({ id: rule.id, label: rule.label, reason: "condition threw" });
      continue;
    }

    if (!condResult) {
      skipped.push({ id: rule.id, label: rule.label, reason: "condition false" });
      continue;
    }

    // Generate content
    try {
      const text = rule.content(state);
      if (text) {
        parts.push(text);
        fired.push({ id: rule.id, label: rule.label, priority: rule.priority });
      } else {
        skipped.push({ id: rule.id, label: rule.label, reason: "content returned empty" });
      }
    } catch {
      skipped.push({ id: rule.id, label: rule.label, reason: "content threw" });
    }
  }

  const text = parts.join("\n");

  // Debug logging
  if (isDebugEnabled()) {
    logEntry({
      turn: getTurn(),
      timestamp: new Date().toISOString(),
      source: "context-engine",
      channel,
      event: state.event,
      fired,
      skipped,
      output: (() => {
        try {
          const verbose = getConfigValue<boolean>(state.store, "debug.verbose_log");
          if (verbose) return text;
        } catch {}
        return text.length > 500 ? text.slice(0, 500) + "…" : text;
      })(),
    });
  }

  return { text, fired, skipped };
}
