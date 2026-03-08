import type { ProjectFile } from "./types.js";
import { CURRENT_VERSION } from "./types.js";

type Migration = (data: any) => any;

/**
 * Each migration takes the data from version N and returns version N+1.
 * Key is the version being migrated FROM.
 */
const migrations: Record<number, Migration> = {
  // v1 → v2: rename "items" to "epics", add "issues" array
  1: (data) => {
    if (data.items && !data.epics) {
      data.epics = data.items;
      delete data.items;
    }
    if (!data.issues) data.issues = [];
    data.version = 2;
    return data;
  },

  // v2 → v3: add "research" arrays, add "in-progress" as valid issue status
  2: (data) => {
    for (const e of data.epics || []) {
      if (!e.research) e.research = [];
    }
    for (const i of data.issues || []) {
      if (!i.research) i.research = [];
    }
    data.version = 3;
    return data;
  },

  // v3 → v4: add "validations" arrays for close evidence
  3: (data) => {
    for (const e of data.epics || []) {
      if (!e.validations) e.validations = [];
    }
    for (const i of data.issues || []) {
      if (!i.validations) i.validations = [];
    }
    data.version = 4;
    return data;
  },

  // v4 → v5: add asset categories and assets
  4: (data) => {
    if (!data.categories) data.categories = [];
    if (!data.assets) data.assets = [];
    data.version = 5;
    return data;
  },

  // v5 → v6: add linkedIssueIds to issues
  5: (data) => {
    for (const i of data.issues || []) {
      if (!i.linkedIssueIds) i.linkedIssueIds = [];
    }
    data.version = 6;
    return data;
  },

  // v6 → v7: add questions to issues
  6: (data) => {
    for (const i of data.issues || []) {
      if (!i.questions) i.questions = [];
    }
    data.version = 7;
    return data;
  },
};

/**
 * Migrate a project file from any version to CURRENT_VERSION.
 * Returns the migrated data and whether any migrations were applied.
 */
export function migrate(data: any): { data: ProjectFile; migrated: boolean } {
  // Handle no version (v1)
  if (!data.version) data.version = 1;

  const startVersion = data.version;

  while (data.version < CURRENT_VERSION) {
    const fn = migrations[data.version];
    if (!fn) {
      throw new Error(
        `No migration path from version ${data.version} to ${data.version + 1}. ` +
        `Current version is ${CURRENT_VERSION}.`
      );
    }
    data = fn(data);
  }

  return { data: data as ProjectFile, migrated: data.version !== startVersion || startVersion !== CURRENT_VERSION };
}
