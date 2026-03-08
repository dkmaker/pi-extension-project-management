/**
 * dashboard — Interactive project dashboard widget
 *
 * Toggled via /project-dashboard command.
 * Uses ctx.ui.custom() overlay with proper keyboard handling.
 * Press Enter on an issue/epic to open a scrollable detail view.
 */

import type { ExtensionAPI, ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { matchesKey, visibleWidth, type Focusable } from "@mariozechner/pi-tui";
import { load } from "./store.js";
import type { ProjectFile, Epic, Issue, Asset, ResearchNote } from "./types.js";
import { EPIC_STATUS_ICON as EPIC_ICON, ISSUE_TYPE_ICON as ISSUE_ICON } from "./constants.js";

// ── Row model ──────────────────────────────────────────────────────────

interface Row {
  key: string;
  indent: number;
  icon: string;
  label: string;
  detail: string;
  expandable: boolean;
  children?: Row[];
  issueId?: string;
  epicId?: string;
  assetId?: string;
}

function buildRows(r: ProjectFile, showHistory = false): Row[] {
  const rows: Row[] = [];
  const epics = [...r.epics].sort((a, b) => a.priority - b.priority);
  const issues = r.issues;

  const groups: [string, string, Epic[]][] = [
    ["in-progress", "🔧 In Progress", epics.filter(e => e.status === "in-progress")],
    ["planned", "📋 Planned", epics.filter(e => e.status === "planned")],
    ["draft", "📝 Drafts", epics.filter(e => e.status === "draft")],
  ];

  if (showHistory) {
    groups.push(["closed", "🏁 Closed", epics.filter(e => e.status === "closed")]);
  }

  for (const [status, groupLabel, groupEpics] of groups) {
    if (!groupEpics.length) continue;
    rows.push({
      key: `g-${status}`, indent: 0, icon: "", label: groupLabel,
      detail: `(${groupEpics.length})`, expandable: true,
      children: groupEpics.map(e => epicRow(e, issues)),
    });
  }

  const unplanned = issues.filter(i => !i.epicId && (showHistory || i.status !== "closed"));
  if (unplanned.length) {
    rows.push({
      key: "g-unplanned", indent: 0, icon: "", label: "🔗 Unplanned Issues",
      detail: `(${unplanned.length})`, expandable: true,
      children: unplanned.map(issueRow),
    });
  }

  const assets = r.assets || [];
  if (assets.length) {
    const proj = assets.filter(a => a.project).length;
    rows.push({
      key: "g-assets", indent: 0, icon: "", label: "📎 Assets",
      detail: `(${assets.length} total, ${proj} project)`, expandable: true,
      children: assets.map(a => ({
        key: `a-${a.id}`, indent: 1, icon: a.project ? "🌐" : "📎",
        label: `[${a.id}] ${a.title}`, detail: a.categorySlug, expandable: false,
        assetId: a.id,
      })),
    });
  }

  return rows;
}

function epicRow(epic: Epic, issues: Issue[]): Row {
  const linked = issues.filter(i => i.epicId === epic.id && i.status !== "closed");
  const closed = issues.filter(i => i.epicId === epic.id && i.status === "closed").length;
  const td = epic.todos.filter(t => t.done).length;
  const tt = epic.todos.length;

  const parts: string[] = [epic.status];
  if (tt) parts.push(`todos:${td}/${tt}`);
  if (linked.length) parts.push(`${linked.length} open`);
  if (closed) parts.push(`${closed} closed`);

  const children: Row[] = [];
  if (epic.description) {
    children.push({ key: `e-${epic.id}-d`, indent: 1, icon: "", label: epic.description, detail: "", expandable: false });
  }
  for (const todo of epic.todos) {
    children.push({ key: `e-${epic.id}-t-${children.length}`, indent: 1, icon: todo.done ? "☑" : "☐", label: todo.text, detail: "", expandable: false });
  }
  for (const c of epic.successCriteria) {
    children.push({ key: `e-${epic.id}-s-${children.length}`, indent: 1, icon: "◆", label: c, detail: "", expandable: false });
  }
  for (const i of linked) {
    children.push(issueRow(i));
  }

  return {
    key: `e-${epic.id}`, indent: 1, icon: EPIC_ICON[epic.status] || "•",
    label: `[${epic.id}] ${epic.title}`, detail: parts.join(" · "),
    expandable: children.length > 0, children, epicId: epic.id,
  };
}

function issueRow(issue: Issue): Row {
  return {
    key: `i-${issue.id}`, indent: 1, icon: ISSUE_ICON[issue.type] || "•",
    label: `[${issue.id}] ${issue.title}`, detail: `${issue.type} · ${issue.status}`,
    expandable: false, issueId: issue.id,
  };
}

// ── Flatten ────────────────────────────────────────────────────────────

interface FlatRow { row: Row; depth: number; }

function flatten(rows: Row[], expanded: Set<string>, depth = 0): FlatRow[] {
  const out: FlatRow[] = [];
  for (const row of rows) {
    out.push({ row, depth });
    if (row.expandable && row.children && expanded.has(row.key)) {
      out.push(...flatten(row.children, expanded, depth + 1));
    }
  }
  return out;
}

// ── Detail view: build lines for an issue ──────────────────────────────

function issueDetailLines(issue: Issue, th: Theme, innerW: number, allIssues: Issue[] = []): string[] {
  const lines: string[] = [];
  const icon = ISSUE_ICON[issue.type] || "•";

  lines.push(th.fg("accent", `  ${icon} [${issue.id}] ${issue.title}`));
  lines.push("");
  lines.push(`  ${th.fg("dim", "Type:")}     ${issue.type}`);
  lines.push(`  ${th.fg("dim", "Status:")}   ${issue.status}`);
  lines.push(`  ${th.fg("dim", "Created:")}  ${new Date(issue.createdAt).toLocaleString()}`);
  lines.push(`  ${th.fg("dim", "Updated:")}  ${new Date(issue.updatedAt).toLocaleString()}`);
  if (issue.epicId) lines.push(`  ${th.fg("dim", "Epic:")}    ${issue.epicId}`);
  if (issue.autoValidation) {
    const vtype = issue.autoValidation.type || (issue.autoValidation.possible === false ? "human" : issue.autoValidation.possible === true ? "agent" : "other");
    const vlabel = vtype === "agent" ? "🤖 Agent" : vtype === "human" ? "👤 Human" : "📋 Other";
    lines.push(`  ${th.fg("dim", "Validate:")} ${vlabel} — ${issue.autoValidation.strategy}`);
  }
  if (issue.closedAt) lines.push(`  ${th.fg("dim", "Closed:")}  ${new Date(issue.closedAt).toLocaleString()}`);

  lines.push("");
  lines.push(th.fg("accent", "  ── Description ──"));
  for (const line of issue.description.split("\n")) {
    lines.push(`  ${line}`);
  }

  if (issue.research.length) {
    lines.push("");
    lines.push(th.fg("accent", "  ── Research ──"));
    for (const r of issue.research) {
      const rIcon = r.type === "example" ? "💡" : r.type === "reference" ? "📎" : "💬";
      lines.push(`  ${rIcon} ${th.fg("dim", r.type + ":")} ${r.content}`);
    }
  }

  if (issue.validations?.length) {
    lines.push("");
    lines.push(th.fg("accent", "  ── Validations ──"));
    for (const v of issue.validations) {
      lines.push(`  ${v.met ? "✅" : "❌"} ${v.evidence}`);
    }
  }

  if (issue.linkedIssueIds?.length) {
    lines.push("");
    lines.push(th.fg("accent", "  ── Linked Issues ──"));
    for (const lid of issue.linkedIssueIds) {
      const linked = allIssues.find(i => i.id === lid);
      if (linked) {
        const lIcon = ISSUE_ICON[linked.type] || "•";
        lines.push(`  🔗 ${lIcon} [${linked.id}] ${linked.title} ${th.fg("dim", `(${linked.type} · ${linked.status})`)}`);
      } else {
        lines.push(`  🔗 [${lid}] (not found)`);
      }
    }
  }

  if (issue.closeMessage) {
    lines.push("");
    lines.push(th.fg("accent", "  ── Close Message ──"));
    lines.push(`  ${issue.closeMessage}`);
  }

  return lines;
}

// ── Detail view: build lines for an epic ───────────────────────────────

function epicDetailLines(epic: Epic, issues: Issue[], th: Theme, innerW: number): string[] {
  const lines: string[] = [];
  const icon = EPIC_ICON[epic.status] || "•";

  lines.push(th.fg("accent", `  ${icon} [${epic.id}] ${epic.title}`));
  lines.push("");
  lines.push(`  ${th.fg("dim", "Priority:")} ${epic.priority}`);
  lines.push(`  ${th.fg("dim", "Status:")}   ${epic.status}`);
  lines.push(`  ${th.fg("dim", "Created:")}  ${new Date(epic.createdAt).toLocaleString()}`);
  lines.push(`  ${th.fg("dim", "Updated:")}  ${new Date(epic.updatedAt).toLocaleString()}`);
  if (epic.closedAt) lines.push(`  ${th.fg("dim", "Closed:")}  ${new Date(epic.closedAt).toLocaleString()}`);

  lines.push("");
  lines.push(th.fg("accent", "  ── Description ──"));
  for (const line of epic.description.split("\n")) {
    lines.push(`  ${line}`);
  }

  if (epic.body) {
    lines.push("");
    lines.push(th.fg("accent", "  ── Details ──"));
    for (const line of epic.body.split("\n")) {
      lines.push(`  ${line}`);
    }
  }

  if (epic.todos.length) {
    const done = epic.todos.filter(t => t.done).length;
    lines.push("");
    lines.push(th.fg("accent", `  ── Todos (${done}/${epic.todos.length}) ──`));
    for (const t of epic.todos) {
      lines.push(`  ${t.done ? "☑" : "☐"} ${t.text}`);
    }
  }

  if (epic.successCriteria.length) {
    lines.push("");
    lines.push(th.fg("accent", "  ── Success Criteria ──"));
    for (const c of epic.successCriteria) {
      lines.push(`  ◆ ${c}`);
    }
  }

  if (epic.relevantFiles.length) {
    lines.push("");
    lines.push(th.fg("accent", "  ── Relevant Files ──"));
    for (const f of epic.relevantFiles) {
      lines.push(`  📄 ${th.fg("text", f.file)} ${th.fg("dim", "— " + f.reason)}`);
    }
  }

  if (epic.research.length) {
    lines.push("");
    lines.push(th.fg("accent", "  ── Research ──"));
    for (const r of epic.research) {
      const rIcon = r.type === "example" ? "💡" : r.type === "reference" ? "📎" : "💬";
      lines.push(`  ${rIcon} ${th.fg("dim", r.type + ":")} ${r.content}`);
    }
  }

  const linkedIssues = issues.filter(i => i.epicId === epic.id);
  if (linkedIssues.length) {
    lines.push("");
    lines.push(th.fg("accent", `  ── Issues (${linkedIssues.length}) ──`));
    for (const i of linkedIssues) {
      const iIcon = ISSUE_ICON[i.type] || "•";
      lines.push(`  ${iIcon} [${i.id}] ${i.title} ${th.fg("dim", `(${i.type} · ${i.status})`)}`);
    }
  }

  if (epic.validations?.length) {
    lines.push("");
    lines.push(th.fg("accent", "  ── Validations ──"));
    for (const v of epic.validations) {
      lines.push(`  ${v.met ? "✅" : "❌"} ${th.fg("dim", v.criterion + ":")} ${v.evidence}`);
    }
  }

  if (epic.closeMessage) {
    lines.push("");
    lines.push(th.fg("accent", "  ── Close Message ──"));
    lines.push(`  ${epic.closeMessage}`);
  }

  return lines;
}

// ── Detail view: build lines for an asset ──────────────────────────────

function assetDetailLines(asset: Asset, epics: Epic[], issues: Issue[], th: Theme): string[] {
  const lines: string[] = [];
  const flag = asset.project ? " 🌐 project-level" : "";

  lines.push(th.fg("accent", `  📎 [${asset.id}] ${asset.title}${flag}`));
  lines.push("");
  lines.push(`  ${th.fg("dim", "Category:")} ${asset.categorySlug}`);
  lines.push(`  ${th.fg("dim", "Created:")}  ${new Date(asset.createdAt).toLocaleString()}`);
  lines.push(`  ${th.fg("dim", "Updated:")}  ${new Date(asset.updatedAt).toLocaleString()}`);

  lines.push("");
  lines.push(th.fg("accent", "  ── Context ──"));
  lines.push(`  ${asset.context}`);

  if (asset.body) {
    lines.push("");
    lines.push(th.fg("accent", "  ── Content ──"));
    for (const line of asset.body.split("\n")) {
      lines.push(`  ${line}`);
    }
  }

  if (asset.sources.length) {
    lines.push("");
    lines.push(th.fg("accent", "  ── Sources ──"));
    for (const s of asset.sources) {
      const icon = s.type === "file" ? "📄" : "🔗";
      lines.push(`  ${icon} ${th.fg("text", s.path)} ${th.fg("dim", "— " + s.description)}`);
    }
  }

  if (asset.linkedEpicIds.length) {
    lines.push("");
    lines.push(th.fg("accent", "  ── Linked Epics ──"));
    for (const eid of asset.linkedEpicIds) {
      const epic = epics.find(e => e.id === eid);
      const eIcon = epic ? (EPIC_ICON[epic.status] || "•") : "•";
      lines.push(`  ${eIcon} [${eid}] ${epic?.title || "unknown"}`);
    }
  }

  if (asset.linkedIssueIds.length) {
    lines.push("");
    lines.push(th.fg("accent", "  ── Linked Issues ──"));
    for (const iid of asset.linkedIssueIds) {
      const issue = issues.find(i => i.id === iid);
      const iIcon = issue ? (ISSUE_ICON[issue.type] || "•") : "•";
      lines.push(`  ${iIcon} [${iid}] ${issue?.title || "unknown"}`);
    }
  }

  return lines;
}

// ── Overlay component ──────────────────────────────────────────────────

type ViewMode = "list" | "detail";

class DashboardComponent implements Focusable {
  readonly width = 90;
  focused = false;
  private selected = 0;
  private scrollOffset = 0;
  private maxVisible = 25;
  private rows: Row[];
  private expanded = new Set<string>();
  private showHistory = false;

  // Detail view state
  private viewMode: ViewMode = "list";
  private detailLines: string[] = [];
  private detailTitle = "";
  private detailScroll = 0;

  constructor(
    private theme: Theme,
    private done: (result: undefined) => void,
  ) {
    this.rebuildRows();
  }

  private rebuildRows(): void {
    const data = load();
    this.rows = buildRows(data, this.showHistory);
    const autoExpand = (rows: Row[]) => {
      for (const row of rows) {
        if (row.expandable) {
          this.expanded.add(row.key);
          if (row.children) autoExpand(row.children);
        }
      }
    };
    autoExpand(this.rows);
  }

  private openDetail(flat: FlatRow[]): void {
    const item = flat[this.selected];
    if (!item) return;

    const data = load();
    const th = this.theme;
    const innerW = this.width - 2;

    if (item.row.issueId) {
      const issue = data.issues.find(i => i.id === item.row.issueId);
      if (!issue) return;
      this.detailTitle = `${ISSUE_ICON[issue.type] || "•"} Issue: ${issue.title}`;
      this.detailLines = issueDetailLines(issue, th, innerW, data.issues);
      this.viewMode = "detail";
      this.detailScroll = 0;
    } else if (item.row.epicId) {
      const epic = data.epics.find(e => e.id === item.row.epicId);
      if (!epic) return;
      this.detailTitle = `${EPIC_ICON[epic.status] || "•"} Epic: ${epic.title}`;
      this.detailLines = epicDetailLines(epic, data.issues, th, innerW);
      this.viewMode = "detail";
      this.detailScroll = 0;
    } else if (item.row.assetId) {
      const asset = (data.assets || []).find((a: Asset) => a.id === item.row.assetId);
      if (!asset) return;
      this.detailTitle = `📎 Asset: ${asset.title}`;
      this.detailLines = assetDetailLines(asset, data.epics, data.issues, th);
      this.viewMode = "detail";
      this.detailScroll = 0;
    }
  }

  handleInput(data: string): void {
    if (this.viewMode === "detail") {
      if (matchesKey(data, "escape") || data === "q") {
        this.viewMode = "list";
        return;
      }
      if (matchesKey(data, "up")) {
        this.detailScroll = Math.max(0, this.detailScroll - 1);
        return;
      }
      if (matchesKey(data, "down")) {
        const maxScroll = Math.max(0, this.detailLines.length - this.maxVisible);
        this.detailScroll = Math.min(maxScroll, this.detailScroll + 1);
        return;
      }
      return;
    }

    // List mode
    if (matchesKey(data, "escape") || data === "q") {
      this.done(undefined);
      return;
    }

    const flat = flatten(this.rows, this.expanded);
    if (!flat.length) return;

    if (matchesKey(data, "up")) {
      this.selected = Math.max(0, this.selected - 1);
    } else if (matchesKey(data, "down")) {
      this.selected = Math.min(flat.length - 1, this.selected + 1);
    } else if (data === "h") {
      this.showHistory = !this.showHistory;
      this.rebuildRows();
    } else if (matchesKey(data, "return")) {
      const item = flat[this.selected];
      if (!item) return;
      // If it's an issue or epic row, open detail view
      if (item.row.issueId || item.row.epicId || item.row.assetId) {
        this.openDetail(flat);
      } else if (item.row.expandable) {
        if (this.expanded.has(item.row.key)) {
          this.expanded.delete(item.row.key);
        } else {
          this.expanded.add(item.row.key);
        }
      }
    }
  }

  render(_width: number): string[] {
    if (this.viewMode === "detail") return this.renderDetail();
    return this.renderList();
  }

  private renderDetail(): string[] {
    const th = this.theme;
    const w = this.width;
    const innerW = w - 2;
    const lines: string[] = [];

    const pad = (s: string, len: number) => {
      const vis = visibleWidth(s);
      return s + " ".repeat(Math.max(0, len - vis));
    };
    const row = (content: string) => th.fg("border", "│") + pad(content, innerW) + th.fg("border", "│");

    lines.push(th.fg("border", `╭${"─".repeat(innerW)}╮`));
    lines.push(row(` ${th.fg("accent", this.detailTitle)}`));
    lines.push(row(""));

    const visible = this.detailLines.slice(this.detailScroll, this.detailScroll + this.maxVisible);
    for (const line of visible) {
      if (visibleWidth(line) > innerW) {
        lines.push(row(line.slice(0, innerW)));
      } else {
        lines.push(row(line));
      }
    }

    // Scroll indicator
    if (this.detailLines.length > this.maxVisible) {
      const maxScroll = Math.max(1, this.detailLines.length - this.maxVisible);
      const pct = Math.round((this.detailScroll / maxScroll) * 100);
      lines.push(row(th.fg("dim", `  ── ${this.detailScroll + 1}-${Math.min(this.detailScroll + this.maxVisible, this.detailLines.length)} of ${this.detailLines.length} (${pct}%) ──`)));
    }

    lines.push(row(""));
    lines.push(row(th.fg("dim", "  ↑↓ scroll  Esc back")));
    lines.push(th.fg("border", `╰${"─".repeat(innerW)}╯`));

    return lines;
  }

  private renderList(): string[] {
    const th = this.theme;
    const w = this.width;
    const innerW = w - 2;
    const lines: string[] = [];

    const pad = (s: string, len: number) => {
      const vis = visibleWidth(s);
      return s + " ".repeat(Math.max(0, len - vis));
    };
    const row = (content: string) => th.fg("border", "│") + pad(content, innerW) + th.fg("border", "│");

    lines.push(th.fg("border", `╭${"─".repeat(innerW)}╮`));
    const histBadge = this.showHistory ? th.fg("warning", " [history]") : "";
    lines.push(row(` ${th.fg("accent", "📦 Project Dashboard")}${histBadge}`));
    lines.push(row(""));

    const flat = flatten(this.rows, this.expanded);

    if (!flat.length) {
      lines.push(row(th.fg("muted", "  No epics or issues yet.")));
      lines.push(row(""));
      lines.push(row(th.fg("dim", "  Esc to close")));
      lines.push(th.fg("border", `╰${"─".repeat(innerW)}╯`));
      return lines;
    }

    // Clamp & scroll
    if (this.selected >= flat.length) this.selected = flat.length - 1;
    if (this.selected < 0) this.selected = 0;
    if (this.selected < this.scrollOffset) this.scrollOffset = this.selected;
    if (this.selected >= this.scrollOffset + this.maxVisible) this.scrollOffset = this.selected - this.maxVisible + 1;

    const visible = flat.slice(this.scrollOffset, this.scrollOffset + this.maxVisible);

    for (let i = 0; i < visible.length; i++) {
      const { row: r, depth } = visible[i];
      const globalIdx = this.scrollOffset + i;
      const isSel = globalIdx === this.selected;

      const indent = "  ".repeat(r.indent + depth);
      const pointer = isSel ? th.fg("accent", "▸ ") : "  ";
      const expMark = r.expandable
        ? (this.expanded.has(r.key) ? th.fg("dim", "▾ ") : th.fg("dim", "▸ "))
        : (r.issueId || r.epicId) ? "  " : "  ";
      const iconStr = r.icon ? r.icon + " " : "";
      const labelStr = isSel ? th.fg("text", r.label) : th.fg("muted", r.label);
      const detailStr = r.detail ? " " + th.fg("dim", r.detail) : "";

      const content = ` ${indent}${pointer}${expMark}${iconStr}${labelStr}${detailStr}`;

      if (visibleWidth(content) > innerW) {
        lines.push(row(content.slice(0, innerW)));
      } else {
        lines.push(row(content));
      }
    }

    if (flat.length > this.maxVisible) {
      const pct = Math.round((this.scrollOffset / Math.max(1, flat.length - this.maxVisible)) * 100);
      lines.push(row(th.fg("dim", `  ── ${this.scrollOffset + 1}-${Math.min(this.scrollOffset + this.maxVisible, flat.length)} of ${flat.length} (${pct}%) ──`)));
    }

    lines.push(row(""));
    const histHint = this.showHistory ? "h hide history" : "h show history";
    lines.push(row(th.fg("dim", `  ↑↓ navigate  Enter open/expand  ${histHint}  Esc close`)));
    lines.push(th.fg("border", `╰${"─".repeat(innerW)}╯`));

    return lines;
  }
}

// ── Registration ───────────────────────────────────────────────────────

export function registerDashboard(pi: ExtensionAPI): void {
  pi.registerCommand("project-dashboard", {
    description: "Open the interactive project dashboard",
    handler: async (_args, ctx) => {
      await ctx.ui.custom<undefined>(
        (_tui, theme, _kb, done) => new DashboardComponent(theme, done),
        { overlay: true },
      );
    },
  });
}
