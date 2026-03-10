import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

const TOOL_DOCS: Record<string, string> = {
  epic_add: `## epic_add — Add a new epic
Creates an epic in 'draft' status.

**Parameters:**
- \`title\` (required): Short title
- \`description\` (required): Markdown summary (1-3 sentences)
- \`body\`: Detailed markdown body
- \`priority\`: Explicit priority number
- \`insert_before\`: Epic ID to insert before (adjusts priorities)
- \`insert_after\`: Epic ID to insert after (adjusts priorities)
- \`relevant_files\`: Array of {file, reason}
- \`todos\`: Array of todo strings
- \`success_criteria\`: Array of criteria strings

**Workflow:** draft → planned → in-progress → closed`,

  epic_show: `## epic_show — Show epic details
Returns full epic details: description, body, todos, success criteria, research notes, linked issues, and assets.

**Parameters:**
- \`id\` (required): Epic ID`,

  epic_list: `## epic_list — List epics
Lists all non-closed epics sorted by priority. Shows brief format with status, issue counts, and todo progress.

**Parameters:**
- \`include_closed\`: Include closed epics (default: false)
- \`include_deferred\`: Show only deferred epics — closed with reason=deferred (default: false)`,

  epic_update: `## epic_update — Update epic fields
Only provided fields are changed. Omitted fields are untouched.

**Parameters:**
- \`id\` (required): Epic ID
- \`title\`, \`description\`, \`body\`: Text fields
- \`priority\`: Number (inserts at position)
- \`relevant_files\`: Array of {file, reason} — replaces existing
- \`todos\`: Array of {text, done} — replaces existing
- \`success_criteria\`: Array of strings — replaces existing`,

  epic_advance: `## epic_advance — Advance epic status
Moves epic to next status: draft→planned→in-progress. Shows guidance on gaps (missing body, criteria, research, linked issues). Use \`force: true\` to skip gap checks. For closing, use \`epic_close\` instead.

**Parameters:**
- \`id\` (required): Epic ID
- \`close_message\`: Required when advancing to closed
- \`force\`: Force advance even if gaps exist (default: false)`,

  epic_close: `## epic_close — Close an epic (two-step)
**Step 1:** Call with just \`id\` (and optionally \`close_reason\`) — returns checklist with success criteria, unfinished todos, open issues.
**Step 2:** Call with \`id\`, \`validations\` (one per criterion with evidence + met), and \`message\`.

All criteria must be met. Validations array must match success_criteria count and order.

**close_reason values:**
- \`done\` (default): normal completion
- \`deferred\`: park the epic for later — requires \`user_approval\` (user must explicitly approve, agent cannot defer autonomously). Auto-defers all linked open issues.
- \`wont-fix\`: intentional decision not to do this work

⚠️ **Deferred requires user approval** — always ask the user first, then pass their response as \`user_approval\`.

**Parameters:**
- \`id\` (required): Epic ID
- \`message\`: Closing summary (step 2)
- \`validations\`: Array of {evidence: string, met: boolean} — one per success criterion, in order
- \`close_reason\`: "done" | "deferred" | "wont-fix" (default: done)
- \`user_approval\`: Required when close_reason is "deferred" — paste the user's exact approval`,

  epic_reopen: `## epic_reopen — Reopen a closed epic
Returns the epic to 'draft' status. Clears close message and close date. If the epic was deferred, any issues that were auto-deferred by this epic are also reopened to 'draft'.

**Parameters:**
- \`id\` (required): Epic ID`,

  epic_todo: `## epic_todo — Manage epic todos
Toggle a todo's done state or add a new todo.

**Parameters:**
- \`id\` (required): Epic ID
- \`todo_index\`: 0-based index to toggle done/undone
- \`add\`: Text of new todo to add

Provide either \`todo_index\` OR \`add\`, not both.`,

  epic_research: `## epic_research — Add research note to epic
Adds an example, reference, or comment to the epic's research notes.

**Parameters:**
- \`id\` (required): Epic ID
- \`type\` (required): "example" | "reference" | "comment"
- \`content\` (required): Markdown content`,

  issue_add: `## issue_add — Add a new issue
Creates an issue in 'draft' status. Types: bug, feature, chore, spike, idea.

**Parameters:**
- \`type\` (required): bug | feature | chore | spike | idea
- \`title\` (required): Short title
- \`description\` (required): Markdown description
- \`epic_id\`: Link to an epic
- \`auto_validation_type\`: "agent" (AI verifies) | "human" (user must confirm) | "other"
- \`auto_validation_strategy\`: How to verify (e.g. "run the test suite")
- \`auto_validation_possible\`: Legacy, prefer auto_validation_type

**Workflow:** draft → researched → ready → in-progress → closed`,

  issue_show: `## issue_show — Show issue details
Returns full issue details: description, status, research, validation config, linked issues, epic, and assets.

**Parameters:**
- \`id\` (required): Issue ID`,

  issue_list: `## issue_list — List issues
Lists issues with optional filters. Excludes closed by default.

**Parameters:**
- \`include_closed\`: Include closed issues (default: false)
- \`include_deferred\`: Show only deferred issues — closed with reason=deferred (default: false)
- \`epic_id\`: Filter by linked epic
- \`type\`: Filter by type (bug/feature/chore/spike/idea)
- \`status\`: Filter by status (draft/researched/ready/in-progress/closed)`,

  issue_update: `## issue_update — Update issue fields
Only provided fields are changed.

**Parameters:**
- \`id\` (required): Issue ID
- \`title\`, \`description\`: Text fields
- \`type\`: Change issue type
- \`epic_id\`: Link to epic (empty string to unlink)`,

  issue_advance: `## issue_advance — Advance issue status
Moves issue to next status: draft→researched→ready→in-progress. Only one issue can be in-progress at a time. For closing, use \`issue_close\`.

**Gates:**
- **ready → in-progress**: Blocked if any required questions are unanswered. Use \`issue_question\` to resolve them first.
- **in-progress**: Only one issue can be in-progress at a time.

**Parameters:**
- \`id\` (required): Issue ID
- \`close_message\`: Required when closing`,

  issue_question: `## issue_question — Manage questions on an issue
Add questions, answer them by index, or list all questions. Unanswered **required** questions block advancement to in-progress.

**Actions (mutually exclusive):**
- **Add:** provide \`add\` (question text) and optionally \`required\` (default: true)
- **Answer:** provide \`answer_index\` (0-based) and \`answer\` (text)
- **List:** call with just \`id\` to see all questions and their status

**Parameters:**
- \`id\` (required): Issue ID
- \`add\`: Text of new question
- \`required\`: Whether the question gates advancement (default: true). Set false for informational/optional questions.
- \`answer_index\`: 0-based index of question to answer
- \`answer\`: Answer text (required with answer_index)

**Icons:** ❓ = unanswered, ✅ = answered, *(optional)* = non-blocking`,

  issue_close: `## issue_close — Close an issue (two-step)
**Step 1:** Call with just \`id\` (and optionally \`close_reason\`) — returns checklist with requirement, research, and validation instructions.
**Step 2:** Call with \`id\`, \`evidence\`, \`met: true\`, and \`message\`.

For agent-validated issues: run validation, capture output as evidence.
For human-validated issues: evidence must contain user confirmation (e.g. "user confirmed: works").

**close_reason values:**
- \`done\` (default): normal completion — requires evidence + met: true
- \`deferred\`: park for later — evidence must contain user approval (e.g. "user approved: defer this"). Agent cannot defer without user consent.
- \`wont-fix\`: intentional decision not to fix — evidence explains why

⚠️ **Deferred requires user approval** — always ask the user first and include their response in evidence.

**Parameters:**
- \`id\` (required): Issue ID
- \`message\`: Closing summary (step 2)
- \`evidence\`: Proof / reason (step 2)
- \`met\`: Whether the requirement was met (step 2, required for done)
- \`close_reason\`: "done" | "deferred" | "wont-fix" (default: done)`,

  issue_reopen: `## issue_reopen — Reopen a closed issue
Returns the issue to 'draft' status. Clears close message, close date, and close reason.

**Parameters:**
- \`id\` (required): Issue ID`,

  issue_research: `## issue_research — Add research note to issue
Adds an example, reference, or comment.

**Parameters:**
- \`id\` (required): Issue ID
- \`type\` (required): "example" | "reference" | "comment"
- \`content\` (required): Markdown content`,

  issue_link: `## issue_link — Link two issues
Creates a bidirectional link between two issues.

**Parameters:**
- \`id\` (required): Issue ID
- \`target_id\` (required): Target issue ID`,

  issue_unlink: `## issue_unlink — Unlink two issues
Removes a bidirectional link.

**Parameters:**
- \`id\` (required): Issue ID
- \`target_id\` (required): Target issue ID`,

  asset_add: `## asset_add — Add a reusable asset
Assets are policies, tech stack docs, vision statements, rules, or snippets. Grouped by category (auto-created).

**Parameters:**
- \`category_slug\` (required): e.g. "tech-stack", "policies", "vision"
- \`category_description\`: Only needed for new categories
- \`title\` (required): Short title
- \`context\` (required): AI-optimized description of WHEN to apply this asset
- \`body\` (required): Full content — the actual policy/rule/spec/snippet
- \`project\`: If true, injected at session start as required context (default: false)`,

  asset_show: `## asset_show — Show asset details
Returns full asset body, sources, and linked epics/issues.

**Parameters:**
- \`id\` (required): Asset ID`,

  asset_list: `## asset_list — List assets
Lists all assets grouped by category.

**Parameters:**
- \`category\`: Filter by category slug`,

  asset_update: `## asset_update — Update asset fields
Only provided fields are changed.

**Parameters:**
- \`id\` (required): Asset ID
- \`title\`, \`context\`, \`body\`: Text fields
- \`project\`: Toggle session-start injection
- \`category_slug\`: Move to different category (auto-creates if new)`,

  asset_link: `## asset_link — Link asset to epic or issue
**Parameters:**
- \`id\` (required): Asset ID
- \`epic_id\`: Epic to link to
- \`issue_id\`: Issue to link to`,

  asset_unlink: `## asset_unlink — Unlink asset from epic or issue
**Parameters:**
- \`id\` (required): Asset ID
- \`epic_id\`: Epic to unlink
- \`issue_id\`: Issue to unlink`,

  asset_categories: `## asset_categories — List asset categories
Returns all categories with asset counts. No parameters.`,

  asset_source: `## asset_source — Add a source to an asset
Attach a file or URL reference to an asset.

**Parameters:**
- \`id\` (required): Asset ID
- \`type\` (required): "file" | "url"
- \`path\` (required): File path or URL
- \`description\` (required): What this source provides`,

  next_work: `## next_work — Find next work item
Returns the highest-priority work item based on:
1. In-progress epic → in-progress issue → ready issue → next todo → researched issue → draft issue
2. Next planned epic to start
3. Next draft epic to prepare

Note: unassigned issues (no epic) are excluded from next_work. Use \`issue_list\` with \`unassigned: true\` to triage them.

No parameters.`,

  project_config: `## /config — View and edit project manager config
Opens an interactive TUI widget to toggle and edit all config settings.

### Config keys
| Key | Type | Default | Description |
|-----|------|---------|-------------|
| \`workflow.write_gate\` | bool | true | Block file writes when no issue is in-progress |
| \`context.brief_verbosity\` | select | normal | LLM context verbosity at session start (minimal/normal/verbose) |
| \`context.unassigned_bugs_in_steering\` | bool | true | Show unassigned bugs in per-turn steering context |
| \`git.enabled\` | bool | false | Master switch for git workflow guards |
| \`git.epic_branch\` | bool | true | Create git branch when epic goes in-progress |
| \`git.require_clean_worktree\` | bool | true | Block issue start if worktree is dirty |
| \`git.require_epic_branch\` | bool | true | Block issue start if epic branch doesn't exist |
| \`git.require_commit_on_close\` | bool | true | Block issue close if no new commits since issue started |
| \`git.require_commit_id_on_close\` | bool | true | Block issue_close unless a valid commit SHA is provided |
| \`git.merge_check_on_epic_close\` | bool | true | Warn if epic branch not merged when closing epic |

### Widget controls
- **↑↓** navigate, **Enter/Space** toggle bool or cycle select, **r** reset to default, **Ctrl+R** reset all, **Esc** close
- String fields: Enter opens inline edit, type to change, Enter to save, Esc to cancel`,
};

export function registerToolDocsTool(pi: ExtensionAPI) {
  pi.registerTool({
    name: "project_tool_docs",
    label: "Project Tool Docs",
    description: "Get full usage docs for any project management tool (epic_*, issue_*, asset_*, next_work).",
    parameters: Type.Object({
      tool: Type.String({ description: "Tool name (e.g. 'epic_add') or 'all' to list available tools" }),
    }),
    async execute(_id, params) {
      if (params.tool === "all") {
        const groups: Record<string, string[]> = {};
        for (const name of Object.keys(TOOL_DOCS)) {
          const prefix = name.split("_")[0];
          if (!groups[prefix]) groups[prefix] = [];
          groups[prefix].push(name);
        }
        let out = "# Project Management Tools\n";
        for (const [prefix, tools] of Object.entries(groups)) {
          out += `\n**${prefix}:** ${tools.join(", ")}`;
        }
        out += "\n\nCall with a specific tool name for full docs.";
        return { content: [{ type: "text", text: out }] };
      }
      const doc = TOOL_DOCS[params.tool];
      if (!doc) {
        return {
          content: [{ type: "text", text: `Unknown tool: '${params.tool}'. Use tool='all' to list available tools.` }],
          isError: true,
        };
      }
      return { content: [{ type: "text", text: doc }] };
    },
  });
}
