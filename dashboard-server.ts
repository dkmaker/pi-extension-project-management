import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { readFileSync, writeFileSync, watchFile, unwatchFile, existsSync, unlinkSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { createHash } from "crypto";
import { projectPath, load } from "./store.js";
import type { ProjectFile, Epic, Issue, Asset, AssetCategory } from "./types.js";

// ─── Types ───────────────────────────────────────────────────────────────────

interface SSEClient {
  res: ServerResponse;
}

interface ServerInstance {
  port: number;
  projectId: string;
  close: () => void;
}

// ─── Globals ─────────────────────────────────────────────────────────────────

let activeServer: ServerInstance | null = null;

// ─── Lock file ───────────────────────────────────────────────────────────────

function lockFilePath(): string {
  return join(process.cwd(), ".pi", "project", "dashboard.lock");
}

function writeLock(port: number, projectId: string): void {
  const p = lockFilePath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify({ port, projectId, pid: process.pid }), "utf-8");
}

function readLock(): { port: number; projectId: string; pid: number } | null {
  const p = lockFilePath();
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf-8"));
  } catch {
    return null;
  }
}

function removeLock(): void {
  const p = lockFilePath();
  try { unlinkSync(p); } catch {}
}

async function isPortListening(port: number): Promise<boolean> {
  const net = await import("net");
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(500);
    socket.on("connect", () => { socket.destroy(); resolve(true); });
    socket.on("timeout", () => { socket.destroy(); resolve(false); });
    socket.on("error", () => resolve(false));
    socket.connect(port, "127.0.0.1");
  });
}

// ─── Project ID ──────────────────────────────────────────────────────────────

function getProjectId(): string {
  return createHash("md5").update(process.cwd()).digest("hex").slice(0, 8);
}

// ─── Spec generation ─────────────────────────────────────────────────────────

// Simple server-side markdown to HTML (no npm deps)
function mdToHtml(text: string): string {
  if (!text) return "";
  let html = text
    // Code blocks (``` ... ```)
    .replace(/```(\w*)\n([\s\S]*?)```/g, (_m, _lang, code) => `<pre><code>${code.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</code></pre>`)
    // Inline code
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    // Headers
    .replace(/^#### (.+)$/gm, '<h4>$1</h4>')
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    // Bold + italic
    .replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/_(.+?)_/g, '<em>$1</em>')
    // Links
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
    // Horizontal rules
    .replace(/^---$/gm, '<hr>')
    // Unordered lists
    .replace(/^[*\-] (.+)$/gm, '<li>$1</li>')
    // Wrap consecutive <li> in <ul>
    .replace(/((?:<li>.*<\/li>\n?)+)/g, '<ul>$1</ul>')
    // Paragraphs (double newline)
    .replace(/\n\n/g, '</p><p>')
    // Single newlines to <br>
    .replace(/\n/g, '<br>');
  return `<p>${html}</p>`;
}

function researchIcon(type: string): string {
  return type === "reference" ? "📎" : type === "comment" ? "💬" : "📝";
}

function generateSpec(db: ProjectFile): object {
  const elements: Record<string, any> = {};
  const rootChildren: string[] = [];
  let counter = 0;
  const id = () => `el-${++counter}`;

  const add = (type: string, props: any, children?: string[]): string => {
    const eid = id();
    elements[eid] = { type, props, children: children ?? [] };
    return eid;
  };

  // ─── Header ──────────────────────────────────────────────────────────
  const headerTitle = add("Heading", { text: "📊 Project Dashboard", level: "h1" });
  const headerSub = add("Text", {
    text: `${process.cwd()} · ${db.epics.length} epics · ${db.issues.length} issues · ${db.assets.length} assets`,
    variant: "muted",
  });
  rootChildren.push(add("Stack", { direction: "vertical", gap: "sm", align: null, justify: null }, [headerTitle, headerSub]));
  rootChildren.push(add("Separator", { orientation: null }));

  // ─── Helper: build full issue card (expandable) ──────────────────────
  function buildIssueContent(issue: Issue): string[] {
    const parts: string[] = [];

    // Description
    if (issue.description) {
      parts.push(add("Text", { text: issue.description, variant: "body" }));
    }

    // Linked issues
    if (issue.linkedIssueIds && issue.linkedIssueIds.length > 0) {
      const linkedNames = issue.linkedIssueIds.map(lid => {
        const linked = db.issues.find(i => i.id === lid);
        return linked ? `\`${lid}\` ${linked.title}` : `\`${lid}\`` ;
      }).join(", ");
      parts.push(add("Text", { text: `**Linked:** ${linkedNames}`, variant: "muted" }));
    }

    // Questions
    if (issue.questions && issue.questions.length > 0) {
      parts.push(add("Text", { text: `**Questions** (${issue.questions.filter(q => q.answer).length}/${issue.questions.length} answered)`, variant: "body" }));
      for (const q of issue.questions) {
        const req = q.required !== false ? " 🔴" : " ⚪";
        if (q.answer) {
          parts.push(add("Text", { text: `> ❓ ${q.text}${req}\n>\n> ✅ ${q.answer}`, variant: "body" }));
        } else {
          parts.push(add("Text", { text: `> ❓ ${q.text}${req}\n>\n> _Unanswered_`, variant: "muted" }));
        }
      }
    }

    // Research notes
    if (issue.research && issue.research.length > 0) {
      parts.push(add("Separator", { orientation: null }));
      parts.push(add("Heading", { text: `🔬 Research (${issue.research.length})`, level: "h3" }));
      const rItems = issue.research.map(r => ({
        title: `${researchIcon(r.type)} ${r.type.toUpperCase()} — ${r.addedAt.split("T")[0]}`,
        content: r.content,
      }));
      parts.push(add("Accordion", { items: rItems, type: "single" }));
    }

    // Close info
    if (issue.status === "closed" && issue.closeMessage) {
      parts.push(add("Alert", {
        title: "Closed",
        message: issue.closeMessage,
        type: "success",
      }));
      if (issue.validations && issue.validations.length > 0) {
        for (const v of issue.validations) {
          parts.push(add("Text", { text: `${v.met ? "✅" : "❌"} **${v.criterion}**\n${v.evidence}`, variant: "muted" }));
        }
      }
    }

    return parts;
  }

  // ─── Helper: build issue as an accordion item ────────────────────────
  // Returns HTML directly for better UX control (not markdown)
  function issueAccordionItem(issue: Issue): { title: string; content: string; id?: string; isHtml?: boolean } {
    const sections: string[] = [];

    // Description (render as markdown)
    if (issue.description) {
      sections.push(`<div class="issue-section"><div class="md-content">${mdToHtml(issue.description)}</div></div>`);
    }

    // Linked issues
    if (issue.linkedIssueIds && issue.linkedIssueIds.length > 0) {
      const links = issue.linkedIssueIds.map(lid => {
        const linked = db.issues.find(i => i.id === lid);
        if (linked) {
          return `<a href="#issue-${lid}" class="issue-link">${typeIcon(linked.type)} ${lid} — ${linked.title}</a>`;
        }
        return `<code>${lid}</code>`;
      }).join("");
      sections.push(`<div class="issue-section"><div class="section-label">🔗 Linked Issues</div>${links}</div>`);
    }

    // Questions
    if (issue.questions && issue.questions.length > 0) {
      const answered = issue.questions.filter(q => q.answer).length;
      let qHtml = `<div class="section-label">❓ Questions (${answered}/${issue.questions.length} answered)</div>`;
      for (const q of issue.questions) {
        const req = q.required !== false;
        const reqLabel = req ? `<span class="req-badge req-required">required</span>` : `<span class="req-badge req-optional">optional</span>`;
        if (q.answer) {
          qHtml += `<div class="question-card answered">
            <div class="question-text">${esc(q.text)} ${reqLabel}</div>
            <div class="answer-text">✅ ${esc(q.answer)}</div>
          </div>`;
        } else {
          qHtml += `<div class="question-card unanswered">
            <div class="question-text">${esc(q.text)} ${reqLabel}</div>
            <div class="answer-text unanswered-label">Awaiting answer</div>
          </div>`;
        }
      }
      sections.push(`<div class="issue-section">${qHtml}</div>`);
    }

    // Research notes
    if (issue.research && issue.research.length > 0) {
      let rHtml = `<div class="section-label">🔬 Research (${issue.research.length})</div>`;
      for (const r of issue.research) {
        const typeClass = r.type === "reference" ? "ref" : r.type === "comment" ? "cmt" : "ex";
        rHtml += `<details class="research-item research-${typeClass}">
          <summary>${researchIcon(r.type)} <strong>${r.type.toUpperCase()}</strong> — ${r.addedAt.split("T")[0]}</summary>
          <div class="md-content">${mdToHtml(r.content)}</div>
        </details>`;
      }
      sections.push(`<div class="issue-section">${rHtml}</div>`);
    }

    // Close info
    if (issue.status === "closed" && issue.closeMessage) {
      let closeHtml = `<div class="close-banner">✅ <strong>Closed:</strong> ${esc(issue.closeMessage)}</div>`;
      if (issue.validations && issue.validations.length > 0) {
        for (const v of issue.validations) {
          closeHtml += `<div class="validation-item">${v.met ? "✅" : "❌"} <strong>${esc(v.criterion)}</strong> — ${esc(v.evidence)}</div>`;
        }
      }
      sections.push(`<div class="issue-section">${closeHtml}</div>`);
    }

    // Epic back-link
    if (issue.epicId) {
      const epic = db.epics.find(e => e.id === issue.epicId);
      if (epic) {
        sections.push(`<div class="issue-section"><a href="#epic-${epic.id}" class="epic-backlink">📋 Epic: ${epic.id} — ${esc(epic.title)}</a></div>`);
      }
    }

    return {
      title: `${typeIcon(issue.type)} [${issue.id}] ${issue.title} — ${statusLabel("issue", issue.status)}`,
      content: sections.join(""),
      id: `issue-${issue.id}`,
      isHtml: true,
    };
  }

  function esc(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  // ─── Epics (with issues inside) ──────────────────────────────────────
  for (const epic of db.epics) {
    const epicChildren: string[] = [];

    // Status + priority badges
    const statusBadge = add("Badge", { text: statusLabel("epic", epic.status), variant: epic.status === "closed" ? "secondary" : "default" });
    const priorityBadge = add("Badge", { text: `P${epic.priority}`, variant: "outline" });
    epicChildren.push(add("Stack", { direction: "horizontal", gap: "sm", align: null, justify: null }, [statusBadge, priorityBadge]));

    // Description
    if (epic.description) {
      epicChildren.push(add("Text", { text: epic.description, variant: "body" }));
    }

    // Todos
    if (epic.todos.length > 0) {
      epicChildren.push(add("Text", { text: `**Todos** (${epic.todos.filter(t => t.done).length}/${epic.todos.length})`, variant: "body" }));
      const todoItems = epic.todos.map(todo => add("Text", {
        text: `${todo.done ? "✅" : "⬜"} ${todo.text}`,
        variant: todo.done ? "muted" : "body",
      }));
      epicChildren.push(add("Stack", { direction: "vertical", gap: "sm", align: null, justify: null }, todoItems));
    }

    // Success criteria
    if (epic.successCriteria.length > 0) {
      epicChildren.push(add("Text", { text: "**Success Criteria:**", variant: "body" }));
      const scItems = epic.successCriteria.map(sc => add("Text", { text: `• ${sc}`, variant: "muted" }));
      epicChildren.push(add("Stack", { direction: "vertical", gap: "sm", align: null, justify: null }, scItems));
    }

    // Relevant files
    if (epic.relevantFiles && epic.relevantFiles.length > 0) {
      epicChildren.push(add("Text", { text: "**Relevant Files:**", variant: "body" }));
      const fileItems = epic.relevantFiles.map(f => add("Text", { text: `\`${f.file}\` — ${f.reason}`, variant: "muted" }));
      epicChildren.push(add("Stack", { direction: "vertical", gap: "sm", align: null, justify: null }, fileItems));
    }

    // Epic research notes
    if (epic.research.length > 0) {
      epicChildren.push(add("Separator", { orientation: null }));
      epicChildren.push(add("Heading", { text: `🔬 Research (${epic.research.length})`, level: "h3" }));
      const rItems = epic.research.map(r => ({
        title: `${researchIcon(r.type)} ${r.type.toUpperCase()} — ${r.addedAt.split("T")[0]}`,
        content: r.content,
      }));
      epicChildren.push(add("Accordion", { items: rItems, type: "single" }));
    }

    // ── Issues inside this epic (as expandable accordion) ──────────────
    const linkedIssues = db.issues.filter(i => i.epicId === epic.id);
    if (linkedIssues.length > 0) {
      epicChildren.push(add("Separator", { orientation: null }));
      const openCount = linkedIssues.filter(i => i.status !== "closed").length;
      const closedCount = linkedIssues.length - openCount;
      epicChildren.push(add("Text", { text: `**Issues** (${openCount} open, ${closedCount} closed)`, variant: "body" }));

      const issueItems = linkedIssues.map(issue => issueAccordionItem(issue));
      epicChildren.push(add("Accordion", { items: issueItems, type: "single" }));
    }

    rootChildren.push(add("Card", {
      title: `[${epic.id}] ${epic.title}`,
      description: null,
      maxWidth: "full",
      centered: null,
      anchorId: `epic-${epic.id}`,
    }, epicChildren));
  }

  // ─── Unlinked Issues (virtual epic container) ────────────────────────
  const unlinkedIssues = db.issues.filter(i => !i.epicId);
  if (unlinkedIssues.length > 0) {
    const unlinkedChildren: string[] = [];
    unlinkedChildren.push(add("Badge", { text: `${unlinkedIssues.length} issue(s)`, variant: "outline" }));

    const issueItems = unlinkedIssues.map(issue => issueAccordionItem(issue));
    unlinkedChildren.push(add("Accordion", { items: issueItems, type: "single" }));

    rootChildren.push(add("Card", {
      title: "📋 Unlinked Issues",
      description: null,
      maxWidth: "full",
      centered: null,
    }, unlinkedChildren));
  }

  // ─── Assets ──────────────────────────────────────────────────────────
  if (db.assets.length > 0) {
    const assetChildren: string[] = [];

    const byCategory: Record<string, Asset[]> = {};
    for (const a of db.assets) {
      (byCategory[a.categorySlug] ??= []).push(a);
    }

    const catItems = Object.entries(byCategory).map(([slug, assets]) => {
      const catDesc = db.categories.find(c => c.slug === slug)?.description || slug;
      const lines = [`*${catDesc}*\n`];
      for (const a of assets) {
        lines.push(`### [${a.id}] ${a.title}${a.project ? " 📌 project" : ""}${a.trigger ? ` ⚡${a.trigger.event}` : ""}`);
        lines.push(`*${a.context}*\n`);
        lines.push(a.body);
        lines.push("");
        if (a.sources && a.sources.length > 0) {
          lines.push("**Sources:**");
          for (const s of a.sources) {
            lines.push(`- ${s.type === "url" ? `[${s.path}](${s.path})` : `\`${s.path}\``} — ${s.description}`);
          }
          lines.push("");
        }
      }
      return { title: `${slug} (${assets.length})`, content: lines.join("\n") };
    });

    assetChildren.push(add("Accordion", { items: catItems, type: "single" }));

    rootChildren.push(add("Card", {
      title: `📦 Assets (${db.assets.length})`,
      description: null,
      maxWidth: "full",
      centered: null,
    }, assetChildren));
  }

  // ─── Root ────────────────────────────────────────────────────────────
  const root = add("Stack", { direction: "vertical", gap: "lg", align: null, justify: null }, rootChildren);
  return { root, elements };
}

function statusLabel(kind: "epic" | "issue", status: string): string {
  const epicIcons: Record<string, string> = { draft: "📝", planned: "📋", "in-progress": "🔧", closed: "🏁" };
  const issueIcons: Record<string, string> = { draft: "📝", researched: "🔬", ready: "✅", "in-progress": "🔧", closed: "🏁" };
  const icons = kind === "epic" ? epicIcons : issueIcons;
  return `${icons[status] || ""} ${status}`;
}

function typeIcon(type: string): string {
  const icons: Record<string, string> = { bug: "🐛", feature: "✨", chore: "🔧", spike: "🔍", idea: "💭" };
  return icons[type] || "📄";
}

// ─── HTML template ───────────────────────────────────────────────────────────

function generateHTML(projectId: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Project Dashboard</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html { scroll-behavior: smooth; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0a0a0b;
      color: #fafafa;
      min-height: 100vh;
    }
    /* Highlight target anchor briefly */
    :target { animation: highlight 2s ease; }
    @keyframes highlight { 0%,30% { outline: 2px solid #3b82f6; outline-offset: 4px; } 100% { outline-color: transparent; } }
    #app { max-width: 1200px; margin: 0 auto; padding: 24px; }
    #connection-status {
      position: fixed; top: 12px; right: 12px; padding: 4px 12px;
      border-radius: 9999px; font-size: 12px; z-index: 50;
    }
    .connected { background: #166534; color: #bbf7d0; }
    .disconnected { background: #991b1b; color: #fecaca; }

    /* Copy reference button */
    .copy-ref {
      opacity: 0; transition: opacity 0.15s; cursor: pointer;
      background: #27272a; border: 1px solid #3f3f46; border-radius: 4px;
      padding: 2px 6px; font-size: 11px; color: #a1a1aa;
      position: absolute; top: 8px; right: 8px;
    }
    .copy-ref:hover { background: #3f3f46; color: #fafafa; }
    .ref-container { position: relative; }
    .ref-container:hover .copy-ref { opacity: 1; }

    /* Toast */
    #toast {
      position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%);
      background: #166534; color: #bbf7d0; padding: 8px 16px;
      border-radius: 8px; font-size: 13px; opacity: 0;
      transition: opacity 0.2s; pointer-events: none; z-index: 100;
    }
    #toast.show { opacity: 1; }

    /* Markdown rendered content */
    .md-content h1, .md-content h2, .md-content h3 { color: #fafafa; margin: 8px 0 4px; }
    .md-content h1 { font-size: 20px; } .md-content h2 { font-size: 17px; } .md-content h3 { font-size: 15px; }
    .md-content p { margin: 4px 0; }
    .md-content ul, .md-content ol { margin: 4px 0; padding-left: 20px; }
    .md-content li { margin: 2px 0; }
    .md-content code { background: #27272a; padding: 1px 5px; border-radius: 3px; font-size: 12px; color: #e4e4e7; }
    .md-content pre { background: #0f0f11; border: 1px solid #27272a; border-radius: 6px; padding: 10px; overflow-x: auto; margin: 6px 0; }
    .md-content pre code { background: none; padding: 0; }
    .md-content a { color: #60a5fa; text-decoration: underline; }
    .md-content strong { color: #fafafa; }
    .md-content blockquote { border-left: 3px solid #3f3f46; padding-left: 10px; color: #a1a1aa; margin: 6px 0; }
    .md-content table { border-collapse: collapse; width: 100%; margin: 6px 0; }
    .md-content th, .md-content td { border: 1px solid #27272a; padding: 4px 8px; font-size: 12px; }
    .md-content th { background: #18181b; color: #a1a1aa; }

    /* Issue sections */
    .issue-section { margin: 12px 0; }
    .section-label { font-size: 15px; font-weight: 700; color: #fafafa; margin-bottom: 8px; padding-bottom: 4px; border-bottom: 1px solid #27272a; }

    /* Question cards */
    .question-card { background: #1c1c20; border: 1px solid #27272a; border-radius: 8px; padding: 12px 16px; margin: 8px 0; }
    .question-card.answered { border-left: 3px solid #22c55e; }
    .question-card.unanswered { border-left: 3px solid #f59e0b; }
    .question-text { font-size: 15px; color: #e4e4e7; margin-bottom: 6px; }
    .answer-text { font-size: 14px; color: #a1a1aa; }
    .unanswered-label { color: #f59e0b; font-style: italic; }
    .req-badge { font-size: 11px; padding: 1px 6px; border-radius: 4px; margin-left: 6px; vertical-align: middle; }
    .req-required { background: #7f1d1d; color: #fca5a5; }
    .req-optional { background: #27272a; color: #71717a; }

    /* Research items */
    .research-item { background: #1c1c20; border: 1px solid #27272a; border-radius: 8px; margin: 8px 0; overflow: hidden; }
    .research-item summary { padding: 10px 14px; cursor: pointer; font-size: 14px; color: #e4e4e7; list-style: none; }
    .research-item summary::-webkit-details-marker { display: none; }
    .research-item summary::before { content: "▸ "; }
    .research-item[open] summary::before { content: "▾ "; }
    .research-item .md-content { padding: 0 14px 14px; }
    .research-ref { border-left: 3px solid #3b82f6; }
    .research-cmt { border-left: 3px solid #a78bfa; }
    .research-ex { border-left: 3px solid #34d399; }

    /* Links */
    .issue-link { display: block; padding: 6px 12px; margin: 4px 0; background: #1c1c20; border: 1px solid #27272a; border-radius: 6px; color: #60a5fa; text-decoration: none; font-size: 14px; }
    .issue-link:hover { background: #27272a; }
    .epic-backlink { color: #60a5fa; text-decoration: none; font-size: 14px; }
    .epic-backlink:hover { text-decoration: underline; }

    /* Close banner */
    .close-banner { background: #14532d22; border: 1px solid #166534; border-radius: 8px; padding: 10px 14px; font-size: 14px; color: #bbf7d0; }
    .validation-item { font-size: 13px; color: #a1a1aa; margin: 4px 0 4px 8px; }
  </style>
  <script type="importmap">
  {
    "imports": {
      "react": "https://esm.sh/react@19.1.0",
      "react-dom": "https://esm.sh/react-dom@19.1.0",
      "react-dom/client": "https://esm.sh/react-dom@19.1.0/client",
      "react/jsx-runtime": "https://esm.sh/react@19.1.0/jsx-runtime",
      "marked": "https://esm.sh/marked@15.0.0"
    }
  }
  </script>
</head>
<body>
  <div id="connection-status" class="disconnected">Connecting...</div>
  <div id="app"><p style="color:#a1a1aa;padding:40px;text-align:center">Loading dashboard...</p></div>
  <div id="toast"></div>

  <script type="module">
    import React from "react";
    import { createRoot } from "react-dom/client";
    import { marked } from "marked";
    const h = React.createElement;

    // Configure marked for inline rendering
    marked.setOptions({ breaks: true, gfm: true });
    function md(text) {
      if (!text) return "";
      return marked.parse(text);
    }

    // ── Toast ────────────────────────────────────────────────────────
    function showToast(msg) {
      const el = document.getElementById("toast");
      el.textContent = msg;
      el.classList.add("show");
      setTimeout(() => el.classList.remove("show"), 1500);
    }

    // ── Copy reference ───────────────────────────────────────────────
    function copyRef(text) {
      navigator.clipboard.writeText(text).then(() => showToast("Copied: " + text));
    }

    // ── Renderers ────────────────────────────────────────────────────
    const styles = {
      card: { background: "#18181b", border: "1px solid #27272a", borderRadius: 12, padding: 20, marginBottom: 12 },
      badge: { display: "inline-block", padding: "3px 12px", borderRadius: 9999, fontSize: 13, marginRight: 6, background: "#27272a", color: "#e4e4e7" },
      badgeSecondary: { display: "inline-block", padding: "3px 12px", borderRadius: 9999, fontSize: 13, marginRight: 6, background: "#3f3f46", color: "#a1a1aa" },
      badgeOutline: { display: "inline-block", padding: "3px 12px", borderRadius: 9999, fontSize: 13, marginRight: 6, border: "1px solid #3f3f46", color: "#a1a1aa" },
      heading: { h1: { fontSize: 32, fontWeight: 700, marginBottom: 10 }, h2: { fontSize: 24, fontWeight: 600, marginBottom: 10 }, h3: { fontSize: 20, fontWeight: 600, marginBottom: 6 } },
      text: { body: { color: "#e4e4e7", fontSize: 16, lineHeight: 1.7 }, muted: { color: "#a1a1aa", fontSize: 15, lineHeight: 1.6 } },
      table: { width: "100%", borderCollapse: "collapse", fontSize: 14, marginTop: 8 },
      th: { textAlign: "left", padding: "10px 14px", borderBottom: "1px solid #27272a", color: "#a1a1aa", fontWeight: 500 },
      td: { padding: "10px 14px", borderBottom: "1px solid #18181b", color: "#e4e4e7" },
      separator: { border: "none", borderTop: "1px solid #27272a", margin: "16px 0" },
      accordion: { border: "1px solid #27272a", borderRadius: 8, overflow: "hidden", marginTop: 8 },
      accordionItem: { borderBottom: "1px solid #27272a" },
      accordionTrigger: { width: "100%", background: "none", border: "none", color: "#e4e4e7", padding: "12px 16px", textAlign: "left", cursor: "pointer", fontSize: 15, fontWeight: 600 },
      accordionContent: { padding: "12px 16px", fontSize: 15, color: "#d4d4d8", lineHeight: 1.6 },
    };

    function RefWrap({ refText, children }) {
      if (!refText) return children;
      return h("div", { className: "ref-container", style: { position: "relative" } },
        h("button", { className: "copy-ref", onClick: (e) => { e.stopPropagation(); copyRef(refText); } }, "📋"),
        children
      );
    }

    function AccordionComp({ items }) {
      // Auto-open item if URL hash matches an item's id
      const [openIndex, setOpenIndex] = React.useState(() => {
        const hash = window.location.hash.slice(1);
        if (hash) {
          const idx = items.findIndex(item => item.id === hash);
          if (idx >= 0) return idx;
        }
        return null;
      });

      // Listen for hash changes to auto-open and scroll
      React.useEffect(() => {
        function onHash() {
          const hash = window.location.hash.slice(1);
          if (!hash) return;
          const idx = items.findIndex(item => item.id === hash);
          if (idx >= 0) {
            setOpenIndex(idx);
            setTimeout(() => {
              const el = document.getElementById(hash);
              if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
            }, 100);
          }
        }
        window.addEventListener("hashchange", onHash);
        // Also handle initial hash
        if (window.location.hash) onHash();
        return () => window.removeEventListener("hashchange", onHash);
      }, [items]);

      return h("div", { style: styles.accordion },
        items.map((item, i) =>
          h("div", { key: item.id || i, id: item.id || undefined, style: styles.accordionItem },
            h("button", {
              style: { ...styles.accordionTrigger, background: openIndex === i ? "#1f1f23" : "transparent" },
              onClick: () => setOpenIndex(openIndex === i ? null : i)
            }, (openIndex === i ? "▾ " : "▸ ") + item.title),
            openIndex === i ? h("div", { className: item.isHtml ? "" : "md-content", style: styles.accordionContent, dangerouslySetInnerHTML: { __html: item.isHtml ? item.content : md(item.content) } }) : null
          )
        )
      );
    }

    function renderElement(spec, elementId) {
      const el = spec.elements[elementId];
      if (!el) return null;

      const childNodes = (el.children || []).map(cid => renderElement(spec, cid)).filter(Boolean);
      const p = el.props || {};

      switch (el.type) {
        case "Stack": {
          const dir = p.direction || "vertical";
          const gapMap = { none: 0, sm: 6, md: 12, lg: 20 };
          const gap = gapMap[p.gap] ?? 12;
          const style = { display: "flex", flexDirection: dir === "horizontal" ? "row" : "column", gap, alignItems: p.align || undefined, justifyContent: p.justify || undefined };
          return h("div", { key: elementId, style }, ...childNodes);
        }
        case "Card": {
          // Extract ref from title [id]
          const refMatch = p.title?.match(/\\[([a-z0-9]+)\\]/);
          const refText = refMatch ? refMatch[1] : null;
          return h(RefWrap, { key: elementId, refText },
            h("div", { id: p.anchorId || undefined, style: styles.card },
              p.title ? h("h3", { style: { fontSize: 20, fontWeight: 700, marginBottom: 10, color: "#fafafa" } }, p.title) : null,
              p.description ? h("p", { style: styles.text.muted }, p.description) : null,
              h("div", { style: { display: "flex", flexDirection: "column", gap: 10, marginTop: p.title || p.description ? 10 : 0 } }, ...childNodes)
            )
          );
        }
        case "Heading":
          return h(p.level || "h2", { key: elementId, style: styles.heading[p.level] || styles.heading.h2 }, p.text);
        case "Text":
          return h("div", { key: elementId, className: "md-content", style: styles.text[p.variant] || styles.text.body, dangerouslySetInnerHTML: { __html: md(p.text) } });
        case "Badge": {
          const variant = p.variant || "default";
          const s = variant === "secondary" ? styles.badgeSecondary : variant === "outline" ? styles.badgeOutline : styles.badge;
          return h("span", { key: elementId, style: s }, p.text);
        }
        case "Separator":
          return h("hr", { key: elementId, style: styles.separator });
        case "Table":
          return h("div", { key: elementId, style: { overflowX: "auto" } },
            h("table", { style: styles.table },
              h("thead", null, h("tr", null, (p.columns || []).map((c, i) => h("th", { key: i, style: styles.th }, c)))),
              h("tbody", null, (p.rows || []).map((row, ri) =>
                h("tr", { key: ri, style: { background: ri % 2 === 0 ? "transparent" : "#0f0f11" } },
                  row.map((cell, ci) => h("td", { key: ci, style: styles.td }, cell))
                )
              )),
              p.caption ? h("caption", { style: { captionSide: "bottom", padding: "8px 0", color: "#71717a", fontSize: 12, textAlign: "left" } }, p.caption) : null
            )
          );
        case "Accordion":
          return h(AccordionComp, { key: elementId, items: p.items || [] });
        case "Grid": {
          const cols = p.columns || 3;
          return h("div", { key: elementId, style: { display: "grid", gridTemplateColumns: "repeat(" + cols + ", 1fr)", gap: 12 } }, ...childNodes);
        }
        case "Alert": {
          const colors = { success: "#166534", warning: "#854d0e", error: "#991b1b", info: "#1e40af" };
          const bg = colors[p.type] || colors.info;
          return h("div", { key: elementId, style: { background: bg + "22", border: "1px solid " + bg, borderRadius: 8, padding: 14 } },
            p.title ? h("strong", { style: { fontSize: 13, color: "#fafafa" } }, p.title) : null,
            p.message ? h("p", { style: { fontSize: 13, color: "#d4d4d8", marginTop: 4 } }, p.message) : null
          );
        }
        case "Progress": {
          const pct = Math.round((p.value / (p.max || 100)) * 100);
          return h("div", { key: elementId, style: { marginTop: 4 } },
            p.label ? h("p", { style: { fontSize: 12, color: "#a1a1aa", marginBottom: 4 } }, p.label + " " + pct + "%") : null,
            h("div", { style: { height: 6, background: "#27272a", borderRadius: 3, overflow: "hidden" } },
              h("div", { style: { width: pct + "%", height: "100%", background: "#3b82f6", borderRadius: 3 } })
            )
          );
        }
        default:
          return h("div", { key: elementId, style: { color: "#ef4444", fontSize: 12 } }, "Unknown: " + el.type);
      }
    }

    function App() {
      const [spec, setSpec] = React.useState(null);
      const [connected, setConnected] = React.useState(false);

      React.useEffect(() => {
        let es;
        function connect() {
          es = new EventSource("/events");
          es.onopen = () => { setConnected(true); document.getElementById("connection-status").className = "connected"; document.getElementById("connection-status").textContent = "Live"; };
          es.onmessage = (e) => {
            try { setSpec(JSON.parse(e.data)); } catch {}
          };
          es.onerror = () => {
            setConnected(false);
            document.getElementById("connection-status").className = "disconnected";
            document.getElementById("connection-status").textContent = "Reconnecting...";
            es.close();
            setTimeout(connect, 2000);
          };
        }
        // Initial fetch
        fetch("/api/spec").then(r => r.json()).then(setSpec).catch(() => {});
        connect();
        return () => es?.close();
      }, []);

      if (!spec) return h("p", { style: { color: "#71717a", textAlign: "center", padding: 40 } }, "Loading...");
      return h("div", { id: "dashboard" }, renderElement(spec, spec.root));
    }

    const root = createRoot(document.getElementById("app"));
    root.render(h(App));
  </script>
</body>
</html>`;
}

// ─── Server ──────────────────────────────────────────────────────────────────

async function findPort(start: number): Promise<number> {
  const net = await import("net");
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(start, () => {
      server.close(() => resolve(start));
    });
    server.on("error", () => {
      resolve(findPort(start + 1));
    });
  });
}

export async function startServer(): Promise<{ port: number; projectId: string; url: string }> {
  if (activeServer) {
    return { port: activeServer.port, projectId: activeServer.projectId, url: `http://localhost:${activeServer.port}` };
  }

  // Check lock file — is a server already running from a previous session?
  const lock = readLock();
  if (lock) {
    const alive = await isPortListening(lock.port);
    if (alive) {
      // Re-adopt the existing server (we can't control it, but we know it's there)
      activeServer = {
        port: lock.port,
        projectId: lock.projectId,
        close: () => {
          // Can't close a server from a previous session, just clear the reference
          removeLock();
          activeServer = null;
        },
      };
      return { port: lock.port, projectId: lock.projectId, url: `http://localhost:${lock.port}` };
    } else {
      // Stale lock file
      removeLock();
    }
  }

  const projectId = getProjectId();
  const port = await findPort(3100);
  const clients: SSEClient[] = [];

  function broadcastSpec() {
    try {
      const db = load();
      const spec = generateSpec(db);
      const data = JSON.stringify(spec);
      for (let i = clients.length - 1; i >= 0; i--) {
        try {
          clients[i].res.write(`data: ${data}\n\n`);
        } catch {
          clients.splice(i, 1);
        }
      }
    } catch {}
  }

  const html = generateHTML(projectId);

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url || "/";

    // CORS
    res.setHeader("Access-Control-Allow-Origin", "*");

    if (url === "/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      const client: SSEClient = { res };
      clients.push(client);

      // Send initial spec
      try {
        const db = load();
        const spec = generateSpec(db);
        res.write(`data: ${JSON.stringify(spec)}\n\n`);
      } catch {}

      req.on("close", () => {
        const idx = clients.indexOf(client);
        if (idx >= 0) clients.splice(idx, 1);
      });
      return;
    }

    if (url === "/api/spec") {
      try {
        const db = load();
        const spec = generateSpec(db);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(spec));
      } catch (e: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }

    // Serve HTML for everything else
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(html);
  });

  server.listen(port);

  // Watch database file for changes
  const dbPath = projectPath();
  let debounce: ReturnType<typeof setTimeout> | null = null;
  if (existsSync(dbPath)) {
    watchFile(dbPath, { interval: 500 }, () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(broadcastSpec, 200);
    });
  }

  writeLock(port, projectId);

  activeServer = {
    port,
    projectId,
    close: () => {
      server.close();
      if (existsSync(dbPath)) unwatchFile(dbPath);
      for (const c of clients) try { c.res.end(); } catch {}
      clients.length = 0;
      removeLock();
      activeServer = null;
    },
  };

  return { port, projectId, url: `http://localhost:${port}` };
}

export function stopServer(): boolean {
  if (activeServer) {
    activeServer.close();
    return true;
  }
  return false;
}

export function isServerRunning(): boolean {
  return activeServer !== null;
}

/** Call on extension load to re-adopt a server from a previous session */
export async function initFromLock(): Promise<void> {
  if (activeServer) return;
  const lock = readLock();
  if (!lock) return;
  const alive = await isPortListening(lock.port);
  if (alive) {
    activeServer = {
      port: lock.port,
      projectId: lock.projectId,
      close: () => { removeLock(); activeServer = null; },
    };
  } else {
    removeLock();
  }
}

export function getServerInfo(): { port: number; url: string } | null {
  if (activeServer) {
    return { port: activeServer.port, url: `http://localhost:${activeServer.port}` };
  }
  // Check lock file for server from previous session
  const lock = readLock();
  if (lock) {
    return { port: lock.port, url: `http://localhost:${lock.port}` };
  }
  return null;
}
