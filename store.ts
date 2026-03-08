import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import type { ProjectFile, Epic } from "./types.js";
import { CURRENT_VERSION } from "./types.js";
import { migrate } from "./migrations.js";

export function projectPath(): string {
  return join(process.cwd(), ".pi", "project", "database.json");
}

export function load(): ProjectFile {
  const p = projectPath();
  if (!existsSync(p)) return { version: CURRENT_VERSION, epics: [], issues: [], categories: [], assets: [] };
  const raw = JSON.parse(readFileSync(p, "utf-8"));
  const { data, migrated } = migrate(raw);
  // Auto-save if migrations were applied
  if (migrated) {
    writeFileSync(p, JSON.stringify(data, null, 2) + "\n", "utf-8");
  }
  return data;
}

export function save(r: ProjectFile): void {
  renumber(r);
  const p = projectPath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(r, null, 2) + "\n", "utf-8");
}

export function now(): string {
  return new Date().toISOString();
}

export function genId(): string {
  return Math.random().toString(36).slice(2, 10);
}

export function activeEpics(r: ProjectFile): Epic[] {
  return r.epics.filter((e) => e.status !== "closed").sort((a, b) => a.priority - b.priority);
}

export function nextEpic(active: Epic[]): Epic | undefined {
  return (
    active.find((e) => e.status === "in-progress") ||
    active.find((e) => e.status === "planned") ||
    active[0]
  );
}

function renumber(r: ProjectFile): void {
  r.epics.sort((a, b) => a.priority - b.priority);
  for (let i = 0; i < r.epics.length; i++) {
    r.epics[i].priority = i + 1;
  }
}
