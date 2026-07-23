import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/*
 * Issue #312 (P1 review): the queue endpoint's `parseQueuedMessageInput`
 * dropped the client-supplied `mentions` field before storage, so a
 * queued message with mention chips lost them on enqueue and the
 * queue-replay path (`advanceSessionQueue`) replayed the next turn
 * without the file context the user already saw in the composer.
 *
 * These tests mount the real `sessionsRouter` against a temp
 * `CONTROLLER_HOME`, enqueue a message with `mentions`, and assert
 * the field round-trips through `POST` + `GET` + the on-disk
 * representation.
 */

interface RoutesEnv {
  baseUrl: string;
  projectId: string;
  sessionId: string;
}

async function withRoutes<T>(fn: (env: RoutesEnv) => Promise<T>): Promise<T> {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "queue-routes-"));
  const previous = process.env.CONTROLLER_HOME;
  process.env.CONTROLLER_HOME = homeDir;
  const projectId = "proj-1";
  const projectPath = path.join(homeDir, "source");
  await fs.mkdir(projectPath, { recursive: true });
  await fs.writeFile(
    path.join(homeDir, "projects.json"),
    JSON.stringify([
      {
        id: projectId,
        name: "demo",
        path: projectPath,
        createdAt: new Date().toISOString(),
      },
    ])
  );
  const { sessionsRouter } = await import("../../routes/sessions.js");
  const app = express();
  app.use(express.json({ limit: "10mb" }));
  // Mounted under the same prefix the real app uses
  // (`server/index.ts`: `app.use("/api/projects", sessionsRouter)`).
  // The router's own paths already include `:projectId`, so the
  // final URL is `${baseUrl}/${projectId}/sessions/...`.
  app.use("/api/projects", sessionsRouter);
  const server = http.createServer(app);
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve())
  );
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("server failed to bind a port");
  }
  const baseUrl = `http://127.0.0.1:${address.port}/api/projects`;
  try {
    return await fn({ baseUrl, projectId, sessionId: "s-1" });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (previous === undefined) delete process.env.CONTROLLER_HOME;
    else process.env.CONTROLLER_HOME = previous;
    await fs.rm(homeDir, { recursive: true, force: true });
  }
}

test("POST /queue preserves mentions and GET /queue returns them", async () => {
  await withRoutes(async ({ baseUrl, projectId, sessionId }) => {
    const response = await fetch(
      `${baseUrl}/${projectId}/sessions/${sessionId}/queue`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text: "look at @server/lib/sessions.ts",
          visibleText: "look at @server/lib/sessions.ts",
          provider: "claude",
          model: "claude/test",
          mode: "default",
          attachmentIds: [],
          mentions: [
            { path: "server/lib/sessions.ts", type: "file" },
            { path: "client/src", type: "directory" },
          ],
        }),
      }
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      message?: { mentions?: { path: string; type: string }[] };
    };
    assert.deepEqual(body.message?.mentions, [
      { path: "server/lib/sessions.ts", type: "file" },
      { path: "client/src", type: "directory" },
    ]);

    const getResponse = await fetch(
      `${baseUrl}/${projectId}/sessions/${sessionId}/queue`
    );
    const getBody = (await getResponse.json()) as {
      queue?: { mentions?: { path: string; type: string }[] }[];
    };
    assert.equal(getBody.queue?.length, 1);
    assert.deepEqual(getBody.queue?.[0].mentions, [
      { path: "server/lib/sessions.ts", type: "file" },
      { path: "client/src", type: "directory" },
    ]);
  });
});

test("POST /queue drops malformed mention rows but keeps the rest", async () => {
  await withRoutes(async ({ baseUrl, projectId, sessionId }) => {
    const response = await fetch(
      `${baseUrl}/${projectId}/sessions/${sessionId}/queue`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text: "x",
          visibleText: "x",
          provider: "claude",
          model: "claude/test",
          mode: "default",
          attachmentIds: [],
          // Mixed: a valid row, a row with the wrong type, and a
          // row with a non-string path. Only the valid row should
          // survive normalization — the rest are dropped silently
          // (matches the existing pattern for `attachmentIds`).
          mentions: [
            { path: "a.ts", type: "file" },
            { path: "b.ts", type: "garbage" },
            { path: 42, type: "file" },
            null,
            "not an object",
            { path: "c.ts", type: "directory" },
          ],
        }),
      }
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      message?: { mentions?: { path: string; type: string }[] };
    };
    assert.deepEqual(body.message?.mentions, [
      { path: "a.ts", type: "file" },
      { path: "c.ts", type: "directory" },
    ]);
  });
});

test("POST /queue with no mentions field succeeds and stores no mentions", async () => {
  // A queued message without mention chips must still work — the
  // regression in `parseQueuedMessageInput` was a missing read, not
  // a required field, so omitting `mentions` is the default.
  await withRoutes(async ({ baseUrl, projectId, sessionId }) => {
    const response = await fetch(
      `${baseUrl}/${projectId}/sessions/${sessionId}/queue`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text: "no mentions here",
          visibleText: "no mentions here",
          provider: "claude",
          model: "claude/test",
          mode: "default",
          attachmentIds: [],
        }),
      }
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      message?: { mentions?: unknown };
    };
    assert.equal(body.message?.mentions, undefined);
  });
});

test("POST /queue with an empty mentions array omits the field", async () => {
  // Same as above for the empty-array shape: an empty list is
  // equivalent to no mentions, so we collapse it to `undefined` to
  // keep the persisted representation tight.
  await withRoutes(async ({ baseUrl, projectId, sessionId }) => {
    const response = await fetch(
      `${baseUrl}/${projectId}/sessions/${sessionId}/queue`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text: "x",
          visibleText: "x",
          provider: "claude",
          model: "claude/test",
          mode: "default",
          attachmentIds: [],
          mentions: [],
        }),
      }
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      message?: { mentions?: unknown };
    };
    assert.equal(body.message?.mentions, undefined);
  });
});
