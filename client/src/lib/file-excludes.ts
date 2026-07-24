/*
 * Default directory skip list for file walking.
 *
 * Both the right-panel `FileTree` and the fuzzy file finder
 * (`FileFinderDialog`) recursively walk a worktree to list files.
 * Without exclusions, a fresh `npm install` produces a `node_modules`
 * tree with hundreds of thousands of files, and a Vite/Next build
 * produces a `.next/` / `dist/` tree that's just as bad — the walk
 * saturates the disk and the dialog feels stuck.
 *
 * Editors handle this with a hardcoded default exclude list (VS Code
 * ships patterns like `**` + `/.git`, `**` + `/node_modules`, etc.)
 * and an opt-in `.gitignore` integration. We mirror the same
 * approach:
 *
 *   1. Hardcode a sensible default list here. Each entry is a
 *      directory *basename* — we match on the leaf name only, not the
 *      full path, so a project directory literally named `dist`
 *      (rare but possible) is also skipped. That matches the VS Code
 *      / Sublime convention and avoids surprising the user with a
 *      half-walked tree.
 *   2. The skip happens in `fetchSourceDirectory` (client-side)
 *      before the response reaches the tree, so neither surface has
 *      to know about the list. The server stays dumb and continues
 *      to return every entry — moving the filter server-side is a
 *      v3 concern (see the open question in issue #313).
 *
 * Keep the list deliberately short: every entry is something the
 * user almost never wants to open. Long lists make the finder feel
 * magical-but-magical, and the user can always type the explicit
 * path to look inside an excluded directory.
 */
export const EXCLUDED_DIRECTORIES: ReadonlySet<string> = new Set([
  // VCS metadata — never useful in the file picker.
  ".git",
  ".hg",
  ".svn",
  // JS / TS / bundler caches and outputs.
  "node_modules",
  "bower_components",
  ".pnpm-store",
  ".yarn",
  ".pnp",
  "dist",
  "build",
  "out",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".cache",
  ".parcel-cache",
  ".turbo",
  ".vercel",
  ".netlify",
  "coverage",
  // Python tooling.
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".tox",
  ".venv",
  "venv",
  "site-packages",
  // Rust / JVM.
  "target",
  ".gradle",
  ".idea",
  // OS / editor cruft.
  ".DS_Store",
  "Thumbs.db",
]);

/**
 * True when a directory with the given basename should be excluded
 * from file walks. Returns false for files (we only filter at the
 * directory boundary; matching an individual file would be too
 * aggressive and would surprise users who want to open, say,
 * `node_modules/.bin/some-cli`).
 */
export function shouldExcludeDirectory(name: string): boolean {
  return EXCLUDED_DIRECTORIES.has(name);
}
