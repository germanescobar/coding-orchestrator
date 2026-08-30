import path from "node:path";
import { v4 as uuidv4 } from "uuid";
import { getProject, getProjects, type Project } from "./projects.js";
import {
  RegistryParseError,
  readJsonRegistry,
  validateArray,
  withLock,
  writeJsonRegistry,
} from "./json-registry.js";
import { worktreesRegistryFile } from "./paths.js";

export interface Worktree {
  id: string;
  projectId: string;
  name: string;
  path: string;
  branch?: string;
  isMain: boolean;
  portOffset?: number;
  createdAt: string;
  setupRanAt?: string;
  setupExitCode?: number;
  setupLogPath?: string;
}

const MAIN_WORKTREE_NAME = "main";

/**
 * Run `fn` with the worktrees registry loaded and the per-file mutex held.
 *
 * Issue #332: every read-modify-write against `worktrees.json` must go
 * through this helper. Concurrent reads that observe a stale or partial
 * file used to silently nuke the registry; holding the lock around the
 * read-modify-write window prevents the interleaving that caused that
 * loss.
 *
 * `fn` is given the current registry contents (or `[]` on first run)
 * and may mutate the array in place. Whatever it leaves in the array
 * is what gets persisted — there is no separate "compute new value"
 * step that could race against another caller.
 */
async function withWorktreeRegistry<T>(
  fn: (registry: Worktree[]) => Promise<T>
): Promise<T> {
  const file = worktreesRegistryFile();
  return withLock(file, async () => {
    const { value: registry } = await readJsonRegistry<Worktree[]>(file, {
      defaultValue: [],
      backup: `${file}.bak`,
      validate: validateArray<Worktree>,
    });
    const result = await fn(registry);
    await writeJsonRegistry(file, registry);
    return result;
  });
}

function buildMainWorktree(project: Project): Worktree {
  return {
    id: uuidv4(),
    projectId: project.id,
    name: MAIN_WORKTREE_NAME,
    path: project.path,
    isMain: true,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Ensure a project has a main worktree row. Returns the main worktree
 * after lazy-creating the row if it was missing. Mutates `registry` in
 * place — callers must run inside a registry lock so concurrent callers
 * don't both observe "no main", both create one, and both write back,
 * leaving two orphan rows for the same project.
 */
function ensureMainInRegistry(
  project: Project,
  registry: Worktree[]
): Worktree {
  const existing = registry.find(
    (w) => w.projectId === project.id && w.isMain
  );
  if (existing) return existing;
  const main = buildMainWorktree(project);
  registry.push(main);
  return main;
}

export async function ensureMainWorktree(project: Project): Promise<Worktree> {
  return withWorktreeRegistry(async (registry) =>
    ensureMainInRegistry(project, registry)
  );
}

export async function getProjectWorktrees(
  projectId: string
): Promise<Worktree[]> {
  const project = await getProject(projectId);
  if (!project) return [];
  try {
    return await withWorktreeRegistry(async (registry) => {
      ensureMainInRegistry(project, registry);
      return registry.filter((w) => w.projectId === projectId);
    });
  } catch (err) {
    if (err instanceof RegistryParseError) {
      // Surface the corruption to the operator but do not persist a
      // replacement. Returning `[]` here would let a single bad write
      // empty the entire registry on the next caller.
      console.error(`worktrees.json is unreadable: ${err.message}`);
      return [];
    }
    throw err;
  }
}

export async function getWorktree(
  projectId: string,
  worktreeId: string
): Promise<Worktree | null> {
  const worktrees = await getProjectWorktrees(projectId);
  if (worktreeId === MAIN_WORKTREE_NAME) {
    return worktrees.find((w) => w.isMain) ?? null;
  }
  return worktrees.find((w) => w.id === worktreeId) ?? null;
}

/**
 * Find the worktree that contains the given filesystem path, matching the
 * longest path prefix across every project. Used by the preview browser route
 * to map an agent's shell cwd to the pane it should drive.
 */
export async function findWorktreeByPath(
  targetPath: string
): Promise<Worktree | null> {
  const resolved = path.resolve(targetPath);
  const projects = await getProjects();
  let best: Worktree | null = null;
  let bestLen = -1;
  for (const project of projects) {
    for (const worktree of await getProjectWorktrees(project.id)) {
      const worktreePath = path.resolve(worktree.path);
      const inside =
        resolved === worktreePath ||
        resolved.startsWith(worktreePath + path.sep);
      if (inside && worktreePath.length > bestLen) {
        best = worktree;
        bestLen = worktreePath.length;
      }
    }
  }
  return best;
}

/**
 * Resolve a worktree from a query string. Defaults to the project's main
 * worktree when no id is provided. Accepts the literal alias "main".
 */
export async function resolveWorktree(
  projectId: string,
  worktreeIdParam?: string | string[]
): Promise<Worktree | null> {
  const project = await getProject(projectId);
  if (!project) return null;
  const id = Array.isArray(worktreeIdParam)
    ? worktreeIdParam[0]
    : worktreeIdParam;
  if (!id || id === MAIN_WORKTREE_NAME) {
    return ensureMainWorktree(project);
  }
  return getWorktree(projectId, id);
}

export async function addWorktree(
  worktree: Omit<Worktree, "id" | "createdAt"> & { id?: string }
): Promise<Worktree> {
  const record: Worktree = {
    id: worktree.id ?? uuidv4(),
    createdAt: new Date().toISOString(),
    ...worktree,
  };
  return withWorktreeRegistry(async (registry) => {
    registry.push(record);
    return record;
  });
}

export async function updateWorktree(
  worktreeId: string,
  patch: Partial<Worktree>
): Promise<Worktree | null> {
  return withWorktreeRegistry(async (registry) => {
    const idx = registry.findIndex((w) => w.id === worktreeId);
    if (idx === -1) return null;
    const updated: Worktree = { ...registry[idx], ...patch, id: registry[idx].id };
    registry[idx] = updated;
    return updated;
  });
}

export async function removeWorktree(worktreeId: string): Promise<boolean> {
  return withWorktreeRegistry(async (registry) => {
    const next = registry.filter((w) => w.id !== worktreeId);
    if (next.length === registry.length) return false;
    registry.length = 0;
    registry.push(...next);
    return true;
  });
}

/**
 * Gap between consecutive worktree port offsets. Projects often run several
 * services on consecutive ports (e.g. 5000 and 5001), so a stride of 1 would
 * let one worktree's higher port collide with the next worktree's base port.
 * A stride of 3 leaves room between worktrees; projects that need more are
 * responsible for picking free ports at runtime.
 */
export const PORT_OFFSET_STRIDE = 3;

/** Monotonic per-project port offset: max existing + stride, starting at stride. */
export async function nextPortOffset(projectId: string): Promise<number> {
  return withWorktreeRegistry(async (registry) => {
    const used = registry
      .filter((w) => w.projectId === projectId && typeof w.portOffset === "number")
      .map((w) => w.portOffset as number);
    if (used.length === 0) return PORT_OFFSET_STRIDE;
    return Math.max(...used) + PORT_OFFSET_STRIDE;
  });
}

export function isMainWorktreeName(name: string): boolean {
  return name === MAIN_WORKTREE_NAME;
}

export const WORKTREE_NAME_REGEX = /^[a-z0-9][a-z0-9._-]*$/;
export const WORKTREE_NAME_MAX_LENGTH = 64;