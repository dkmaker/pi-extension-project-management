import type { ProjectFile } from "./types.js";
import { load, save } from "./store.js";

// --- Config types ---

export type ConfigType = "bool" | "string" | "select";

export interface ConfigEntryBool {
  type: "bool";
  key: string;
  label: string;
  description: string;
  default: boolean;
}

export interface ConfigEntryString {
  type: "string";
  key: string;
  label: string;
  description: string;
  default: string;
}

export interface ConfigEntrySelect {
  type: "select";
  key: string;
  label: string;
  description: string;
  default: string;
  options: string[];
}

export type ConfigEntry = ConfigEntryBool | ConfigEntryString | ConfigEntrySelect;

// --- Registry ---

export const CONFIG_REGISTRY: ConfigEntry[] = [
  // Workflow guards
  {
    type: "bool",
    key: "workflow.write_gate",
    label: "Write gate",
    description: "Block file writes when no issue is in-progress",
    default: true,
  },

  // Context verbosity
  {
    type: "select",
    key: "context.brief_verbosity",
    label: "Brief verbosity",
    description: "How much detail to inject into LLM context at session start",
    default: "normal",
    options: ["minimal", "normal", "verbose"],
  },
  {
    type: "bool",
    key: "context.unassigned_bugs_in_steering",
    label: "Unassigned bugs in steering",
    description: "Show unassigned bugs in per-turn steering context",
    default: true,
  },

  // Git integration — master switch
  {
    type: "bool",
    key: "git.enabled",
    label: "Git integration",
    description: "Master switch — enables all git workflow guards",
    default: false,
  },

  // Git — epic-level guards
  {
    type: "bool",
    key: "git.epics.auto_branch",
    label: "Auto-create epic branch",
    description: "Create a git branch (epic/{id}-{slug}) when an epic goes in-progress",
    default: true,
  },
  {
    type: "bool",
    key: "git.epics.merge_check_on_close",
    label: "Merge check on epic close",
    description: "Warn if the epic branch is not merged into default branch when closing",
    default: true,
  },

  // Git — issue-level guards
  {
    type: "bool",
    key: "git.issues.require_clean_worktree",
    label: "Require clean worktree",
    description: "Block issue start if the git worktree is dirty",
    default: true,
  },
  {
    type: "bool",
    key: "git.issues.require_epic_branch",
    label: "Require epic branch",
    description: "Block issue start if the parent epic's branch does not exist",
    default: true,
  },
  {
    type: "bool",
    key: "git.issues.require_commit_on_close",
    label: "Require commit on close",
    description: "Block issue close if no new commits exist since the issue was started",
    default: true,
  },
  {
    type: "bool",
    key: "git.issues.require_commit_id_on_close",
    label: "Require commit ID on close",
    description: "Block issue_close unless a valid commit SHA is provided",
    default: true,
  },

  // Issues — file traceability
  {
    type: "bool",
    key: "issues.capture_edited_files",
    label: "Capture edited files",
    description: "Auto-add files written/edited during an in-progress issue as references",
    default: false,
  },
  {
    type: "bool",
    key: "issues.require_file_change_notes",
    label: "Require file change notes",
    description: "Block issue close until each auto-captured file has a one-sentence change note",
    default: false,
  },

  // Research gating
  {
    type: "bool",
    key: "research.gated",
    label: "Gated research",
    description: "Require research notes or explicit justification before advancing issues past researched (enforces verified sources over pre-trained knowledge)",
    default: false,
  },

  // Dependencies
  {
    type: "bool",
    key: "workflow.enforce_dependencies",
    label: "Enforce dependencies",
    description: "Block advancing to in-progress when blocked-by issues are still open (default: off, purely informational)",
    default: false,
  },
];

// --- Debug config entries (conditionally added when PI_PM_DEBUG is set) ---

export function registerDebugConfigEntries(): void {
  CONFIG_REGISTRY.push(
    {
      type: "bool",
      key: "debug.show_agent_context",
      label: "Show agent context",
      description: "Display agent-only steering messages (display:false) as visible panels so users can see what the agent receives",
      default: false,
    },
    {
      type: "bool",
      key: "debug.show_hook_activity",
      label: "Show hook activity",
      description: "Show which hooks fired/skipped after each tool call as a visible message",
      default: false,
    },
    {
      type: "bool",
      key: "debug.show_context_rules",
      label: "Show context rules",
      description: "Show which context rules composed the current turn's steering as a visible message",
      default: false,
    },
    {
      type: "bool",
      key: "debug.verbose_log",
      label: "Verbose debug log",
      description: "Include full output text in debug log entries (vs truncated to 500 chars)",
      default: false,
    },
  );
}

// --- Accessors ---

/** Get the full resolved config (DB values merged over defaults). */
export function getConfig(r: ProjectFile): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const entry of CONFIG_REGISTRY) {
    const stored = r.config?.[entry.key];
    result[entry.key] = stored !== undefined ? stored : entry.default;
  }
  return result;
}

/** Get a single config value, resolved with default fallback. */
export function getConfigValue<T>(r: ProjectFile, key: string): T {
  const entry = CONFIG_REGISTRY.find((e) => e.key === key);
  if (!entry) throw new Error(`Unknown config key: ${key}`);
  const stored = r.config?.[key];
  return (stored !== undefined ? stored : entry.default) as T;
}

/** Set a config value and save. Returns error string or null on success. */
export function setConfigValue(key: string, value: unknown): string | null {
  const entry = CONFIG_REGISTRY.find((e) => e.key === key);
  if (!entry) return `Unknown config key: ${key}`;

  // Validate
  if (entry.type === "bool" && typeof value !== "boolean") return `Expected boolean for ${key}`;
  if (entry.type === "string" && typeof value !== "string") return `Expected string for ${key}`;
  if (entry.type === "select") {
    if (typeof value !== "string") return `Expected string for ${key}`;
    if (!entry.options.includes(value as string)) return `Invalid option '${value}' for ${key}. Valid: ${entry.options.join(", ")}`;
  }

  const r = load();
  if (!r.config) r.config = {};
  r.config[key] = value;
  save(r);
  return null;
}

/** Reset a single key to its default. */
export function resetConfigKey(key: string): string | null {
  const entry = CONFIG_REGISTRY.find((e) => e.key === key);
  if (!entry) return `Unknown config key: ${key}`;
  const r = load();
  if (!r.config) r.config = {};
  delete r.config[key];
  save(r);
  return null;
}

/** Reset all config to defaults. */
export function resetAllConfig(): void {
  const r = load();
  r.config = {};
  save(r);
}
