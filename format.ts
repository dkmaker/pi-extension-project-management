import type { Epic, Issue, ResearchNote, ProjectFile, Asset, AssetCategory } from "./types.js";
import { EPIC_STATUS_LABEL as EPIC_STATUS_ICON, ISSUE_STATUS_LABEL as ISSUE_STATUS_ICON, ISSUE_TYPE_ICON } from "./constants.js";
import { visibleWidth, truncateToWidth } from "@mariozechner/pi-tui";

function statusLabel(status: string, map: Record<string, string>): string {
  return map[status] || status;
}

// --- Research ---

function formatResearch(research: ResearchNote[]): string {
  if (!research.length) return "";
  let out = "\n\n**Research:**";
  for (const r of research) {
    const icon = r.type === "example" ? "💡" : r.type === "reference" ? "📎" : "💬";
    out += `\n- ${icon} **${r.type}:** ${r.content}`;
  }
  return out;
}

// --- Issues ---

export function formatIssue(issue: Issue): string {
  const icon = ISSUE_TYPE_ICON[issue.type] || "•";
  const displayStatus = issue.status === "closed" && issue.closeReason === "deferred" ? "deferred" : issue.status;
  const st = statusLabel(displayStatus, ISSUE_STATUS_ICON);
  const link = issue.epicId ? ` → epic:${issue.epicId}` : "";
  return `${icon} [${issue.id}] ${issue.title} (${issue.type}, ${st})${link}`;
}

export function formatIssueVerbose(issue: Issue, epics: Epic[], assets: Asset[] = [], allIssues: Issue[] = []): string {
  const icon = ISSUE_TYPE_ICON[issue.type] || "•";
  const displayStatus = issue.status === "closed" && issue.closeReason === "deferred" ? "deferred" : issue.status;
  const st = statusLabel(displayStatus, ISSUE_STATUS_ICON);
  let out = `### ${icon} [${issue.id}] ${issue.title}  (${issue.type}, ${st})`;
  out += `\n${issue.description}`;
  if (issue.epicId) {
    const epic = epics.find((e) => e.id === issue.epicId);
    out += `\n\n**Linked to epic:** [${issue.epicId}] ${epic?.title || "unknown"}`;
  }
  if (issue.linkedIssueIds?.length) {
    out += `\n\n**Linked issues:**`;
    for (const lid of issue.linkedIssueIds) {
      const linked = allIssues.find((i) => i.id === lid);
      if (linked) {
        const li = ISSUE_TYPE_ICON[linked.type] || "•";
        out += `\n- ${li} [${linked.id}] ${linked.title} (${linked.type}, ${statusLabel(linked.status, ISSUE_STATUS_ICON)})`;
      } else {
        out += `\n- [${lid}] (not found)`;
      }
    }
  }
  if (issue.questions?.length) {
    const unansweredReq = issue.questions.filter(q => !q.answer && q.required !== false).length;
    const label = unansweredReq > 0 ? `${unansweredReq} required unanswered` : "all resolved";
    out += `\n\n**Questions** (${label}):`;
    for (let i = 0; i < issue.questions.length; i++) {
      const q = issue.questions[i];
      const qi = q.answer ? "✅" : "❓";
      const opt = q.required === false ? " *(optional)*" : "";
      out += `\n- ${qi} ${q.text}${opt}`;
      if (q.answer) out += `\n  **A:** ${q.answer}`;
    }
  }
  out += formatResearch(issue.research);
  if (issue.closeMessage) {
    const reasonTag = issue.closeReason && issue.closeReason !== "done" ? ` (${issue.closeReason})` : "";
    out += `\n\n**Close message${reasonTag}:** ${issue.closeMessage}`;
  }
  if (issue.validations?.length) {
    out += `\n\n**Validated:** ✅ ${issue.validations[0].evidence}`;
  }
  out += linkedAssets("issue", issue.id, assets);
  return out;
}

// --- Epics ---

export function formatEpic(epic: Epic, verbose = false, issues: Issue[] = [], assets: Asset[] = []): string {
  const displayStatus = epic.status === "closed" && epic.closeReason === "deferred" ? "deferred" : epic.status;
  const st = statusLabel(displayStatus, EPIC_STATUS_ICON);
  const todosDone = epic.todos.filter((t) => t.done).length;
  const todosTotal = epic.todos.length;
  let out = `### [${epic.id}] ${epic.title}  (priority: ${epic.priority}, ${st})`;
  out += `\n${epic.description}`;
  if (verbose) {
    if (epic.body) out += `\n\n---\n${epic.body}`;
    if (epic.relevantFiles.length) {
      out += `\n\n**Relevant files:**`;
      for (const f of epic.relevantFiles) out += `\n- \`${f.file}\` — ${f.reason}`;
    }
    if (todosTotal) {
      out += `\n\n**Todos** (${todosDone}/${todosTotal}):`;
      for (const t of epic.todos) out += `\n- [${t.done ? "x" : " "}] ${t.text}`;
    }
    if (epic.successCriteria.length) {
      out += `\n\n**Success criteria:**`;
      for (const c of epic.successCriteria) out += `\n- ${c}`;
    }
    out += formatResearch(epic.research);
    const linkedOpen = issues.filter((i) => i.epicId === epic.id && i.status !== "closed");
    const linkedClosed = issues.filter((i) => i.epicId === epic.id && i.status === "closed");
    if (linkedOpen.length) {
      out += `\n\n**Issues (${linkedOpen.length} open${linkedClosed.length ? `, ${linkedClosed.length} closed` : ""}):**`;
      for (const i of linkedOpen) out += `\n- ${formatIssue(i)}`;
    } else if (linkedClosed.length) {
      out += `\n\n**Issues:** ${linkedClosed.length} closed`;
    }
    if (epic.closeMessage) {
      const reasonTag = epic.closeReason && epic.closeReason !== "done" ? ` (${epic.closeReason})` : "";
      out += `\n\n**Close message${reasonTag}:** ${epic.closeMessage}`;
    }
    if (epic.validations?.length) {
      out += `\n\n**Validations:**`;
      for (const v of epic.validations) out += `\n- ${v.met ? "✅" : "❌"} **${v.criterion}**: ${v.evidence}`;
    }
    out += linkedAssets("epic", epic.id, assets);
  } else {
    const linked = issues.filter((i) => i.epicId === epic.id && i.status !== "closed");
    const parts: string[] = [];
    if (todosTotal) parts.push(`Todos: ${todosDone}/${todosTotal}`);
    if (linked.length) parts.push(`Issues: ${linked.length} open`);
    if (epic.research.length) parts.push(`Research: ${epic.research.length}`);
    if (parts.length) out += `\n  ${parts.join(" | ")}`;
  }
  return out;
}

// --- Dashboard ---

export function formatDashboard(r: ProjectFile): string {
  const epics = r.epics.sort((a, b) => a.priority - b.priority);
  const issues = r.issues;

  const eByS = {
    draft: epics.filter((e) => e.status === "draft"),
    planned: epics.filter((e) => e.status === "planned"),
    "in-progress": epics.filter((e) => e.status === "in-progress"),
    closed: epics.filter((e) => e.status === "closed"),
  };

  const iByS = {
    draft: issues.filter((i) => i.status === "draft"),
    researched: issues.filter((i) => i.status === "researched"),
    ready: issues.filter((i) => i.status === "ready"),
    closed: issues.filter((i) => i.status === "closed"),
  };

  const assets = r.assets || [];
  const projectAssets = assets.filter((a) => a.project);

  let out = `# 📦 Project Status\n\n`;
  out += `**Epics:** ${eByS.draft.length} draft · ${eByS.planned.length} planned · ${eByS["in-progress"].length} active · ${eByS.closed.length} closed\n`;
  out += `**Issues:** ${iByS.draft.length} draft · ${iByS.researched.length} researched · ${iByS.ready.length} ready · ${iByS.closed.length} closed\n`;
  if (assets.length) out += `**Assets:** ${assets.length} total (${projectAssets.length} project-level)\n`;

  if (eByS["in-progress"].length) {
    out += `\n---\n## 🔧 In Progress\n\n`;
    for (const e of eByS["in-progress"]) out += formatEpic(e, true, issues, assets) + "\n";
  }

  if (eByS.planned.length) {
    out += `\n---\n## 📋 Planned\n`;
    for (const e of eByS.planned) out += `\n${formatEpic(e, false, issues, assets)}`;
  }

  if (eByS.draft.length) {
    out += `\n\n---\n## 📝 Drafts\n`;
    for (const e of eByS.draft) out += `\n${formatEpic(e, false, issues, assets)}`;
  }

  const unlinked = issues.filter((i) => !i.epicId && i.status !== "closed");
  if (unlinked.length) {
    out += `\n\n---\n## 🔗 Unplanned Issues\n`;
    for (const i of unlinked) out += `\n- ${formatIssue(i)}`;
  }

  return out;
}

// --- Brief status (slim LLM context) ---

export function formatBrief(r: ProjectFile): string {
  const epics = r.epics;
  const issues = r.issues;
  const assets = r.assets || [];

  const epicCounts = {
    active: epics.filter(e => e.status === "in-progress").length,
    planned: epics.filter(e => e.status === "planned").length,
    draft: epics.filter(e => e.status === "draft").length,
    closed: epics.filter(e => e.status === "closed").length,
  };
  const openIssues = issues.filter(i => i.status !== "closed");
  const unplanned = openIssues.filter(i => !i.epicId);

  const lines: string[] = [];
  lines.push(`# 📦 Project Status`);
  lines.push(`**Epics:** ${epicCounts.active} active · ${epicCounts.planned} planned · ${epicCounts.draft} draft · ${epicCounts.closed} closed`);
  lines.push(`**Issues:** ${openIssues.length} open · ${issues.length - openIssues.length} closed`);
  if (assets.length) lines.push(`**Assets:** ${assets.length} total`);

  // Current focus: active epic + current issue (one line each)
  const active = epics.filter(e => e.status !== "closed").sort((a, b) => a.priority - b.priority);
  const focus = active.find(e => e.status === "in-progress") || active.find(e => e.status === "planned") || active[0];
  if (focus) {
    const linkedOpen = issues.filter(i => i.epicId === focus.id && i.status !== "closed").length;
    const td = focus.todos.filter(t => t.done).length;
    const tt = focus.todos.length;
    lines.push(`→ Epic: [${focus.id}] ${focus.title} (${focus.status}, ${linkedOpen} open issues${tt ? `, todos: ${td}/${tt}` : ""})`);
  }

  const currentIssue = issues.find(i => i.status === "in-progress");
  if (currentIssue) {
    lines.push(`→ Issue: [${currentIssue.id}] ${currentIssue.title} (${currentIssue.type}, in-progress)`);
  }

  if (unplanned.length) {
    lines.push(`⚠ ${unplanned.length} unplanned issue(s) need triage`);
  }

  return lines.join("\n");
}

// --- Status bar ---

export function statusBarText(r: ProjectFile, theme: any): string {
  const epics = r.epics;
  const issues = r.issues;
  const sep = theme.fg("dim", " · ");

  const epicActive = epics.filter((e) => e.status === "in-progress").length;
  const epicPlanned = epics.filter((e) => e.status === "planned").length;
  const issueOpen = issues.filter((i) => i.status !== "closed").length;
  const unplanned = issues.filter((i) => !i.epicId && i.status !== "closed").length;

  // Count unanswered required questions across all open issues
  const unansweredQ = issues
    .filter((i) => i.status !== "closed")
    .reduce((sum, i) => sum + (i.questions?.filter((q) => !q.answer && q.required !== false).length || 0), 0);

  const parts: string[] = [];

  // Epic counts
  const eParts: string[] = [];
  if (epicActive) eParts.push(`${epicActive} active`);
  if (epicPlanned) eParts.push(`${epicPlanned} planned`);
  if (eParts.length) parts.push(theme.fg("dim", eParts.join(sep)));

  // Issue counts
  if (issueOpen) parts.push(theme.fg("success", `${issueOpen} open issues`));
  if (unplanned) parts.push(theme.fg("warning", `${unplanned} unplanned ⚠`));
  if (unansweredQ) parts.push(theme.fg("warning", `${unansweredQ} questions ❓`));

  if (!parts.length) return theme.fg("dim", "📦 no items");

  return `📦 ${parts.join(theme.fg("dim", " │ "))}`;
}

function progressBar(done: number, total: number, theme: any, width: number = 8): string {
  if (total === 0) return "";
  const filled = Math.round((done / total) * width);
  const empty = width - filled;
  return theme.fg("accent", "█".repeat(filled)) + theme.fg("dim", "░".repeat(empty)) + theme.fg("dim", ` ${done}/${total}`);
}

export interface FocusWidgetData {
  epicTitle: string | null;      // null = no epic
  epicProgress: { done: number; total: number } | null;
  issueTitle: string | null;
  issueIcon: string;
  issueStatus: string;
  issueProgress: { done: number; total: number } | null;
}

export function focusWidgetData(r: ProjectFile): FocusWidgetData | null {
  const epics = r.epics;
  const issues = r.issues;

  const active = epics.filter((e) => e.status !== "closed").sort((a, b) => a.priority - b.priority);
  const focusEpic = active.find((e) => e.status === "in-progress") || active.find((e) => e.status === "planned") || active[0];

  let activeIssue = issues.find((i) => i.status === "in-progress");
  if (!activeIssue && focusEpic) {
    activeIssue = issues.find((i) => i.epicId === focusEpic.id && i.status !== "closed");
  }
  if (!activeIssue) {
    activeIssue = issues.find((i) => i.status !== "closed");
  }

  if (!focusEpic && !activeIssue) return null;

  let epicProgress: { done: number; total: number } | null = null;
  if (focusEpic) {
    const todosDone = focusEpic.todos.filter((t: any) => t.done).length;
    const todosTotal = focusEpic.todos.length;
    if (todosTotal) {
      epicProgress = { done: todosDone, total: todosTotal };
    } else {
      const linkedTotal = issues.filter((i) => i.epicId === focusEpic.id).length;
      const linkedClosed = issues.filter((i) => i.epicId === focusEpic.id && i.status === "closed").length;
      if (linkedTotal) epicProgress = { done: linkedClosed, total: linkedTotal };
    }
  }

  let issueProgress: { done: number; total: number } | null = null;
  if (activeIssue) {
    const qs = activeIssue.questions || [];
    if (qs.length) {
      issueProgress = { done: qs.filter((q: any) => q.answer).length, total: qs.length };
    }
  }

  return {
    epicTitle: focusEpic ? focusEpic.title : null,
    epicProgress,
    issueTitle: activeIssue ? activeIssue.title : null,
    issueIcon: activeIssue ? (ISSUE_TYPE_ICON[activeIssue.type] || "•") : "",
    issueStatus: activeIssue ? (ISSUE_STATUS_ICON[activeIssue.status] || activeIssue.status) : "",
    issueProgress,
  };
}

/** Truncate plain text (no ANSI) to max visible columns */
function truncate(text: string, max: number): string {
  if (max <= 0) return "";
  // Use visibleWidth for accurate column counting (handles emoji etc.)
  if (visibleWidth(text) <= max) return text;
  // Trim character by character until it fits
  let result = text;
  while (visibleWidth(result) > max - 1 && result.length > 0) {
    result = result.slice(0, -1);
  }
  return result + "…";
}

export function renderFocusLine(data: FocusWidgetData, theme: any, width: number): string {
  const sep = "  " + theme.fg("dim", "│") + "  ";
  const sepLen = 5; // "  │  "

  // Measure fixed parts to figure out how much space titles get
  // Epic fixed: "► " (2) + progress "████░░░░ 3/8" (~13 if present)
  // Issue fixed: icon + "  " + status + progress
  const epicPrefix = 2; // "► "
  const epicProgressLen = data.epicProgress ? 8 + 1 + `${data.epicProgress.done}/${data.epicProgress.total}`.length : 0; // bar + space + "d/t"
  const epicFixedExtra = epicProgressLen ? 2 + epicProgressLen : 0; // "  " + progress

  // For "No attached epic"
  const noEpicLen = 18; // "► No attached epic"

  const issueIconLen = data.issueTitle ? [...data.issueIcon].length + 1 : 0; // icon + space (emoji = 1 code point but ~2 cols)
  const issueIconCols = data.issueTitle ? 3 : 0; // emoji(2) + space(1)
  const issueStatusText = data.issueStatus.replace(/\x1b\[[0-9;]*m/g, "");
  const issueStatusCols = [...issueStatusText].length + 2; // "  " before status — approximate emoji as 2
  const issueProgressLen = data.issueProgress ? 2 + 8 + 1 + `${data.issueProgress.done}/${data.issueProgress.total}`.length : 0;

  // Calculate available space for titles
  let epicSideFixed: number;
  if (data.epicTitle) {
    epicSideFixed = epicPrefix + epicFixedExtra;
  } else {
    epicSideFixed = noEpicLen;
  }

  let issueSideFixed = 0;
  if (data.issueTitle) {
    issueSideFixed = issueIconCols + issueStatusCols + issueProgressLen;
  }

  const hasBothSides = (data.epicTitle !== null || true) && data.issueTitle;
  const totalFixed = epicSideFixed + (hasBothSides ? sepLen + issueSideFixed : issueSideFixed);
  const availableForTitles = Math.max(20, width - totalFixed);

  // Split available space: 45% epic, 55% issue (issue titles tend to be more descriptive)
  let epicMax: number, issueMax: number;
  if (data.epicTitle && data.issueTitle) {
    epicMax = Math.floor(availableForTitles * 0.45);
    issueMax = availableForTitles - epicMax;
  } else if (data.epicTitle) {
    epicMax = availableForTitles;
    issueMax = 0;
  } else {
    epicMax = 0;
    issueMax = availableForTitles;
  }

  // Build line
  const parts: string[] = [];

  if (data.epicTitle) {
    let epicPart = theme.fg("accent", `► ${truncate(data.epicTitle, epicMax)}`);
    if (data.epicProgress) {
      epicPart += "  " + progressBar(data.epicProgress.done, data.epicProgress.total, theme);
    }
    parts.push(epicPart);
  } else {
    parts.push(theme.fg("dim", "► No attached epic"));
  }

  if (data.issueTitle) {
    let issuePart = theme.fg("success", `${data.issueIcon} ${truncate(data.issueTitle, issueMax)}`);
    issuePart += "  " + theme.fg("dim", data.issueStatus);
    if (data.issueProgress) {
      issuePart += "  " + progressBar(data.issueProgress.done, data.issueProgress.total, theme);
    }
    parts.push(issuePart);
  }

  const result = parts.join(sep);
  // Safety: ensure we never exceed terminal width (the TUI will crash otherwise)
  return truncateToWidth(result, width);
}

// --- Assets ---

export function formatAsset(asset: Asset, verbose = false, epics: Epic[] = [], issues: Issue[] = []): string {
  const flag = asset.project ? " 🌐" : "";
  const trigger = asset.trigger ? ` ⚡${asset.trigger.event}` : "";
  let out = `### 📎 [${asset.categorySlug}/${asset.id}] ${asset.title}${flag}${trigger}`;
  out += `\n*${asset.context}*`;
  if (verbose) {
    if (asset.body) out += `\n\n${asset.body}`;
    if (asset.sources.length) {
      out += `\n\n**Sources:**`;
      for (const s of asset.sources) {
        const icon = s.type === "file" ? "📄" : "🔗";
        out += `\n- ${icon} \`${s.path}\` — ${s.description}`;
      }
    }
    if (asset.linkedEpicIds.length) {
      out += `\n\n**Linked epics:**`;
      for (const eid of asset.linkedEpicIds) {
        const e = epics.find((ep) => ep.id === eid);
        out += `\n- [${eid}] ${e?.title || "unknown"}`;
      }
    }
    if (asset.linkedIssueIds.length) {
      out += `\n\n**Linked issues:**`;
      for (const iid of asset.linkedIssueIds) {
        const i = issues.find((is) => is.id === iid);
        const icon = i ? (ISSUE_TYPE_ICON[i.type] || "•") : "•";
        out += `\n- ${icon} [${iid}] ${i?.title || "unknown"}`;
      }
    }
  }
  return out;
}

export function formatAssetsContext(assets: Asset[]): string {
  const projectAssets = assets.filter((a) => a.project);
  if (!projectAssets.length) return "";

  let out = "# 📎 Project Assets\n\n";
  out += "These assets are REQUIRED context. When your current task matches an asset's context, read the full asset with `asset_show` before proceeding.\n";

  for (const a of projectAssets) {
    out += `\n- **[${a.id}] ${a.title}** (${a.categorySlug}): ${a.context}`;
  }

  return out;
}

export function linkedAssets(entityType: "epic" | "issue", entityId: string, assets: Asset[]): string {
  const linked = assets.filter((a) =>
    entityType === "epic" ? a.linkedEpicIds.includes(entityId) : a.linkedIssueIds.includes(entityId)
  );
  if (!linked.length) return "";
  let out = "\n\n**Assets:**";
  for (const a of linked) {
    const flag = a.project ? " 🌐" : "";
    out += `\n- 📎 [${a.categorySlug}/${a.id}] ${a.title}${flag} — *${a.context}*`;
  }
  return out;
}
