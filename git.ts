import { execSync } from "child_process";

/** Run a git command, return stdout trimmed. Throws on non-zero exit. */
function git(args: string, cwd?: string): string {
  return execSync(`git ${args}`, { cwd: cwd || process.cwd(), encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

/** Run a git command, return stdout trimmed. Returns null on failure instead of throwing. */
function gitSafe(args: string, cwd?: string): string | null {
  try {
    return git(args, cwd);
  } catch {
    return null;
  }
}

/** Returns true if the working tree is clean (no uncommitted changes). */
export function isClean(): boolean {
  const out = gitSafe("status --porcelain");
  if (out === null) return true; // not a git repo — don't block
  return out.length === 0;
}

/** Returns the current branch name, or null if not in a git repo. */
export function currentBranch(): string | null {
  return gitSafe("rev-parse --abbrev-ref HEAD");
}

/** Returns true if a branch with the given name exists locally. */
export function branchExists(name: string): boolean {
  const out = gitSafe(`branch --list ${name}`);
  return out !== null && out.trim().length > 0;
}

/** Creates a new branch from the current HEAD. Returns error string or null on success. */
export function createBranch(name: string): string | null {
  try {
    git(`checkout -b ${name}`);
    return null;
  } catch (e: any) {
    return e.message || String(e);
  }
}

/** Returns true if a commit SHA exists in the repo. */
export function commitExists(sha: string): boolean {
  const out = gitSafe(`cat-file -t ${sha}`);
  return out === "commit";
}

/** Returns true if there are any commits reachable from HEAD that are not reachable from baseSha. */
export function hasCommitsSince(baseSha: string): boolean {
  const out = gitSafe(`rev-list ${baseSha}..HEAD --count`);
  if (out === null) return false;
  return parseInt(out, 10) > 0;
}

/** Returns the current HEAD commit SHA, or null if not in a git repo / no commits yet. */
export function headSha(): string | null {
  return gitSafe("rev-parse HEAD");
}

/** Slugify a title for use in branch names. */
export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
}

/** Build a canonical epic branch name. */
export function epicBranchName(epicId: string, title: string): string {
  return `epic/${epicId}-${slugify(title)}`;
}

/** Check if we're inside a git repository. */
export function isGitRepo(): boolean {
  return gitSafe("rev-parse --git-dir") !== null;
}

/** Get the default branch (main or master). */
export function defaultBranch(): string {
  const out = gitSafe("symbolic-ref refs/remotes/origin/HEAD");
  if (out) return out.replace("refs/remotes/origin/", "");
  // fallback: check if main or master exist
  if (gitSafe("rev-parse --verify main") !== null) return "main";
  if (gitSafe("rev-parse --verify master") !== null) return "master";
  return "main";
}

/** Check if branchName is fully merged into targetBranch. */
export function isMergedInto(branchName: string, targetBranch: string): boolean {
  const out = gitSafe(`branch --merged ${targetBranch}`);
  if (out === null) return false;
  return out.split("\n").map(l => l.trim().replace(/^\* /, "")).includes(branchName);
}
