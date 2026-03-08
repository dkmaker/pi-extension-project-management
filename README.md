# pi-extension-project-management

A [pi coding agent](https://github.com/badlogic/pi) extension for lightweight project management with epics, issues, assets, and prioritized work tracking.

## Features

- **Epics** — high-level goals with todos, success criteria, and status workflow (draft → researched → ready → in-progress → closed)
- **Issues** — bugs, features, chores, spikes, and ideas linked to epics
- **Assets** — reusable policies, rules, and snippets with category organization
- **Priority-based work queue** — `next_work` tool finds the highest-priority item to work on
- **Dashboard** — `/project` command shows a full project overview
- **Research notes** — attach examples, references, and comments to epics and issues

## Installation

```bash
pi install github:dkmaker/pi-extension-project-management
```

Or manually add to your pi `settings.json` (global or project):

```json
{
  "packages": [
    "github:dkmaker/pi-extension-project-management"
  ]
}
```

Then restart pi or run `/reload`.

## Tools

| Tool | Description |
|------|-------------|
| `epic_add`, `epic_show`, `epic_list`, `epic_update`, `epic_advance`, `epic_close`, `epic_reopen` | Epic management |
| `epic_todo`, `epic_research` | Epic todos and research notes |
| `issue_add`, `issue_show`, `issue_list`, `issue_update`, `issue_advance`, `issue_close`, `issue_reopen` | Issue management |
| `issue_research`, `issue_link`, `issue_unlink`, `issue_question` | Issue research, linking, and questions |
| `asset_add`, `asset_show`, `asset_list`, `asset_update`, `asset_link`, `asset_unlink`, `asset_categories`, `asset_source` | Asset management |
| `next_work` | Find next priority work item |
| `project_tool_docs` | Get detailed usage docs for any tool |

## Commands

| Command | Description |
|---------|-------------|
| `/project` | Open the project dashboard |

## Dependencies

None. The extension imports `@mariozechner/pi-coding-agent` and `@mariozechner/pi-tui` which are provided by the pi runtime.

## Data Storage

All data is stored in `.pi/project/` relative to your workspace root. Each workspace has its own isolated project data.

## License

MIT
