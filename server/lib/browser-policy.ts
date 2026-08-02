/*
 * Navigation/permission policy for the preview browser (issue #109).
 *
 * Mirrors the v1 Preview pane policy enforced in `electron/main.ts`: localhost
 * and project-local file URLs are allowed by default, plus web URLs. The
 * Electron main process remains the ultimate enforcer for live navigation (via
 * its `will-navigate` guard); this server-side check gives the CLI a fast,
 * clear error before a command is forwarded to the renderer.
 */

import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

function isLocalhostUrl(input: string): boolean {
  return /^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:[/?#].*)?$/i.test(input);
}

function looksLikeRelativeProjectPath(input: string): boolean {
  return (
    input.startsWith("./") ||
    input.startsWith("../") ||
    input.includes("/") ||
    input.includes("\\")
  );
}

function hasUrlScheme(input: string): boolean {
  return /^[a-z][a-z\d+.-]*:/i.test(input);
}

function normalizePreviewUrl(input: string, projectRoot?: string): string {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("Enter a URL to preview");

  if (isLocalhostUrl(trimmed)) {
    return `http://${trimmed}`;
  }

  if (path.isAbsolute(trimmed)) {
    return pathToFileURL(trimmed).toString();
  }

  if (hasUrlScheme(trimmed)) {
    return new URL(trimmed).toString();
  }

  if (projectRoot && looksLikeRelativeProjectPath(trimmed)) {
    return pathToFileURL(path.resolve(projectRoot, trimmed)).toString();
  }

  return new URL(trimmed).toString();
}

function isPathInside(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return (
    relative === "" ||
    (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

export interface PreviewUrlCheck {
  allowed: boolean;
  url?: string;
  error?: string;
}

export interface ValidateBrowserUrlOptions {
  /**
   * The agent has opted in to bypassing TLS validation for this navigation
   * (via `controller browser open --insecure`). When true, `https` URLs are
   * only allowed for localhost-shaped hosts — the same `isLocalhostUrl`
   * shape used to gate non-`https` previews. This is a deliberate trust
   * bound: the bypass exists so dev servers with self-signed certs can be
   * reached, not so an agent can talk to an arbitrary external host without
   * cert validation.
   */
  insecure?: boolean;
}

/**
 * Validate and normalize a URL the agent wants to open. Returns the canonical
 * URL to forward to the renderer, or a reason it was rejected.
 */
export function validateBrowserUrl(
  input: string,
  projectRoot?: string,
  options: ValidateBrowserUrlOptions = {}
): PreviewUrlCheck {
  let url: URL;
  try {
    url = new URL(normalizePreviewUrl(input, projectRoot));
  } catch {
    return { allowed: false, error: "Enter a valid web or project file URL" };
  }

  if (url.protocol === "http:" || url.protocol === "https:") {
    if (options.insecure && !isLocalhostHost(url.hostname)) {
      return {
        allowed: false,
        error: "--insecure only applies to localhost URLs (got " + url.hostname + ")",
      };
    }
    return { allowed: true, url: url.toString() };
  }

  if (url.protocol === "file:") {
    if (!projectRoot) {
      return {
        allowed: false,
        error: "Project files can only be previewed after the worktree is loaded",
      };
    }
    let filePath: string;
    try {
      filePath = fileURLToPath(url);
    } catch {
      return { allowed: false, error: "Invalid file URL" };
    }
    if (!isPathInside(projectRoot, filePath)) {
      return {
        allowed: false,
        error: "File previews must stay inside the active project",
      };
    }
    return { allowed: true, url: url.toString() };
  }

  return {
    allowed: false,
    error: "Only web URLs and project file previews are allowed",
  };
}

/**
 * Returns true when `hostname` is a loopback address that the agent can
 * plausibly be running a local dev server on. Mirrors the `isLocalhostUrl`
 * matcher above so the policy and the Electron cert-verify bypass agree on
 * what counts as a localhost target.
 */
function isLocalhostHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  return (
    lower === "localhost" ||
    lower === "127.0.0.1" ||
    lower === "[::1]" ||
    lower === "::1"
  );
}
