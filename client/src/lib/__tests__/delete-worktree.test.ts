import test from "node:test";
import assert from "node:assert/strict";

/*
 * Issue #332 client-side regression test for `deleteWorktree`. The
 * route's safe-by-default gate returns 409 with `dirtyFiles: string[]`
 * when the worktree has uncommitted changes, and 409 with the same
 * field when `?force=1` is sent without an archive script. The API
 * client must surface both as typed errors so the sidebar can offer a
 * force-retry rather than failing silently with a toast.
 *
 * The client lives at `client/src/api.ts` and uses `fetch`. We stub
 * `globalThis.fetch` per-test rather than reaching for a heavier mock
 * framework, which matches the style of the controller-CLI tests.
 */

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

function installFetchMock(
  handler: (call: FetchCall) => Response,
): { calls: FetchCall[]; restore: () => void } {
  const calls: FetchCall[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, init });
    return handler({ url, init });
  }) as typeof globalThis.fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const ORIGINAL_BASE = process.env.CONTROLLER_BASE_URL;

test.after(() => {
  if (ORIGINAL_BASE === undefined) delete process.env.CONTROLLER_BASE_URL;
  else process.env.CONTROLLER_BASE_URL = ORIGINAL_BASE;
});

test("deleteWorktree issues a bare DELETE when no force flag is provided", async () => {
  const mock = installFetchMock(() => jsonResponse(200, {}));
  try {
    const { deleteWorktree } = await import("../../api.ts");
    await deleteWorktree("proj-1", "wt-1");
    assert.equal(mock.calls.length, 1);
    const call = mock.calls[0];
    assert.equal(call.init?.method, "DELETE");
    assert.ok(
      call.url.includes("/projects/proj-1/worktrees/wt-1"),
      `unexpected URL: ${call.url}`,
    );
    assert.ok(
      !call.url.includes("force="),
      `force= should not appear without options.force: ${call.url}`,
    );
  } finally {
    mock.restore();
  }
});

test("deleteWorktree appends ?force=1 when force is true", async () => {
  const mock = installFetchMock(() => jsonResponse(200, {}));
  try {
    const { deleteWorktree } = await import("../../api.ts");
    await deleteWorktree("proj-1", "wt-1", { force: true });
    assert.equal(mock.calls.length, 1);
    const call = mock.calls[0];
    assert.equal(call.init?.method, "DELETE");
    assert.match(call.url, /[?&]force=1(\b|&|$)/);
  } finally {
    mock.restore();
  }
});

test("deleteWorktree exposes dirtyFiles from the orchestrator's safe-by-default gate", async () => {
  const mock = installFetchMock(() =>
    jsonResponse(409, {
      error: "worktree has uncommitted changes; pass ?force=1 to delete",
      dirtyFiles: ["user-note.txt", "src/foo.ts"],
    }),
  );
  try {
    const { deleteWorktree } = await import("../../api.ts");
    await assert.rejects(
      deleteWorktree("proj-1", "wt-1"),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        const e = err as Error & { dirtyFiles?: unknown; status?: unknown };
        assert.equal(e.status, 409);
        assert.deepEqual(e.dirtyFiles, ["user-note.txt", "src/foo.ts"]);
        return true;
      },
    );
    assert.equal(mock.calls.length, 1);
    // The first attempt must NOT carry the force flag — the sidebar
    // relies on this to decide whether to show the warning or retry
    // with force.
    assert.ok(!mock.calls[0].url.includes("force="));
  } finally {
    mock.restore();
  }
});

test("deleteWorktree surfaces the server error message when no dirtyFiles are present", async () => {
  const mock = installFetchMock(() =>
    jsonResponse(500, { error: "git worktree remove exited with 128" }),
  );
  try {
    const { deleteWorktree } = await import("../../api.ts");
    await assert.rejects(
      deleteWorktree("proj-1", "wt-1"),
      /git worktree remove exited with 128/,
    );
  } finally {
    mock.restore();
  }
});
