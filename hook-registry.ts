import type { ProjectFile } from "./types.js";
import { isDebugEnabled, logEntry, getTurn } from "./debug-log.js";
import { getConfigValue } from "./config.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type HookEvent = "tool_result" | "before_tool_call";

export interface HookState {
  store: ProjectFile;
  toolName: string;
  toolInput?: any;
  toolContent?: any[];
  extra?: Record<string, any>;
  mode?: string;
}

export interface HookHelpers {
  sendMessage: (msg: any, opts?: any) => void;
  save: (store: ProjectFile) => void;
  refreshStatus: () => void;
}

interface BaseHook {
  id: string;
  label: string;
  event: HookEvent;
  condition: (state: HookState) => boolean;
  priority: number;
  modes?: string[];
}

export interface SideEffectHook extends BaseHook {
  kind: "side-effect";
  handler: (state: HookState, helpers: HookHelpers) => void;
}

export interface ResultModifierHook extends BaseHook {
  kind: "result-modifier";
  handler: (state: HookState) => { text: string } | undefined;
}

export type Hook = SideEffectHook | ResultModifierHook;

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const hooks: Hook[] = [];

export function registerHook(hook: Hook): void {
  hooks.push(hook);
}

export function listHooks(): ReadonlyArray<Hook> {
  return hooks;
}

export function clearHooks(): void {
  hooks.length = 0;
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

export interface DispatchResult {
  /** Augmented content text from result-modifier hooks (undefined if none fired) */
  resultText?: string;
  /** Debug: which hooks fired */
  fired: { id: string; label: string; kind: string }[];
  /** Debug: which hooks were skipped */
  skipped: { id: string; label: string; reason: string }[];
}

/**
 * Dispatch all matching hooks for a given event.
 * Side-effects run in priority order. First result-modifier with content wins.
 */
export function dispatch(
  event: HookEvent,
  state: HookState,
  helpers: HookHelpers,
): DispatchResult {
  const mode = state.mode || "normal";
  const fired: DispatchResult["fired"] = [];
  const skipped: DispatchResult["skipped"] = [];
  let resultText: string | undefined;

  const candidates = hooks
    .filter(h => h.event === event)
    .sort((a, b) => a.priority - b.priority);

  for (const hook of candidates) {
    // Mode filter
    if (hook.modes && hook.modes.length > 0 && !hook.modes.includes(mode)) {
      skipped.push({ id: hook.id, label: hook.label, reason: `mode "${mode}" not in [${hook.modes.join(", ")}]` });
      continue;
    }

    // Condition check
    let condResult: boolean;
    try {
      condResult = hook.condition(state);
    } catch {
      skipped.push({ id: hook.id, label: hook.label, reason: "condition threw" });
      continue;
    }

    if (!condResult) {
      skipped.push({ id: hook.id, label: hook.label, reason: "condition false" });
      continue;
    }

    // Execute
    try {
      if (hook.kind === "side-effect") {
        hook.handler(state, helpers);
        fired.push({ id: hook.id, label: hook.label, kind: hook.kind });
      } else {
        const result = hook.handler(state);
        fired.push({ id: hook.id, label: hook.label, kind: hook.kind });
        if (result && !resultText) {
          resultText = result.text;
        }
      }
    } catch {
      skipped.push({ id: hook.id, label: hook.label, reason: "handler threw" });
    }
  }

  // Debug logging
  if (isDebugEnabled()) {
    logEntry({
      turn: getTurn(),
      timestamp: new Date().toISOString(),
      source: "hook-registry",
      event,
      fired,
      skipped,
      output: resultText ? (() => {
        try {
          const verbose = getConfigValue<boolean>(state.store, "debug.verbose_log");
          if (verbose) return resultText;
        } catch {}
        return resultText!.length > 500 ? resultText!.slice(0, 500) + "…" : resultText;
      })() : undefined,
    });
  }

  return { resultText, fired, skipped };
}
