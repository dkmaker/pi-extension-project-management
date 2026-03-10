import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { Epic } from "./types.js";
import { EPIC_TRANSITIONS, EPIC_NEXT, type CloseReason } from "./types.js";
import { load, save, genId, now, activeEpics } from "./store.js";
import { formatEpic, formatIssue } from "./format.js";
import { EPIC_STATUS_LABEL } from "./constants.js";
import { getConfigValue } from "./config.js";
import { isGitRepo, branchExists, createBranch, epicBranchName, defaultBranch, isMergedInto } from "./git.js";

function adviceFor(epic: Epic, issues: { epicId?: string; status: string }[]): string {
  const linked = issues.filter((i) => i.epicId === epic.id);
  const openIssues = linked.filter((i) => i.status !== "closed");
  const readyIssues = linked.filter((i) => i.status === "ready");
  const researchCount = epic.research.length;

  switch (epic.status) {
    case "draft": {
      const gaps: string[] = [];
      if (!epic.body) gaps.push("Add a detailed **body** with approach/plan");
      if (!epic.successCriteria.length) gaps.push("Define **success criteria**");
      if (!researchCount) gaps.push("Add **research** notes (examples, references, comments)");
      if (!linked.length) gaps.push("Link **issues** (bugs/features) to this epic");
      if (gaps.length) return `Before advancing to **planned**:\n${gaps.map((g) => `- ${g}`).join("\n")}\n\nCurrently: ${researchCount} research, ${linked.length} issues, ${epic.successCriteria.length} criteria`;
      return "✅ Looks ready to advance to **planned**.";
    }
    case "planned": {
      const gaps: string[] = [];
      if (!readyIssues.length && linked.length) gaps.push(`No linked issues are **ready** yet (${openIssues.length} still need research)`);
      if (!epic.todos.length) gaps.push("Add **todos** to break down the work");
      if (!researchCount) gaps.push("⚠️ No research — work is **not validated**");
      if (gaps.length) return `Before advancing to **in-progress**:\n${gaps.map((g) => `- ${g}`).join("\n")}`;
      return "✅ Looks ready to start work.";
    }
    case "in-progress": {
      const todosDone = epic.todos.filter((t) => t.done).length;
      const todosTotal = epic.todos.length;
      const gaps: string[] = [];
      if (todosTotal && todosDone < todosTotal) gaps.push(`Todos: ${todosDone}/${todosTotal} complete`);
      if (openIssues.length) gaps.push(`${openIssues.length} linked issue(s) still open`);
      if (gaps.length) return `Before closing:\n${gaps.map((g) => `- ${g}`).join("\n")}`;
      return "✅ All done — ready to close with a summary.";
    }
    default:
      return "";
  }
}

export function registerEpicTools(pi: ExtensionAPI) {
  pi.registerTool({
    name: "epic_add",
    label: "Epic: Add",
    description: "Add a new epic (draft). Use project_tool_docs('epic_add') for full usage.",
    parameters: Type.Object({
      title: Type.String({ description: "Short title" }),
      description: Type.String({ description: "Markdown summary (1-3 sentences)" }),
      body: Type.Optional(Type.String({ description: "Detailed markdown body" })),
      priority: Type.Optional(Type.Number({ description: "Explicit priority number" })),
      insert_before: Type.Optional(Type.String({ description: "Epic ID to insert before" })),
      insert_after: Type.Optional(Type.String({ description: "Epic ID to insert after" })),
      relevant_files: Type.Optional(Type.Array(Type.Object({ file: Type.String(), reason: Type.String() }), { description: "Related files" })),
      todos: Type.Optional(Type.Array(Type.String(), { description: "Todo items" })),
      success_criteria: Type.Optional(Type.Array(Type.String(), { description: "Success criteria" })),
    }),
    async execute(_id, params) {
      const r = load();
      let priority: number;

      if (params.insert_before) {
        const ref = r.epics.find((e) => e.id === params.insert_before);
        if (!ref) return { content: [{ type: "text", text: `Epic '${params.insert_before}' not found.` }] };
        priority = ref.priority;
        for (const e of r.epics) if (e.priority >= priority) e.priority++;
      } else if (params.insert_after) {
        const ref = r.epics.find((e) => e.id === params.insert_after);
        if (!ref) return { content: [{ type: "text", text: `Epic '${params.insert_after}' not found.` }] };
        priority = ref.priority + 1;
        for (const e of r.epics) if (e.priority >= priority) e.priority++;
      } else if (params.priority !== undefined) {
        priority = params.priority;
      } else {
        const maxP = r.epics.reduce((m, e) => Math.max(m, e.priority), 0);
        priority = maxP + 1;
      }

      const epic: Epic = {
        id: genId(),
        title: params.title,
        description: params.description,
        body: params.body || "",
        priority,
        status: "draft",
        relevantFiles: params.relevant_files || [],
        todos: (params.todos || []).map((t) => ({ text: t, done: false })),
        successCriteria: params.success_criteria || [],
        research: [],
        createdAt: now(),
        updatedAt: now(),
      };

      r.epics.push(epic);
      save(r);
      return { content: [{ type: "text", text: `✅ Added epic **${epic.id}**: ${epic.title} (priority ${epic.priority}, 📝 draft)` }] };
    },
  });

  pi.registerTool({
    name: "epic_show",
    label: "Epic: Show",
    description: "Show full epic details. Use project_tool_docs('epic_show') for usage.",
    parameters: Type.Object({ id: Type.String({ description: "Epic ID" }) }),
    async execute(_id, params) {
      const r = load();
      const epic = r.epics.find((e) => e.id === params.id);
      if (!epic) return { content: [{ type: "text", text: `Epic '${params.id}' not found.` }] };
      return { content: [{ type: "text", text: formatEpic(epic, true, r.issues, r.assets) }] };
    },
  });

  pi.registerTool({
    name: "epic_list",
    label: "Epic: List",
    description: "List epics (excludes closed by default). Use project_tool_docs('epic_list') for usage.",
    parameters: Type.Object({
      include_closed: Type.Optional(Type.Boolean({ description: "Include closed epics", default: false })),
      include_deferred: Type.Optional(Type.Boolean({ description: "Show only deferred epics (closed with reason=deferred)", default: false })),
    }),
    async execute(_id, params) {
      const r = load();
      let epics: Epic[];
      if (params.include_deferred) {
        epics = r.epics.filter((e) => e.status === "closed" && e.closeReason === "deferred").sort((a, b) => a.priority - b.priority);
      } else {
        epics = params.include_closed ? r.epics.sort((a, b) => a.priority - b.priority) : activeEpics(r);
      }
      if (!epics.length) return { content: [{ type: "text", text: "No epics found." }] };
      const out = epics.map((e) => formatEpic(e, false, r.issues, r.assets)).join("\n\n");
      return { content: [{ type: "text", text: `# Epics (${epics.length})\n\n${out}` }] };
    },
  });

  pi.registerTool({
    name: "epic_update",
    label: "Epic: Update",
    description: "Update epic fields. Use project_tool_docs('epic_update') for usage.",
    parameters: Type.Object({
      id: Type.String({ description: "Epic ID" }),
      title: Type.Optional(Type.String()),
      description: Type.Optional(Type.String()),
      body: Type.Optional(Type.String()),
      priority: Type.Optional(Type.Number()),
      relevant_files: Type.Optional(Type.Array(Type.Object({ file: Type.String(), reason: Type.String() }))),
      todos: Type.Optional(Type.Array(Type.Object({ text: Type.String(), done: Type.Boolean() }))),
      success_criteria: Type.Optional(Type.Array(Type.String())),
    }),
    async execute(_id, params) {
      const r = load();
      const epic = r.epics.find((e) => e.id === params.id);
      if (!epic) return { content: [{ type: "text", text: `Epic '${params.id}' not found.` }] };

      if (params.title !== undefined) epic.title = params.title;
      if (params.description !== undefined) epic.description = params.description;
      if (params.body !== undefined) epic.body = params.body;
      if (params.priority !== undefined) epic.priority = params.priority - 0.5;
      if (params.relevant_files !== undefined) epic.relevantFiles = params.relevant_files;
      if (params.todos !== undefined) epic.todos = params.todos;
      if (params.success_criteria !== undefined) epic.successCriteria = params.success_criteria;
      epic.updatedAt = now();

      save(r);
      return { content: [{ type: "text", text: `✅ Updated **${epic.id}**: ${epic.title}` }] };
    },
  });

  pi.registerTool({
    name: "epic_advance",
    label: "Epic: Advance",
    description: "Advance epic to next status. Use project_tool_docs('epic_advance') for usage.",
    parameters: Type.Object({
      id: Type.String({ description: "Epic ID" }),
      close_message: Type.Optional(Type.String({ description: "Required when advancing to closed" })),
      force: Type.Optional(Type.Boolean({ description: "Force advance even if gaps exist (default: false)" })),
    }),
    async execute(_id, params) {
      const r = load();
      const epic = r.epics.find((e) => e.id === params.id);
      if (!epic) return { content: [{ type: "text", text: `Epic '${params.id}' not found.` }] };

      const next = EPIC_NEXT[epic.status];
      if (!next) return { content: [{ type: "text", text: `Epic is **${epic.status}** — cannot advance further. Use \`epic_reopen\` to reopen.` }] };

      if (next === "closed") {
        return { content: [{ type: "text", text: `Use \`epic_close\` to close epics — it requires validation evidence.` }] };
      }

      const advice = adviceFor(epic, r.issues);
      const hasGaps = advice.includes("Before advancing") || advice.includes("Before closing");

      // Block advancement if gaps exist unless forced
      if (hasGaps && !params.force) {
        return { content: [{ type: "text", text: `⚠️ Cannot advance **${epic.id}** ${epic.title}:\n\n${advice}\n\nUse \`force: true\` to advance anyway.` }] };
      }

      const oldStatus = epic.status;
      epic.status = next;
      epic.updatedAt = now();

      // Git: auto-create epic branch when going in-progress
      let gitNote = "";
      if (next === "in-progress" && getConfigValue<boolean>(r, "git.enabled") && getConfigValue<boolean>(r, "git.epics.auto_branch")) {
        if (isGitRepo()) {
          const branchName = epicBranchName(epic.id, epic.title);
          if (branchExists(branchName)) {
            gitNote = `\n\n🌿 Git branch already exists: \`${branchName}\``;
            epic.gitBranch = branchName;
          } else {
            const err = createBranch(branchName);
            if (err) {
              gitNote = `\n\n⚠️ Could not create git branch \`${branchName}\`: ${err}`;
            } else {
              gitNote = `\n\n🌿 Created and switched to git branch: \`${branchName}\``;
              epic.gitBranch = branchName;
            }
          }
        }
      }

      save(r);

      const out = `⏩ **${epic.id}** ${epic.title}: ${EPIC_STATUS_LABEL[oldStatus]} → ${EPIC_STATUS_LABEL[next]}\n\n${advice}${gitNote}`;

      return { content: [{ type: "text", text: out }] };
    },
  });

  pi.registerTool({
    name: "epic_close",
    label: "Epic: Close",
    description: "Close an epic (two-step with validation). Use project_tool_docs('epic_close') for usage.",
    parameters: Type.Object({
      id: Type.String({ description: "Epic ID" }),
      message: Type.Optional(Type.String({ description: "Closing summary (required for step 2)" })),
      validations: Type.Optional(
        Type.Array(
          Type.Object({
            evidence: Type.String({ description: "Evidence/proof that this criterion was met" }),
            met: Type.Boolean({ description: "Whether the criterion was met" }),
          }),
          { description: "One entry per success criterion, in order. Provide evidence for each." }
        )
      ),
      close_reason: Type.Optional(Type.Union([Type.Literal("done"), Type.Literal("deferred"), Type.Literal("wont-fix")], { description: "Reason for closing (default: done). 'deferred' requires explicit user approval and auto-defers all linked open issues." })),
      user_approval: Type.Optional(Type.String({ description: "Required when close_reason is 'deferred': paste the user's exact approval message." })),
    }),
    async execute(_id, params) {
      const r = load();
      const epic = r.epics.find((e) => e.id === params.id);
      if (!epic) return { content: [{ type: "text", text: `Epic '${params.id}' not found.` }] };

      const allowed = EPIC_TRANSITIONS[epic.status];
      if (!allowed.includes("closed")) {
        return { content: [{ type: "text", text: `❌ Cannot close from **${epic.status}**. Allowed: ${allowed.join(", ")}` }] };
      }

      const closeReason: CloseReason = params.close_reason || "done";

      // Deferred requires explicit user approval — block before checklist
      if (closeReason === "deferred") {
        if (!params.user_approval || params.user_approval.trim().length < 3) {
          return { content: [{ type: "text", text: `⛔ **Deferring an epic requires explicit user approval.**\n\nAsk the user: *"Should I defer epic [${epic.id}] ${epic.title}?"* and pass their exact response as \`user_approval\`.` }] };
        }
      }

      // Step 1: no validations — return checklist
      if (!params.validations) {
        const openLinked = r.issues.filter((i) => i.epicId === epic.id && i.status !== "closed");
        const unfinishedTodos = epic.todos.filter((t) => !t.done);

        let out = `# 🔍 Close Checklist for [${epic.id}] ${epic.title}\n\n`;
        if (closeReason !== "done") out += `> ⚠️ Closing with reason: **${closeReason}**\n\n`;
        out += `Review and validate each item, then call \`epic_close\` again with:\n`;
        out += `- \`validations\`: one entry per success criterion (in order), each with \`evidence\` and \`met: true/false\`\n`;
        out += `- \`message\`: closing summary\n`;
        if (closeReason !== "done") out += `- \`close_reason\`: "${closeReason}"\n`;
        if (closeReason === "deferred") out += `- \`user_approval\`: user's approval message\n`;

        if (epic.successCriteria.length) {
          out += `\n## Success Criteria (${epic.successCriteria.length} — provide evidence for each)\n`;
          for (let i = 0; i < epic.successCriteria.length; i++) {
            out += `${i + 1}. ⬜ ${epic.successCriteria[i]}\n`;
          }
        } else {
          out += `\n⚠️ No success criteria defined — add some with \`epic_update\` before closing, or close with an empty validations array.\n`;
        }

        if (unfinishedTodos.length) {
          out += `\n## ⚠️ Unfinished Todos (${unfinishedTodos.length})\n`;
          for (const t of unfinishedTodos) out += `- ⬜ ${t.text}\n`;
        }

        if (openLinked.length) {
          out += `\n## ⚠️ Open Issues (${openLinked.length})\n`;
          for (const i of openLinked) out += `- ${formatIssue(i)}\n`;
        }

        // Git: merge check
        if (getConfigValue<boolean>(r, "git.enabled") && getConfigValue<boolean>(r, "git.epics.merge_check_on_close")) {
          if (epic.gitBranch && isGitRepo()) {
            const target = defaultBranch();
            if (!isMergedInto(epic.gitBranch, target)) {
              out += `\n## ⚠️ Git Branch Not Merged\n`;
              out += `Branch \`${epic.gitBranch}\` has not been merged into \`${target}\`.\n`;
              out += `Merge or squash before closing, or proceed if this is intentional.\n`;
            } else {
              out += `\n## ✅ Git Branch Merged\n`;
              out += `Branch \`${epic.gitBranch}\` is merged into \`${target}\`.\n`;
            }
          }
        }

        return { content: [{ type: "text", text: out }] };
      }

      // Step 2: validate and close
      if (!params.message) {
        return { content: [{ type: "text", text: `Step 2 requires a \`message\` (closing summary).` }] };
      }

      // Check validations match criteria count
      if (epic.successCriteria.length && params.validations.length !== epic.successCriteria.length) {
        return {
          content: [{
            type: "text",
            text: `❌ Expected ${epic.successCriteria.length} validations (one per success criterion), got ${params.validations.length}.`,
          }],
        };
      }

      // Pair validations with criteria and check all met
      const paired = epic.successCriteria.map((c, i) => ({
        criterion: c,
        evidence: params.validations![i].evidence,
        met: params.validations![i].met,
      }));

      const unmet = paired.filter((v) => !v.met);
      if (unmet.length) {
        let out = `❌ **${unmet.length} criterion/criteria not met:**\n`;
        for (const v of unmet) out += `- ❌ **${v.criterion}**: ${v.evidence}\n`;
        out += `\nFix these issues, then try again.`;
        return { content: [{ type: "text", text: out }] };
      }

      const openLinked = r.issues.filter((i) => i.epicId === epic.id && i.status !== "closed");

      epic.status = "closed";
      epic.closeMessage = params.message;
      epic.closeReason = closeReason;
      epic.validations = paired;
      epic.closedAt = now();
      epic.updatedAt = now();
      for (const t of epic.todos) t.done = true;

      // Cascade deferred to all linked open issues
      let cascadedCount = 0;
      if (closeReason === "deferred" && openLinked.length) {
        for (const issue of openLinked) {
          issue.status = "closed";
          issue.closeReason = "deferred";
          issue.closeMessage = `Auto-deferred: parent epic [${epic.id}] ${epic.title} was deferred.`;
          issue.closedAt = now();
          issue.updatedAt = now();
          issue.closeReviewed = undefined;
        }
        cascadedCount = openLinked.length;
      }

      save(r);

      const active = activeEpics(r);
      let next = active.length
        ? `\n\n---\n**Next up:** [${active[0].id}] ${active[0].title}`
        : "\n\n🎉 No more active epics!";

      const reasonLabel = closeReason === "deferred" ? "📦 Deferred" : closeReason === "wont-fix" ? "🚫 Won't Fix" : "🏁 Closed";

      let warning = "";
      if (closeReason !== "deferred" && openLinked.length) {
        warning = `\n\n⚠️ **${openLinked.length} linked issue(s) still open** — unlink or close them.`;
      } else if (cascadedCount > 0) {
        warning = `\n\n📦 **${cascadedCount} linked issue(s) auto-deferred.**`;
      }

      let evidence = "";
      if (paired.length) {
        evidence = "\n\n**Validated:**";
        for (const v of paired) evidence += `\n- ✅ **${v.criterion}**: ${v.evidence}`;
      }

      return { content: [{ type: "text", text: `${reasonLabel} **${epic.id}**: ${epic.title}\n\n> ${params.message}${evidence}${warning}${next}` }] };
    },
  });

  pi.registerTool({
    name: "epic_reopen",
    label: "Epic: Reopen",
    description: "Reopen a closed epic. Use project_tool_docs('epic_reopen') for usage.",
    parameters: Type.Object({ id: Type.String({ description: "Epic ID" }) }),
    async execute(_id, params) {
      const r = load();
      const epic = r.epics.find((e) => e.id === params.id);
      if (!epic) return { content: [{ type: "text", text: `Epic '${params.id}' not found.` }] };

      const wasDeferred = epic.closeReason === "deferred";
      epic.status = "draft";
      epic.closedAt = undefined;
      epic.closeMessage = undefined;
      epic.closeReason = undefined;
      epic.updatedAt = now();

      // Reopen issues that were auto-deferred by this epic
      let reopenedCount = 0;
      if (wasDeferred) {
        const autoDeferredIssues = r.issues.filter(
          (i) => i.epicId === epic.id && i.status === "closed" && i.closeReason === "deferred" &&
          i.closeMessage?.startsWith(`Auto-deferred: parent epic [${epic.id}]`)
        );
        for (const issue of autoDeferredIssues) {
          issue.status = "draft";
          issue.closedAt = undefined;
          issue.closeMessage = undefined;
          issue.closeReason = undefined;
          issue.updatedAt = now();
        }
        reopenedCount = autoDeferredIssues.length;
      }

      save(r);

      const cascadeNote = reopenedCount > 0 ? `\n📦 ${reopenedCount} auto-deferred issue(s) also reopened.` : "";
      return { content: [{ type: "text", text: `🔓 Reopened **${epic.id}**: ${epic.title} (📝 draft)${cascadeNote}` }] };
    },
  });

  pi.registerTool({
    name: "epic_todo",
    label: "Epic: Todo",
    description: "Toggle or add epic todos. Use project_tool_docs('epic_todo') for usage.",
    parameters: Type.Object({
      id: Type.String({ description: "Epic ID" }),
      todo_index: Type.Optional(Type.Number({ description: "0-based index to toggle" })),
      add: Type.Optional(Type.String({ description: "Text of new todo" })),
    }),
    async execute(_id, params) {
      const r = load();
      const epic = r.epics.find((e) => e.id === params.id);
      if (!epic) return { content: [{ type: "text", text: `Epic '${params.id}' not found.` }] };

      if (params.add) {
        epic.todos.push({ text: params.add, done: false });
        epic.updatedAt = now();
        save(r);
        return { content: [{ type: "text", text: `➕ Added todo: ${params.add}` }] };
      }

      if (params.todo_index !== undefined) {
        if (params.todo_index < 0 || params.todo_index >= epic.todos.length) {
          return { content: [{ type: "text", text: `Invalid index. Epic has ${epic.todos.length} todos (0-${epic.todos.length - 1}).` }] };
        }
        const t = epic.todos[params.todo_index];
        t.done = !t.done;
        epic.updatedAt = now();
        save(r);
        return { content: [{ type: "text", text: `${t.done ? "✅" : "⬜"} ${t.text}` }] };
      }

      return { content: [{ type: "text", text: "Provide either todo_index to toggle or add to create a new todo." }] };
    },
  });

  pi.registerTool({
    name: "epic_research",
    label: "Epic: Add Research",
    description: "Add research note to an epic. Use project_tool_docs('epic_research') for usage.",
    parameters: Type.Object({
      id: Type.String({ description: "Epic ID" }),
      type: Type.Union([Type.Literal("example"), Type.Literal("reference"), Type.Literal("comment")], { description: "Note type" }),
      content: Type.String({ description: "Markdown content" }),
    }),
    async execute(_id, params) {
      const r = load();
      const epic = r.epics.find((e) => e.id === params.id);
      if (!epic) return { content: [{ type: "text", text: `Epic '${params.id}' not found.` }] };

      epic.research.push({ type: params.type, content: params.content, addedAt: now() });
      epic.updatedAt = now();
      save(r);

      const icon = params.type === "example" ? "💡" : params.type === "reference" ? "📎" : "💬";
      return { content: [{ type: "text", text: `${icon} Added ${params.type} to **${epic.id}**: ${epic.title}` }] };
    },
  });
}
