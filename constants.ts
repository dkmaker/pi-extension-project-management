// Centralized icon and label maps — single source of truth

export const EPIC_STATUS_ICON: Record<string, string> = {
  draft: "📝",
  planned: "📋",
  "in-progress": "🔧",
  closed: "🏁",
};

export const EPIC_STATUS_LABEL: Record<string, string> = {
  draft: "📝 draft",
  planned: "📋 planned",
  "in-progress": "🔧 in-progress",
  closed: "🏁 closed",
};

export const ISSUE_TYPE_ICON: Record<string, string> = {
  bug: "🐛",
  feature: "✨",
  chore: "🔧",
  spike: "🔍",
  idea: "💭",
};

export const ISSUE_STATUS_LABEL: Record<string, string> = {
  draft: "📝 draft",
  researched: "🔬 researched",
  ready: "✅ ready",
  "in-progress": "🔧 in-progress",
  closed: "🏁 closed",
};
