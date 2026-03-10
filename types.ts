export type IssueType = "bug" | "feature" | "chore" | "spike" | "idea";
export type IssueStatus = "draft" | "researched" | "ready" | "in-progress" | "closed";
export type EpicStatus = "draft" | "planned" | "in-progress" | "closed";
export type CloseReason = "done" | "deferred" | "wont-fix";

export interface ResearchNote {
  type: "example" | "reference" | "comment";
  content: string;
  addedAt: string;
}

export type ValidationType = "agent" | "human" | "other";

export interface AutoValidation {
  type: ValidationType;
  strategy: string; // how to verify (agent/human) or why it's other
  // Legacy compat
  possible?: boolean;
}

export interface Issue {
  id: string;
  type: IssueType;
  title: string;
  description: string;
  status: IssueStatus;
  epicId?: string;
  linkedIssueIds: string[];
  questions: { text: string; answer?: string; required?: boolean }[];
  autoValidation?: AutoValidation;
  closeReviewed?: boolean;
  closeMessage?: string;
  closeReason?: CloseReason;
  validations?: Validation[];
  research: ResearchNote[];
  startCommit?: string;  // HEAD SHA when issue went in-progress
  closeCommit?: string;  // commit SHA attached on close
  createdAt: string;
  updatedAt: string;
  closedAt?: string;
}

export interface Epic {
  id: string;
  title: string;
  description: string;
  body: string;
  priority: number;
  status: EpicStatus;
  gitBranch?: string;    // branch created when epic went in-progress
  closeMessage?: string;
  closeReason?: CloseReason;
  validations?: Validation[];
  relevantFiles: { file: string; reason: string }[];
  todos: { text: string; done: boolean }[];
  successCriteria: string[];
  research: ResearchNote[];
  createdAt: string;
  updatedAt: string;
  closedAt?: string;
}

export interface AssetSource {
  type: "file" | "url";
  path: string; // file path or URL
  description: string;
}

export interface AssetCategory {
  slug: string;
  description: string;
}

export type PolicyEvent = "epic_create" | "epic_close" | "epic_advance" | "issue_create" | "issue_close" | "issue_advance";

export interface Asset {
  id: string;
  categorySlug: string;
  title: string;
  context: string; // AI-optimized: when/why to apply this asset
  body: string; // full content
  project: boolean; // if true, inject at session start
  trigger?: { event: PolicyEvent }; // if set, body is injected as directive when event fires
  sources: AssetSource[];
  linkedEpicIds: string[];
  linkedIssueIds: string[];
  createdAt: string;
  updatedAt: string;
}

export const CURRENT_VERSION = 9;

export interface Validation {
  criterion: string;
  evidence: string;
  met: boolean;
}

export interface ProjectFile {
  version: number;
  epics: Epic[];
  issues: Issue[];
  categories: AssetCategory[];
  assets: Asset[];
  config: Record<string, unknown>;
}

export const ISSUE_TRANSITIONS: Record<IssueStatus, IssueStatus[]> = {
  draft: ["researched", "closed"],
  researched: ["ready", "draft", "closed"],
  ready: ["in-progress", "researched", "closed"],
  "in-progress": ["closed", "ready"],
  closed: ["draft"],
};

export const ISSUE_NEXT: Record<IssueStatus, IssueStatus | null> = {
  draft: "researched",
  researched: "ready",
  ready: "in-progress",
  "in-progress": "closed",
  closed: null,
};

export const EPIC_TRANSITIONS: Record<EpicStatus, EpicStatus[]> = {
  draft: ["planned", "closed"],
  planned: ["in-progress", "draft", "closed"],
  "in-progress": ["closed", "planned"],
  closed: ["draft"],
};

export const EPIC_NEXT: Record<EpicStatus, EpicStatus | null> = {
  draft: "planned",
  planned: "in-progress",
  "in-progress": "closed",
  closed: null,
};
