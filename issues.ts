import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { Issue } from "./types.js";
import { ISSUE_TRANSITIONS, ISSUE_NEXT, type CloseReason } from "./types.js";
import { load, save, genId, now } from "./store.js";
import { formatIssue, formatIssueVerbose } from "./format.js";
import { ISSUE_STATUS_LABEL, ISSUE_TYPE_ICON } from "./constants.js";
import { getConfigValue } from "./config.js";
import { isGitRepo, isClean, branchExists, epicBranchName, headSha, commitExists, hasCommitsSince } from "./git.js";

function adviceFor(issue: Issue): string {
  const researchCount = issue.research.length;

  switch (issue.status) {
    case "draft": {
      const gaps: string[] = [];
      if (!researchCount) gaps.push("Add **research** notes (examples, references, comments) to validate");
      if (gaps.length) return `Before advancing to **researched**:\n${gaps.map((g) => `- ${g}`).join("\n")}\n\nCurrently: ${researchCount} research notes`;
      return "✅ Has research — ready to advance to **researched**.";
    }
    case "researched": {
      const gaps: string[] = [];
      if (!issue.epicId) gaps.push("Consider linking to an **epic** for planning");
      if (gaps.length) return `Before advancing to **ready**:\n${gaps.map((g) => `- ${g}`).join("\n")}`;
      return "✅ Researched and linked — ready to advance.";
    }
    case "ready":
      return "This issue is **ready** — advance to **in-progress** to start working on it.";
    case "in-progress":
      return "This issue is **in-progress**. Close with a summary when done.";
    default:
      return "";
  }
}

export function registerIssueTools(pi: ExtensionAPI) {
  const IssueTypeSchema = Type.Union([
    Type.Literal("bug"),
    Type.Literal("feature"),
    Type.Literal("chore"),
    Type.Literal("spike"),
    Type.Literal("idea"),
  ]);

  pi.registerTool({
    name: "issue_add",
    label: "Issue: Add",
    description: "Add an issue (bug/feature/chore/spike/idea). Use project_tool_docs('issue_add') for full usage.",
    parameters: Type.Object({
      type: IssueTypeSchema,
      title: Type.String({ description: "Short title" }),
      description: Type.String({ description: "Markdown description" }),
      epic_id: Type.Optional(Type.String({ description: "Epic ID to link to" })),
      auto_validation_possible: Type.Optional(Type.Boolean({ description: "Can the agent self-verify? (legacy, prefer auto_validation_type)" })),
      auto_validation_strategy: Type.Optional(Type.String({ description: "How to verify (e.g. 'run the test suite', 'requires user confirmation')" })),
      auto_validation_type: Type.Optional(Type.Union([
        Type.Literal("agent"),
        Type.Literal("human"),
        Type.Literal("other"),
      ], { description: "Validation type: 'agent' (AI verifies), 'human' (user must confirm), 'other' (AI discretion)" })),
    }),
    async execute(_id, params) {
      const r = load();

      if (params.epic_id) {
        const epic = r.epics.find((e) => e.id === params.epic_id);
        if (!epic) return { content: [{ type: "text", text: `Epic '${params.epic_id}' not found.` }] };
      }

      const issue: Issue = {
        id: genId(),
        type: params.type,
        title: params.title,
        description: params.description,
        status: "draft",
        epicId: params.epic_id,
        linkedIssueIds: [],
        questions: [],
        research: [],
        createdAt: now(),
        updatedAt: now(),
      };

      if (params.auto_validation_type) {
        issue.autoValidation = {
          type: params.auto_validation_type,
          strategy: params.auto_validation_strategy || (params.auto_validation_type === "agent" ? "Not specified" : params.auto_validation_type === "human" ? "Requires user validation" : "AI discretion"),
        };
      } else if (params.auto_validation_possible !== undefined) {
        // Legacy compat
        issue.autoValidation = {
          type: params.auto_validation_possible ? "agent" : "human",
          strategy: params.auto_validation_strategy || (params.auto_validation_possible ? "Not specified" : "Requires user validation"),
        };
      }

      r.issues.push(issue);
      save(r);

      const icon = ISSUE_TYPE_ICON[params.type];
      const link = params.epic_id ? ` → epic:${params.epic_id}` : "";
      const valLabels: Record<string, string> = { agent: "🤖 agent-validate", human: "👤 user-validate", other: "📋 other" };
      const validation = issue.autoValidation
        ? ` ${valLabels[issue.autoValidation.type] || "📋"}: ${issue.autoValidation.strategy}`
        : "";
      return { content: [{ type: "text", text: `${icon} Added ${params.type} **${issue.id}**: ${issue.title} (📝 draft)${link}${validation}` }] };
    },
  });

  pi.registerTool({
    name: "issue_show",
    label: "Issue: Show",
    description: "Show full issue details. Use project_tool_docs('issue_show') for usage.",
    parameters: Type.Object({ id: Type.String({ description: "Issue ID" }) }),
    async execute(_id, params) {
      const r = load();
      const issue = r.issues.find((i) => i.id === params.id);
      if (!issue) return { content: [{ type: "text", text: `Issue '${params.id}' not found.` }] };
      return { content: [{ type: "text", text: formatIssueVerbose(issue, r.epics, r.assets, r.issues) }] };
    },
  });

  pi.registerTool({
    name: "issue_list",
    label: "Issue: List",
    description: "List issues (excludes closed by default). Use project_tool_docs('issue_list') for usage.",
    parameters: Type.Object({
      include_closed: Type.Optional(Type.Boolean({ description: "Include closed issues", default: false })),
      include_deferred: Type.Optional(Type.Boolean({ description: "Show only deferred issues (closed with reason=deferred)", default: false })),
      epic_id: Type.Optional(Type.String({ description: "Filter by linked epic ID" })),
      type: Type.Optional(IssueTypeSchema),
      status: Type.Optional(Type.Union([Type.Literal("draft"), Type.Literal("researched"), Type.Literal("ready"), Type.Literal("in-progress"), Type.Literal("closed")], { description: "Filter by status" })),
      unassigned: Type.Optional(Type.Boolean({ description: "If true, show only issues NOT linked to any epic (the unassigned/parking-lot bucket)", default: false })),
    }),
    async execute(_id, params) {
      const r = load();
      let issues: Issue[];
      if (params.include_deferred) {
        // Show only deferred items
        issues = r.issues.filter((i) => i.status === "closed" && i.closeReason === "deferred");
      } else {
        issues = params.include_closed ? r.issues : r.issues.filter((i) => i.status !== "closed");
      }
      if (params.unassigned) issues = issues.filter((i) => !i.epicId);
      if (params.epic_id) issues = issues.filter((i) => i.epicId === params.epic_id);
      if (params.type) issues = issues.filter((i) => i.type === params.type);
      if (params.status && !params.include_deferred) issues = issues.filter((i) => i.status === params.status);

      if (!issues.length) return { content: [{ type: "text", text: "No issues found." }] };

      const out = issues.map((i) => formatIssue(i)).join("\n");
      return { content: [{ type: "text", text: `# Issues (${issues.length})\n\n${out}` }] };
    },
  });

  pi.registerTool({
    name: "issue_update",
    label: "Issue: Update",
    description: "Update issue fields. Use project_tool_docs('issue_update') for usage.",
    parameters: Type.Object({
      id: Type.String({ description: "Issue ID" }),
      title: Type.Optional(Type.String()),
      description: Type.Optional(Type.String()),
      type: Type.Optional(IssueTypeSchema),
      epic_id: Type.Optional(Type.String({ description: "Epic ID to link to (empty string to unlink)" })),
    }),
    async execute(_id, params) {
      const r = load();
      const issue = r.issues.find((i) => i.id === params.id);
      if (!issue) return { content: [{ type: "text", text: `Issue '${params.id}' not found.` }] };

      if (params.title !== undefined) issue.title = params.title;
      if (params.description !== undefined) issue.description = params.description;
      if (params.type !== undefined) issue.type = params.type;
      if (params.epic_id !== undefined) {
        if (params.epic_id === "") {
          issue.epicId = undefined;
        } else {
          const epic = r.epics.find((e) => e.id === params.epic_id);
          if (!epic) return { content: [{ type: "text", text: `Epic '${params.epic_id}' not found.` }] };
          issue.epicId = params.epic_id;
        }
      }
      issue.updatedAt = now();

      save(r);
      return { content: [{ type: "text", text: `✅ Updated issue **${issue.id}**: ${issue.title}` }] };
    },
  });

  pi.registerTool({
    name: "issue_advance",
    label: "Issue: Advance",
    description: "Advance issue to next status. Use project_tool_docs('issue_advance') for usage.",
    parameters: Type.Object({
      id: Type.String({ description: "Issue ID" }),
      close_message: Type.Optional(Type.String({ description: "Required when advancing to closed" })),
    }),
    async execute(_id, params) {
      const r = load();
      const issue = r.issues.find((i) => i.id === params.id);
      if (!issue) return { content: [{ type: "text", text: `Issue '${params.id}' not found.` }] };

      const next = ISSUE_NEXT[issue.status];
      if (!next) return { content: [{ type: "text", text: `Issue is **${issue.status}** — cannot advance. Use \`issue_reopen\` to reopen.` }] };

      if (next === "closed") {
        return { content: [{ type: "text", text: `Use \`issue_close\` to close issues — it requires validation evidence.` }] };
      }

      // Gate: unanswered required questions block advancement to in-progress
      if (next === "in-progress" && issue.questions.length > 0) {
        const unansweredRequired = issue.questions.filter(q => !q.answer && q.required !== false);
        if (unansweredRequired.length > 0) {
          const list = unansweredRequired.map((q) => {
            const idx = issue.questions.indexOf(q);
            return `  ${idx}. ❓ ${q.text}`;
          }).join("\n");
          return { content: [{ type: "text", text: `⚠️ Cannot start — ${unansweredRequired.length} unanswered required question(s):\n\n${list}\n\nUse \`issue_question\` to answer them first.` }] };
        }
      }

      // Gate: only one issue can be in-progress at a time
      if (next === "in-progress") {
        const existing = r.issues.find(i => i.status === "in-progress" && i.id !== issue.id);
        if (existing) {
          const icon = ISSUE_TYPE_ICON[existing.type];
          return { content: [{ type: "text", text: `⚠️ Cannot start — ${icon} [${existing.id}] ${existing.title} is already in-progress. Close or pause it first.` }] };
        }
      }

      // Git guards for starting an issue
      if (next === "in-progress" && getConfigValue<boolean>(r, "git.enabled") && isGitRepo()) {
        // Require clean worktree
        if (getConfigValue<boolean>(r, "git.require_clean_worktree") && !isClean()) {
          return { content: [{ type: "text", text: `⛔ Git: Working tree is dirty. Commit or stash your changes before starting an issue.` }] };
        }
        // Require epic branch to exist
        if (getConfigValue<boolean>(r, "git.require_epic_branch") && issue.epicId) {
          const epic = r.epics.find(e => e.id === issue.epicId);
          if (epic) {
            const expectedBranch = epicBranchName(epic.id, epic.title);
            if (!branchExists(expectedBranch)) {
              return { content: [{ type: "text", text: `⛔ Git: Epic branch \`${expectedBranch}\` does not exist. Advance the epic to in-progress first to create it.` }] };
            }
          }
        }
      }

      const advice = adviceFor(issue);
      const oldStatus = issue.status;
      issue.status = next;

      // Record HEAD SHA when starting work
      if (next === "in-progress" && getConfigValue<boolean>(r, "git.enabled") && isGitRepo()) {
        const sha = headSha();
        if (sha) issue.startCommit = sha;
      }

      issue.updatedAt = now();

      save(r);

      const icon = ISSUE_TYPE_ICON[issue.type];
      return {
        content: [
          {
            type: "text",
            text: `${icon} ⏩ **${issue.id}** ${issue.title}: ${ISSUE_STATUS_LABEL[oldStatus]} → ${ISSUE_STATUS_LABEL[next]}\n\n${advice}`,
          },
        ],
      };
    },
  });

  pi.registerTool({
    name: "issue_close",
    label: "Issue: Close",
    description: "Close an issue (two-step with validation). Use project_tool_docs('issue_close') for usage.",
    parameters: Type.Object({
      id: Type.String({ description: "Issue ID" }),
      message: Type.Optional(Type.String({ description: "Closing summary (required for step 2)" })),
      evidence: Type.Optional(Type.String({ description: "Evidence/proof that the issue requirement was fulfilled" })),
      met: Type.Optional(Type.Boolean({ description: "Whether the requirement was met (required for step 2)" })),
      close_reason: Type.Optional(Type.Union([Type.Literal("done"), Type.Literal("deferred"), Type.Literal("wont-fix")], { description: "Reason for closing (default: done). 'deferred' requires explicit user approval." })),
      commit_id: Type.Optional(Type.String({ description: "Git commit SHA to attach to this close (required when git.require_commit_id_on_close is enabled)" })),
    }),
    async execute(_id, params) {
      const r = load();
      const issue = r.issues.find((i) => i.id === params.id);
      if (!issue) return { content: [{ type: "text", text: `Issue '${params.id}' not found.` }] };

      const allowed = ISSUE_TRANSITIONS[issue.status];
      if (!allowed.includes("closed")) {
        return { content: [{ type: "text", text: `❌ Cannot close from **${issue.status}**. Allowed: ${allowed.join(", ")}` }] };
      }

      const icon = ISSUE_TYPE_ICON[issue.type];

      const closeReason: CloseReason = params.close_reason || "done";

      // Deferred requires human approval — enforce before even showing checklist
      if (closeReason === "deferred") {
        const hasUserApproval = /user\s*(approved|confirmed|said|ok|okay|lgtm|authorized|deferred|defer|:\s*(yes|ok|okay|lgtm|approved|defer))/i.test(params.evidence || "");
        if (!hasUserApproval) {
          return { content: [{ type: "text", text: `⛔ **Deferring requires explicit user approval.**\n\nAsk the user: *"Should I defer [${issue.id}] ${issue.title}?"* and include their confirmation in the \`evidence\` field.` }] };
        }
      }

      // Step 1: show checklist (persisted on issue, survives /reload)
      if (!issue.closeReviewed) {
        issue.closeReviewed = true;
        issue.updatedAt = now();
        save(r);

        let out = `# 🔍 Close Checklist for ${icon} [${issue.id}] ${issue.title}\n\n`;
        if (closeReason !== "done") out += `> ⚠️ Closing with reason: **${closeReason}**\n\n`;
        out += `## Requirement\n${issue.description}\n\n`;
        if (issue.research.length) {
          out += `## Research\n`;
          for (const n of issue.research) {
            const ri = n.type === "example" ? "💡" : n.type === "reference" ? "📎" : "💬";
            out += `- ${ri} **${n.type}:** ${n.content}\n`;
          }
          out += `\n`;
        }
        if (issue.autoValidation) {
          const vtype = issue.autoValidation.type || (issue.autoValidation.possible ? "agent" : "human");
          if (vtype === "agent") {
            out += `## 🤖 Agent Validation Required (HARD BLOCKER)\n`;
            out += `**Strategy:** ${issue.autoValidation.strategy}\n\n`;
            out += `⚠️ You MUST run the validation, capture output, and paste it as evidence. If you cannot, ask the user to override.\n\n`;
          } else if (vtype === "human") {
            out += `## 👤 Human Validation Required (HARD BLOCKER)\n`;
            out += `**What to validate:** ${issue.autoValidation.strategy}\n\n`;
            out += `⛔ Ask the user to validate. Only close after they explicitly confirm.\n\n`;
          } else {
            out += `## 📋 Validation (AI discretion)\n`;
            out += `**Notes:** ${issue.autoValidation.strategy}\n\n`;
          }
        }
        out += `---\nValidate the requirement, then call \`issue_close\` again with \`evidence\`, \`met\`, and \`message\`.`;
        return { content: [{ type: "text", text: out }] };
      }

      // Step 2: git guards before closing
      if (issue.closeReviewed && getConfigValue<boolean>(r, "git.enabled") && isGitRepo() && params.close_reason !== "deferred" && params.close_reason !== "wont-fix") {
        // Require commits since issue started
        if (getConfigValue<boolean>(r, "git.require_commit_on_close") && issue.startCommit) {
          if (!hasCommitsSince(issue.startCommit)) {
            return { content: [{ type: "text", text: `⛔ Git: No commits found since this issue was started. Commit your work before closing.` }] };
          }
        }
        // Require commit_id param
        if (getConfigValue<boolean>(r, "git.require_commit_id_on_close")) {
          if (!params.commit_id) {
            return { content: [{ type: "text", text: `⛔ Git: A commit SHA is required to close this issue (\`commit_id\` param). Provide the commit that implements this work.` }] };
          }
          if (!commitExists(params.commit_id)) {
            return { content: [{ type: "text", text: `⛔ Git: Commit \`${params.commit_id}\` not found in this repository. Double-check the SHA.` }] };
          }
        }
      }

      // Step 2: validate and close
      if (params.evidence === undefined || !params.message || params.met === undefined) {
        const missing = [
          params.evidence === undefined ? "evidence" : null,
          !params.message ? "message" : null,
          params.met === undefined ? "met" : null,
        ].filter(Boolean);
        return { content: [{ type: "text", text: `Step 2 requires: ${missing.join(", ")}.` }] };
      }
      if (!params.met && closeReason === "done") {
        // Still close the issue — met: false is a legitimate action (abandoned/skipped/out-of-scope)
        // but record it as unmet so it's visible in history
        issue.status = "closed";
        issue.closeMessage = params.message;
        issue.closeReason = "done";
        issue.closeReviewed = undefined;
        issue.validations = [{ criterion: issue.description, evidence: params.evidence || "", met: false }];
        issue.closedAt = now();
        issue.updatedAt = now();
        save(r);
        return { content: [{ type: "text", text: `${icon} ❌ Closed (unmet) **${issue.id}**: ${issue.title}\n\n> ${params.message}\n\n**Not met:** ${params.evidence}` }] };
      }

      // Validation type enforcement (only for "done" — deferred/wont-fix skip functional validation)
      if (closeReason === "done") {
        const vtype = issue.autoValidation?.type || (issue.autoValidation?.possible === false ? "human" : undefined);
        const hasUserConfirmation = /user\s*(confirmed|validated|approved|override|verified|:\s*(confirmed|lgtm|works|yes|looks good))/i.test(params.evidence || "");
        if (vtype === "human" && !hasUserConfirmation) {
          return { content: [{ type: "text", text: `⛔ **Human validation required.** Ask the user to validate, then include their confirmation in the evidence.` }] };
        }
      }

      issue.status = "closed";
      issue.closeMessage = params.message;
      issue.closeReason = closeReason;
      issue.closeReviewed = undefined; // clean up
      issue.validations = [{ criterion: issue.description, evidence: params.evidence || "", met: params.met ?? true }];
      if (params.commit_id) issue.closeCommit = params.commit_id;
      issue.closedAt = now();
      issue.updatedAt = now();

      save(r);

      const reasonLabel = closeReason === "deferred" ? "📦 Deferred" : closeReason === "wont-fix" ? "🚫 Won't Fix" : "🏁 Closed";
      const commitLine = params.commit_id ? `\n\n🔗 Commit: \`${params.commit_id}\`` : "";
      const validationLine = closeReason === "done"
        ? `\n\n**Validated:** ✅ ${params.evidence}${commitLine}`
        : `\n\n**Reason:** ${params.evidence || closeReason}${commitLine}`;
      return {
        content: [{
          type: "text",
          text: `${icon} ${reasonLabel} **${issue.id}**: ${issue.title}\n\n> ${params.message}${validationLine}`,
        }],
      };
    },
  });

  pi.registerTool({
    name: "issue_reopen",
    label: "Issue: Reopen",
    description: "Reopen a closed issue. Use project_tool_docs('issue_reopen') for usage.",
    parameters: Type.Object({ id: Type.String({ description: "Issue ID" }) }),
    async execute(_id, params) {
      const r = load();
      const issue = r.issues.find((i) => i.id === params.id);
      if (!issue) return { content: [{ type: "text", text: `Issue '${params.id}' not found.` }] };

      issue.status = "draft";
      issue.closedAt = undefined;
      issue.closeMessage = undefined;
      issue.closeReason = undefined;
      issue.closeReviewed = undefined;
      issue.updatedAt = now();

      save(r);

      const icon = ISSUE_TYPE_ICON[issue.type];
      return { content: [{ type: "text", text: `${icon} Reopened **${issue.id}**: ${issue.title} (📝 draft)` }] };
    },
  });

  pi.registerTool({
    name: "issue_research",
    label: "Issue: Add Research",
    description: "Add research note to an issue. Use project_tool_docs('issue_research') for usage.",
    parameters: Type.Object({
      id: Type.String({ description: "Issue ID" }),
      type: Type.Union([Type.Literal("example"), Type.Literal("reference"), Type.Literal("comment")], { description: "Note type" }),
      content: Type.String({ description: "Markdown content" }),
    }),
    async execute(_id, params) {
      const r = load();
      const issue = r.issues.find((i) => i.id === params.id);
      if (!issue) return { content: [{ type: "text", text: `Issue '${params.id}' not found.` }] };

      issue.research.push({ type: params.type, content: params.content, addedAt: now() });
      issue.updatedAt = now();
      save(r);

      const icon = params.type === "example" ? "💡" : params.type === "reference" ? "📎" : "💬";
      return { content: [{ type: "text", text: `${icon} Added ${params.type} to issue **${issue.id}**: ${issue.title}` }] };
    },
  });

  pi.registerTool({
    name: "issue_link",
    label: "Issue: Link Issues",
    description: "Link two issues (bidirectional). Use project_tool_docs('issue_link') for usage.",
    parameters: Type.Object({
      id: Type.String({ description: "Issue ID" }),
      target_id: Type.String({ description: "Target issue ID to link to" }),
    }),
    async execute(_id, params) {
      const r = load();
      const issue = r.issues.find((i) => i.id === params.id);
      if (!issue) return { content: [{ type: "text", text: `Issue '${params.id}' not found.` }] };
      const target = r.issues.find((i) => i.id === params.target_id);
      if (!target) return { content: [{ type: "text", text: `Issue '${params.target_id}' not found.` }] };
      if (params.id === params.target_id) return { content: [{ type: "text", text: `Cannot link an issue to itself.` }] };

      if (!issue.linkedIssueIds) issue.linkedIssueIds = [];
      if (!target.linkedIssueIds) target.linkedIssueIds = [];

      if (issue.linkedIssueIds.includes(params.target_id)) {
        return { content: [{ type: "text", text: `Issues are already linked.` }] };
      }

      issue.linkedIssueIds.push(params.target_id);
      target.linkedIssueIds.push(params.id);
      issue.updatedAt = now();
      target.updatedAt = now();

      save(r);

      const iIcon = ISSUE_TYPE_ICON[issue.type];
      const tIcon = ISSUE_TYPE_ICON[target.type];
      return { content: [{ type: "text", text: `🔗 Linked ${iIcon} [${issue.id}] ${issue.title} ↔ ${tIcon} [${target.id}] ${target.title}` }] };
    },
  });

  pi.registerTool({
    name: "issue_unlink",
    label: "Issue: Unlink Issues",
    description: "Unlink two issues. Use project_tool_docs('issue_unlink') for usage.",
    parameters: Type.Object({
      id: Type.String({ description: "Issue ID" }),
      target_id: Type.String({ description: "Target issue ID to unlink from" }),
    }),
    async execute(_id, params) {
      const r = load();
      const issue = r.issues.find((i) => i.id === params.id);
      if (!issue) return { content: [{ type: "text", text: `Issue '${params.id}' not found.` }] };
      const target = r.issues.find((i) => i.id === params.target_id);
      if (!target) return { content: [{ type: "text", text: `Issue '${params.target_id}' not found.` }] };

      if (!issue.linkedIssueIds) issue.linkedIssueIds = [];
      if (!target.linkedIssueIds) target.linkedIssueIds = [];

      if (!issue.linkedIssueIds.includes(params.target_id)) {
        return { content: [{ type: "text", text: `Issues are not linked.` }] };
      }

      issue.linkedIssueIds = issue.linkedIssueIds.filter(id => id !== params.target_id);
      target.linkedIssueIds = target.linkedIssueIds.filter(id => id !== params.id);
      issue.updatedAt = now();
      target.updatedAt = now();

      save(r);

      return { content: [{ type: "text", text: `🔗 Unlinked [${issue.id}] ↔ [${target.id}]` }] };
    },
  });

  pi.registerTool({
    name: "issue_question",
    label: "Issue: Question",
    description: "Add a question to an issue, or answer an existing question by index. Unanswered questions block advancement to in-progress.",
    parameters: Type.Object({
      id: Type.String({ description: "Issue ID" }),
      add: Type.Optional(Type.String({ description: "Text of new question to add" })),
      required: Type.Optional(Type.Boolean({ description: "Whether the question must be answered before advancing to in-progress (default: true)" })),
      answer_index: Type.Optional(Type.Number({ description: "0-based index of question to answer" })),
      answer: Type.Optional(Type.String({ description: "Answer text (required with answer_index)" })),
    }),
    async execute(_id, params) {
      const r = load();
      const issue = r.issues.find((i) => i.id === params.id);
      if (!issue) return { content: [{ type: "text", text: `Issue '${params.id}' not found.` }] };
      if (!issue.questions) issue.questions = [];

      const icon = ISSUE_TYPE_ICON[issue.type];

      // Add a new question
      if (params.add) {
        const isRequired = params.required !== false;
        issue.questions.push({ text: params.add, required: isRequired ? undefined : false });
        issue.updatedAt = now();
        save(r);
        const reqLabel = isRequired ? "" : " (optional)";
        return { content: [{ type: "text", text: `❓ Added question #${issue.questions.length - 1}${reqLabel} to ${icon} [${issue.id}]: ${params.add}` }] };
      }

      // Answer an existing question
      if (params.answer_index !== undefined) {
        if (params.answer_index < 0 || params.answer_index >= issue.questions.length) {
          return { content: [{ type: "text", text: `Invalid index ${params.answer_index}. Issue has ${issue.questions.length} question(s) (0-${issue.questions.length - 1}).` }] };
        }
        if (!params.answer) {
          return { content: [{ type: "text", text: `Provide \`answer\` text when answering a question.` }] };
        }
        issue.questions[params.answer_index].answer = params.answer;
        issue.updatedAt = now();
        save(r);

        const q = issue.questions[params.answer_index];
        const unanswered = issue.questions.filter(q => !q.answer).length;
        const status = unanswered > 0 ? `${unanswered} question(s) remaining` : "✅ All questions answered";
        return { content: [{ type: "text", text: `✅ Answered question #${params.answer_index} on ${icon} [${issue.id}]\n\n**Q:** ${q.text}\n**A:** ${params.answer}\n\n${status}` }] };
      }

      // No action — list questions
      if (issue.questions.length === 0) {
        return { content: [{ type: "text", text: `No questions on ${icon} [${issue.id}]. Use \`add\` to add one.` }] };
      }

      const list = issue.questions.map((q, i) => {
        const qi = q.answer ? "✅" : "❓";
        const opt = q.required === false ? " *(optional)*" : "";
        let line = `${i}. ${qi} ${q.text}${opt}`;
        if (q.answer) line += `\n   **A:** ${q.answer}`;
        return line;
      }).join("\n");

      const unansweredRequired = issue.questions.filter(q => !q.answer && q.required !== false).length;
      const unansweredOptional = issue.questions.filter(q => !q.answer && q.required === false).length;
      let status = "✅ All required questions answered";
      if (unansweredRequired > 0) status = `⚠️ ${unansweredRequired} unanswered required — blocks advancement to in-progress`;
      if (unansweredOptional > 0) status += `${unansweredRequired > 0 ? "\n" : "\n"}ℹ️ ${unansweredOptional} optional unanswered`;
      return { content: [{ type: "text", text: `## Questions on ${icon} [${issue.id}] ${issue.title}\n\n${list}\n\n${status}` }] };
    },
  });
}
