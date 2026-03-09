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

function generateSpec(db: ProjectFile): object {
  const elements: Record<string, any> = {};
  const rootChildren: string[] = [];
  let counter = 0;
  const id = () => `el-${++counter}`;

  // Helper to add element
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
  const headerStack = add("Stack", { direction: "vertical", gap: "sm", align: null, justify: null }, [headerTitle, headerSub]);
  rootChildren.push(headerStack);
  rootChildren.push(add("Separator", { orientation: null }));

  // ─── Epics ───────────────────────────────────────────────────────────
  if (db.epics.length > 0) {
    const epicsSectionTitle = add("Heading", { text: "Epics", level: "h2" });
    rootChildren.push(epicsSectionTitle);

    for (const epic of db.epics) {
      const epicChildren: string[] = [];

      // Status + priority badges
      const statusBadge = add("Badge", { text: statusLabel("epic", epic.status), variant: epic.status === "closed" ? "secondary" : "default" });
      const priorityBadge = add("Badge", { text: `P${epic.priority}`, variant: "outline" });
      const badgeRow = add("Stack", { direction: "horizontal", gap: "sm", align: null, justify: null }, [statusBadge, priorityBadge]);
      epicChildren.push(badgeRow);

      // Description
      if (epic.description) {
        epicChildren.push(add("Text", { text: epic.description, variant: "body" }));
      }

      // Todos
      if (epic.todos.length > 0) {
        const todoItems: string[] = [];
        for (const todo of epic.todos) {
          todoItems.push(add("Text", {
            text: `${todo.done ? "✅" : "⬜"} ${todo.text}`,
            variant: todo.done ? "muted" : "body",
          }));
        }
        const todosLabel = add("Text", { text: `**Todos** (${epic.todos.filter(t => t.done).length}/${epic.todos.length})`, variant: "body" });
        epicChildren.push(todosLabel);
        epicChildren.push(add("Stack", { direction: "vertical", gap: "sm", align: null, justify: null }, todoItems));
      }

      // Success criteria
      if (epic.successCriteria.length > 0) {
        const scLabel = add("Text", { text: "**Success Criteria:**", variant: "body" });
        const scItems = epic.successCriteria.map(sc => add("Text", { text: `• ${sc}`, variant: "muted" }));
        epicChildren.push(scLabel);
        epicChildren.push(add("Stack", { direction: "vertical", gap: "sm", align: null, justify: null }, scItems));
      }

      // Linked issues
      const linkedIssues = db.issues.filter(i => i.epicId === epic.id);
      if (linkedIssues.length > 0) {
        const rows = linkedIssues.map(i => [
          `${typeIcon(i.type)} ${i.type}`,
          i.title,
          statusLabel("issue", i.status),
          i.id,
        ]);
        epicChildren.push(add("Table", {
          columns: ["Type", "Title", "Status", "ID"],
          rows,
          caption: `${linkedIssues.length} linked issue(s)`,
        }));
      }

      // Research notes
      if (epic.research.length > 0) {
        const accordionItems = epic.research.map(r => ({
          title: `${r.type} — ${r.addedAt.split("T")[0]}`,
          content: r.content,
        }));
        epicChildren.push(add("Accordion", { items: accordionItems, type: "single" }));
      }

      const epicCard = add("Card", {
        title: `[${epic.id}] ${epic.title}`,
        description: null,
        maxWidth: "full",
        centered: null,
      }, epicChildren);
      rootChildren.push(epicCard);
    }

    rootChildren.push(add("Separator", { orientation: null }));
  }

  // ─── Issues (unlinked) ──────────────────────────────────────────────
  const unlinkedIssues = db.issues.filter(i => !i.epicId);
  if (unlinkedIssues.length > 0) {
    rootChildren.push(add("Heading", { text: "Unlinked Issues", level: "h2" }));

    for (const issue of unlinkedIssues) {
      rootChildren.push(buildIssueCard(issue, add));
    }
    rootChildren.push(add("Separator", { orientation: null }));
  }

  // Also show all issues in a summary table
  if (db.issues.length > 0) {
    rootChildren.push(add("Heading", { text: "All Issues", level: "h2" }));
    const rows = db.issues.map(i => [
      i.id,
      `${typeIcon(i.type)} ${i.type}`,
      i.title,
      statusLabel("issue", i.status),
      i.epicId || "—",
    ]);
    rootChildren.push(add("Table", {
      columns: ["ID", "Type", "Title", "Status", "Epic"],
      rows,
      caption: `${db.issues.length} total issue(s)`,
    }));
    rootChildren.push(add("Separator", { orientation: null }));
  }

  // ─── Assets ──────────────────────────────────────────────────────────
  if (db.assets.length > 0) {
    rootChildren.push(add("Heading", { text: "Assets", level: "h2" }));

    const byCategory: Record<string, Asset[]> = {};
    for (const a of db.assets) {
      (byCategory[a.categorySlug] ??= []).push(a);
    }

    const accordionItems = Object.entries(byCategory).map(([slug, assets]) => {
      const catDesc = db.categories.find(c => c.slug === slug)?.description || slug;
      const assetLines = assets.map(a =>
        `**[${a.id}] ${a.title}**${a.project ? " 📌" : ""}\n${a.context}\n`
      ).join("\n");
      return { title: `${slug} (${assets.length})`, content: `${catDesc}\n\n${assetLines}` };
    });

    rootChildren.push(add("Accordion", { items: accordionItems, type: "single" }));
  }

  // ─── Root ────────────────────────────────────────────────────────────
  const root = add("Stack", { direction: "vertical", gap: "lg", align: null, justify: null }, rootChildren);

  return { root, elements };
}

function buildIssueCard(issue: Issue, add: (type: string, props: any, children?: string[]) => string): string {
  const children: string[] = [];

  // Badges
  const typeBadge = add("Badge", { text: `${typeIcon(issue.type)} ${issue.type}`, variant: "default" });
  const statusBadge = add("Badge", { text: statusLabel("issue", issue.status), variant: issue.status === "closed" ? "secondary" : "default" });
  const badgeRow = add("Stack", { direction: "horizontal", gap: "sm", align: null, justify: null }, [typeBadge, statusBadge]);
  children.push(badgeRow);

  // Description
  if (issue.description) {
    children.push(add("Text", { text: issue.description, variant: "body" }));
  }

  // Questions
  if (issue.questions.length > 0) {
    const qItems = issue.questions.map(q => ({
      title: `❓ ${q.text}`,
      content: q.answer || "_Unanswered_",
    }));
    children.push(add("Accordion", { items: qItems, type: "single" }));
  }

  // Research
  if (issue.research.length > 0) {
    const rItems = issue.research.map(r => ({
      title: `${r.type} — ${r.addedAt.split("T")[0]}`,
      content: r.content,
    }));
    children.push(add("Accordion", { items: rItems, type: "single" }));
  }

  return add("Card", {
    title: `[${issue.id}] ${issue.title}`,
    description: null,
    maxWidth: "full",
    centered: null,
  }, children);
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
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0a0a0b;
      color: #fafafa;
      min-height: 100vh;
    }
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
  </style>
  <script type="importmap">
  {
    "imports": {
      "react": "https://esm.sh/react@19.1.0",
      "react-dom": "https://esm.sh/react-dom@19.1.0",
      "react-dom/client": "https://esm.sh/react-dom@19.1.0/client",
      "react/jsx-runtime": "https://esm.sh/react@19.1.0/jsx-runtime"
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
    const h = React.createElement;

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
      badge: { display: "inline-block", padding: "2px 10px", borderRadius: 9999, fontSize: 12, marginRight: 4, background: "#27272a", color: "#e4e4e7" },
      badgeSecondary: { display: "inline-block", padding: "2px 10px", borderRadius: 9999, fontSize: 12, marginRight: 4, background: "#3f3f46", color: "#a1a1aa" },
      badgeOutline: { display: "inline-block", padding: "2px 10px", borderRadius: 9999, fontSize: 12, marginRight: 4, border: "1px solid #3f3f46", color: "#a1a1aa" },
      heading: { h1: { fontSize: 28, fontWeight: 700, marginBottom: 8 }, h2: { fontSize: 22, fontWeight: 600, marginBottom: 8 }, h3: { fontSize: 18, fontWeight: 600, marginBottom: 4 } },
      text: { body: { color: "#e4e4e7", fontSize: 14, lineHeight: 1.6 }, muted: { color: "#71717a", fontSize: 13, lineHeight: 1.5 } },
      table: { width: "100%", borderCollapse: "collapse", fontSize: 13, marginTop: 8 },
      th: { textAlign: "left", padding: "8px 12px", borderBottom: "1px solid #27272a", color: "#a1a1aa", fontWeight: 500 },
      td: { padding: "8px 12px", borderBottom: "1px solid #18181b", color: "#e4e4e7" },
      separator: { border: "none", borderTop: "1px solid #27272a", margin: "16px 0" },
      accordion: { border: "1px solid #27272a", borderRadius: 8, overflow: "hidden", marginTop: 8 },
      accordionItem: { borderBottom: "1px solid #27272a" },
      accordionTrigger: { width: "100%", background: "none", border: "none", color: "#e4e4e7", padding: "10px 14px", textAlign: "left", cursor: "pointer", fontSize: 13, fontWeight: 500 },
      accordionContent: { padding: "10px 14px", fontSize: 13, color: "#a1a1aa", whiteSpace: "pre-wrap", lineHeight: 1.5 },
    };

    function RefWrap({ refText, children }) {
      if (!refText) return children;
      return h("div", { className: "ref-container", style: { position: "relative" } },
        h("button", { className: "copy-ref", onClick: (e) => { e.stopPropagation(); copyRef(refText); } }, "📋"),
        children
      );
    }

    function AccordionComp({ items }) {
      const [openIndex, setOpenIndex] = React.useState(null);
      return h("div", { style: styles.accordion },
        items.map((item, i) =>
          h("div", { key: i, style: styles.accordionItem },
            h("button", {
              style: { ...styles.accordionTrigger, background: openIndex === i ? "#1f1f23" : "transparent" },
              onClick: () => setOpenIndex(openIndex === i ? null : i)
            }, (openIndex === i ? "▾ " : "▸ ") + item.title),
            openIndex === i ? h("div", { style: styles.accordionContent }, item.content) : null
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
            h("div", { style: styles.card },
              p.title ? h("h3", { style: { fontSize: 16, fontWeight: 600, marginBottom: 8, color: "#fafafa" } }, p.title) : null,
              p.description ? h("p", { style: styles.text.muted }, p.description) : null,
              h("div", { style: { display: "flex", flexDirection: "column", gap: 10, marginTop: p.title || p.description ? 10 : 0 } }, ...childNodes)
            )
          );
        }
        case "Heading":
          return h(p.level || "h2", { key: elementId, style: styles.heading[p.level] || styles.heading.h2 }, p.text);
        case "Text":
          return h("p", { key: elementId, style: styles.text[p.variant] || styles.text.body }, p.text);
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
