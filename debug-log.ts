// ---------------------------------------------------------------------------
// Debug Log — in-memory circular buffer for context/hook introspection
// ---------------------------------------------------------------------------

export interface DebugEntry {
  turn: number;
  timestamp: string;
  source: "context-engine" | "hook-registry";
  channel?: string;
  event?: string;
  fired: { id: string; label: string; kind?: string }[];
  skipped: { id: string; label: string; reason: string }[];
  output?: string;
}

const MAX_ENTRIES = 200;
const log: DebugEntry[] = [];
let currentTurn = 0;
let enabled = false;

export function isDebugEnabled(): boolean {
  return enabled;
}

export function enableDebug(): void {
  enabled = true;
}

export function disableDebug(): void {
  enabled = false;
}

export function getTurn(): number {
  return currentTurn;
}

export function nextTurn(): number {
  return ++currentTurn;
}

export function logEntry(entry: DebugEntry): void {
  if (!enabled) return;
  log.push(entry);
  if (log.length > MAX_ENTRIES) {
    log.splice(0, log.length - MAX_ENTRIES);
  }
}

export interface DebugLogFilter {
  source?: "context-engine" | "hook-registry";
  turn?: number;
  ruleId?: string;
  last?: number;
}

export function getLog(filter?: DebugLogFilter): ReadonlyArray<DebugEntry> {
  let results: DebugEntry[] = log;

  if (filter?.source) {
    results = results.filter(e => e.source === filter.source);
  }
  if (filter?.turn !== undefined) {
    results = results.filter(e => e.turn === filter.turn);
  }
  if (filter?.ruleId) {
    const id = filter.ruleId;
    results = results.filter(e =>
      e.fired.some(f => f.id === id) || e.skipped.some(s => s.id === id)
    );
  }
  if (filter?.last) {
    results = results.slice(-filter.last);
  }

  return results;
}

export function clearLog(): void {
  log.length = 0;
  currentTurn = 0;
}

export function getLogSize(): number {
  return log.length;
}
