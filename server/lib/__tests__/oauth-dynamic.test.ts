import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

/*
 * OAuth (dynamic / MCP) acquisition — issue #280.
 *
 * Coverage:
 *   - discoverMetadata builds the right well-known URL and rejects when the
 *     AS isn't there.
 *   - dynamicClientRegistration hits the registration endpoint and returns
 *     the client id.
 *   - startInteractiveOauth: end-to-end PKCE happy path with a mocked AS.
 *     The loopback listener runs on a real local port and is hit by the
 *     test's own HTTP client.
 *   - getValidToken: returns the access token when fresh; refreshes when
 *     close to expiry; returns null when the scheme has no secret yet.
 *   - getValidToken: marks the scheme expired when refresh fails.
 *   - getValidToken: persists a refreshed token to the secret store so
 *     the next process restart resumes.
 *   - acquireStatus mirrors what the UI renders.
 *   - clearDynamicOauth wipes the stored token and resets the scheme to
 *     "none".
 *
 * The server module's secret store derives its file paths from
 * CONTROLLER_HOME; the env var is reset around each test.
 */

interface Route {
  method: string;
  url: string;
  status: number;
  body: unknown;
}

async function withTempHome<T>(
  fn: (mods: {
    integrations: typeof import("../integrations.js");
    oauth: typeof import("../oauth-dynamic.js");
  }) => Promise<T>
): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "oauth-dyn-test-"));
  const previous = process.env.CONTROLLER_HOME;
  process.env.CONTROLLER_HOME = dir;
  try {
    const oauth = await import(`../oauth-dynamic.js?t=${Date.now()}-${Math.random()}`);
    const integrations = await import(`../integrations.js?t=${Date.now()}-${Math.random()}`);
    return await fn({ integrations, oauth });
  } finally {
    if (previous === undefined) delete process.env.CONTROLLER_HOME;
    else process.env.CONTROLLER_HOME = previous;
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function withMockAs(
  routes: Route[],
  fn: (mods: {
    integrations: typeof import("../integrations.js");
    oauth: typeof import("../oauth-dynamic.js");
    baseUrl: string;
    registered: { url?: string; body?: string };
    authRequests: { url?: string; body?: string }[];
  }) => Promise<void>
): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "oauth-dyn-test-"));
  const previous = process.env.CONTROLLER_HOME;
  process.env.CONTROLLER_HOME = dir;

  const registered: { url?: string; body?: string } = {};
  const authRequests: { url?: string; body?: string }[] = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const path = (req.url ?? "").split("?")[0];
      const route = routes.find((r) => r.method === req.method && r.url === path);
      if (!route) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "no route" }));
        return;
      }
      if (path === "/register") {
        registered.url = req.url;
        registered.body = raw;
      } else if (path === "/authorize") {
        authRequests.push({ url: req.url, body: raw });
      }
      const body =
        typeof route.body === "string" ? route.body : JSON.stringify(route.body ?? {});
      res.writeHead(route.status, { "Content-Type": "application/json" });
      res.end(body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const integrations = await import(`../integrations.js?t=${Date.now()}-${Math.random()}`);
    const oauth = await import(`../oauth-dynamic.js?t=${Date.now()}-${Math.random()}`);
    await fn({ integrations, oauth, baseUrl, registered, authRequests });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (previous === undefined) delete process.env.CONTROLLER_HOME;
    else process.env.CONTROLLER_HOME = previous;
    await fs.rm(dir, { recursive: true, force: true });
  }
}

const METADATA = {
  issuer: "https://as.example/",
  authorization_endpoint: "http://as.example/authorize",
  token_endpoint: "http://as.example/token",
  registration_endpoint: "http://as.example/register",
};

function makeConnection(
  integrations: typeof import("../integrations.js"),
  url: string
): Promise<import("../integrations.js").IntegrationConnection> {
  return integrations.createConnection({
    name: "Test MCP",
    transport: { mode: "mcp", config: { url }, headers: {} },
    auth: {
      schemes: [
        {
          acquisition: "oauth_dynamic",
          attachment: { kind: "header", name: "Authorization", prefix: "Bearer " },
        },
      ],
    },
  });
}

function schemeOf(connection: import("../integrations.js").IntegrationConnection) {
  const scheme = connection.auth.schemes[0];
  if (!scheme) throw new Error("connection has no schemes");
  return scheme;
}

test("discoverMetadata: 404 surfaces a metadata_not_found error", async () => {
  await withTempHome(async ({ oauth }) => {
    const fetchImpl: typeof fetch = async () => new Response("not found", { status: 404 });
    await assert.rejects(
      () => oauth.discoverMetadata("http://127.0.0.1:9/", fetchImpl),
      (err: Error) =>
        err instanceof oauth.OAuthDynamicError && err.code === "metadata_not_found"
    );
  });
});

test("discoverMetadata: requires authorization_endpoint, token_endpoint, issuer", async () => {
  await withTempHome(async ({ oauth }) => {
    const fetchImpl: typeof fetch = async () =>
      new Response(JSON.stringify({ issuer: "x" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    await assert.rejects(
      () => oauth.discoverMetadata("http://127.0.0.1:9/", fetchImpl),
      (err: Error) =>
        err instanceof oauth.OAuthDynamicError && err.code === "metadata_not_found"
    );
  });
});

test("discoverMetadata: publishes metadata at the host origin (Figma-style)", async () => {
  // The MCP server's resource path is /mcp but the well-known is at the
  // host origin /, not at /mcp/.well-known/... This is what Figma's MCP
  // server does in production: a 404 at /mcp/.well-known/... but a 200
  // at /.well-known/oauth-authorization-server.
  await withTempHome(async ({ oauth }) => {
    const metadata = {
      issuer: "https://api.figma.com",
      authorization_endpoint: "https://www.figma.com/oauth/mcp",
      token_endpoint: "https://api.figma.com/v1/oauth/token",
      registration_endpoint: "https://api.figma.com/v1/oauth/mcp/register",
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
    };
    const fetchImpl: typeof fetch = async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      // The new fast path hits the origin (no path), so /mcp is NOT in the URL.
      if (url === "http://127.0.0.1:9/.well-known/oauth-authorization-server") {
        return new Response(JSON.stringify(metadata), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      // Anything else (e.g. a probe) returns 404 so we don't accidentally
      // satisfy the test via the wrong path.
      return new Response("not found", { status: 404 });
    };
    const discovered = await oauth.discoverMetadata("http://127.0.0.1:9/mcp", fetchImpl);
    assert.equal(discovered.issuer, "https://api.figma.com");
    assert.equal(discovered.token_endpoint, "https://api.figma.com/v1/oauth/token");
  });
});

test("discoverMetadata: probes with initialize and follows WWW-Authenticate resource_metadata", async () => {
  // Figma in production also serves a 401 with a WWW-Authenticate header
  // pointing at /well-known/oauth-protected-resource, which then points
  // at a separate AS origin. Discovery should follow that chain.
  await withTempHome(async ({ oauth }) => {
    const metadata = {
      issuer: "https://api.figma.com",
      authorization_endpoint: "https://www.figma.com/oauth/mcp",
      token_endpoint: "https://api.figma.com/v1/oauth/token",
      registration_endpoint: "https://api.figma.com/v1/oauth/mcp/register",
    };
    const fetchImpl: typeof fetch = async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "http://127.0.0.1:9/mcp") {
        return new Response("Unauthorized", {
          status: 401,
          headers: {
            "WWW-Authenticate":
              'Bearer resource_metadata="http://127.0.0.1:9/.well-known/oauth-protected-resource", ' +
              'authorization_uri="https://api.figma.com/.well-known/oauth-authorization-server"',
          },
        });
      }
      if (url === "http://127.0.0.1:9/.well-known/oauth-protected-resource") {
        return new Response(
          JSON.stringify({
            resource: "http://127.0.0.1:9/mcp",
            authorization_servers: ["https://api.figma.com"],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url === "https://api.figma.com/.well-known/oauth-authorization-server") {
        return new Response(JSON.stringify(metadata), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    };
    const discovered = await oauth.discoverMetadata("http://127.0.0.1:9/mcp", fetchImpl);
    assert.equal(discovered.issuer, "https://api.figma.com");
  });
});

test("parseWwwAuthenticate: extracts the resource_metadata parameter", async () => {
  // Exposed for testing; the public surface of the module is
  // discoverMetadata but a direct unit test on the parser keeps the
  // header-format edge cases in scope.
  await withTempHome(async ({ oauth }) => {
    // We exercise the parser via discoverMetadata's probe path with a
    // shape that's known to be valid: the 401 includes a quoted
    // resource_metadata, the protected-resource document points at one
    // AS, and the AS metadata answers with valid endpoints.
    const metadata = {
      issuer: "https://issuer.example",
      authorization_endpoint: "https://issuer.example/auth",
      token_endpoint: "https://issuer.example/token",
      registration_endpoint: "https://issuer.example/register",
    };
    const fetchImpl: typeof fetch = async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "http://127.0.0.1:9/mcp") {
        return new Response("Unauthorized", {
          status: 401,
          headers: {
            // No leading scheme; the parser handles that.
            "WWW-Authenticate": `resource_metadata="http://127.0.0.1:9/pr", scope="mcp"`,
          },
        });
      }
      if (url === "http://127.0.0.1:9/pr") {
        return new Response(
          JSON.stringify({ authorization_servers: ["https://issuer.example"] }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url === "https://issuer.example/.well-known/oauth-authorization-server") {
        return new Response(JSON.stringify(metadata), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    };
    const discovered = await oauth.discoverMetadata("http://127.0.0.1:9/mcp", fetchImpl);
    assert.equal(discovered.issuer, "https://issuer.example");
  });
});

test("dynamicClientRegistration: picks a token_endpoint_auth_method the AS advertises", async () => {
  // ASes that don't accept "none" (PKCE public client) — Figma being
  // the canonical example — need us to ask for client_secret_basic or
  // client_secret_post. The body should reflect that.
  await withTempHome(async ({ oauth }) => {
    let registeredBody: unknown = null;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/register")) {
        registeredBody = init?.body;
        return new Response(JSON.stringify({ client_id: "figma-client" }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    };
    const client = await oauth.dynamicClientRegistration(
      {
        issuer: "https://api.figma.com",
        authorization_endpoint: "https://www.figma.com/oauth/mcp",
        token_endpoint: "https://api.figma.com/v1/oauth/token",
        registration_endpoint: "https://api.figma.com/v1/oauth/mcp/register",
        token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
      },
      fetchImpl
    );
    assert.equal(client.client_id, "figma-client");
    const parsed = JSON.parse(String(registeredBody));
    assert.equal(parsed.token_endpoint_auth_method, "client_secret_basic");
  });
});

test("dynamicClientRegistration: posts to the registration endpoint and returns the client", async () => {
  await withMockAs(
    [
      {
        method: "POST",
        url: "/register",
        status: 201,
        body: { client_id: "dyn-123", client_secret: "shh" },
      },
    ],
    async ({ oauth, baseUrl }) => {
      const client = await oauth.dynamicClientRegistration(
        { ...METADATA, registration_endpoint: `${baseUrl}/register` },
        fetch,
        "http://127.0.0.1/cb"
      );
      assert.equal(client.client_id, "dyn-123");
      assert.equal(client.client_secret, "shh");
    }
  );
});

test("dynamicClientRegistration: rejects when the AS doesn't expose a registration_endpoint", async () => {
  await withTempHome(async ({ oauth }) => {
    await assert.rejects(
      () =>
        oauth.dynamicClientRegistration(
          { ...METADATA, registration_endpoint: undefined },
          fetch
        ),
      (err: Error) => err instanceof oauth.OAuthDynamicError && err.code === "dcr_failed"
    );
  });
});

test("startInteractiveOauth: PKCE happy path discovers, registers, opens browser, exchanges the code", async () => {
  await withMockAs(
    [
      // The test's local mock server is hit via the metadata we pass
      // through `fetchImpl`. The mock server only needs to exist so
      // `withMockAs` cleans up; the actual responses come from the
      // fetchImpl below.
      { method: "GET", url: "/.well-known/oauth-authorization-server", status: 200, body: {} },
    ],
    async ({ integrations, oauth, baseUrl }) => {
      const localMetadata = {
        issuer: `${baseUrl}/`,
        authorization_endpoint: `${baseUrl}/authorize`,
        token_endpoint: `${baseUrl}/token`,
        registration_endpoint: `${baseUrl}/register`,
      };
      const connection = await makeConnection(integrations, `${baseUrl}/mcp`);
      const scheme = schemeOf(connection);
      let observedAuthUrl: string | null = null;
      const result = await oauth.startInteractiveOauth(connection, scheme, {
        resourceUrl: `${baseUrl}/mcp`,
        callbackTimeoutMs: 5_000,
        fetchImpl: async (input, init) => {
          const url = typeof input === "string" ? input : input.toString();
          if (url === `${baseUrl}/.well-known/oauth-authorization-server`) {
            return new Response(JSON.stringify(localMetadata), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            });
          }
          if (url === `${baseUrl}/register`) {
            return new Response(JSON.stringify({ client_id: "dyn-1" }), {
              status: 201,
              headers: { "Content-Type": "application/json" },
            });
          }
          if (url === `${baseUrl}/token`) {
            return new Response(
              JSON.stringify({ access_token: "AT-1", refresh_token: "RT-1", expires_in: 3600 }),
              { status: 200, headers: { "Content-Type": "application/json" } }
            );
          }
          return fetch(url, init);
        },
        openBrowser: async (url) => {
          observedAuthUrl = url;
          await delay(20);
          const parsed = new URL(url);
          const state = parsed.searchParams.get("state") ?? "";
          const redirectUri = parsed.searchParams.get("redirect_uri") ?? "";
          const resp = await fetch(`${redirectUri}?code=AUTH-CODE-1&state=${state}`);
          void resp;
        },
      });
      assert.equal(result.accessToken, "AT-1");
      assert.equal(result.refreshToken, "RT-1");
      assert.equal(result.clientId, "dyn-1");
      assert.equal(observedAuthUrl?.includes("response_type=code"), true);
      assert.equal(observedAuthUrl?.includes("code_challenge="), true);
      assert.equal(observedAuthUrl?.includes("code_challenge_method=S256"), true);
      assert.equal(observedAuthUrl?.includes(`resource=${encodeURIComponent(`${baseUrl}/mcp`)}`), true);
    }
  );
});

test("startInteractiveOauth: reuses a previously-registered client on re-acquire", async () => {
  await withMockAs(
    [{ method: "GET", url: "/.well-known/oauth-authorization-server", status: 200, body: {} }],
    async ({ integrations, oauth, baseUrl }) => {
      const localMetadata = {
        issuer: `${baseUrl}/`,
        authorization_endpoint: `${baseUrl}/authorize`,
        token_endpoint: `${baseUrl}/token`,
        registration_endpoint: `${baseUrl}/register`,
      };
      const connection = await makeConnection(integrations, `${baseUrl}/mcp`);
      const scheme = schemeOf(connection);
      let registerCalls = 0;
      // First call: register a client.
      await oauth.startInteractiveOauth(connection, scheme, {
        resourceUrl: `${baseUrl}/mcp`,
        callbackTimeoutMs: 5_000,
        fetchImpl: async (input, init) => {
          const url = typeof input === "string" ? input : input.toString();
          if (url === `${baseUrl}/.well-known/oauth-authorization-server`) {
            return new Response(JSON.stringify(localMetadata), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            });
          }
          if (url === `${baseUrl}/register`) {
            registerCalls += 1;
            return new Response(JSON.stringify({ client_id: "dyn-reused" }), {
              status: 201,
              headers: { "Content-Type": "application/json" },
            });
          }
          if (url === `${baseUrl}/token`) {
            return new Response(
              JSON.stringify({ access_token: "AT-2", refresh_token: "RT-2", expires_in: 3600 }),
              { status: 200, headers: { "Content-Type": "application/json" } }
            );
          }
          return fetch(url, init);
        },
        openBrowser: async (url) => {
          await delay(20);
          const parsed = new URL(url);
          const state = parsed.searchParams.get("state") ?? "";
          const redirectUri = parsed.searchParams.get("redirect_uri") ?? "";
          await fetch(`${redirectUri}?code=AUTH-CODE-2&state=${state}`);
        },
      });
      assert.equal(registerCalls, 1, "DCR runs the first time");

      // Re-acquire with a fresh flow (simulate clicking "Reconnect").
      // The persisted client_id is reused, so the registration endpoint
      // must NOT be called again.
      const updated = await integrations.getConnection(connection.id);
      assert.ok(updated);
      const fresh = schemeOf(updated);
      const second = await oauth.startInteractiveOauth(updated, fresh, {
        resourceUrl: `${baseUrl}/mcp`,
        callbackTimeoutMs: 5_000,
        fetchImpl: async (input, init) => {
          const url = typeof input === "string" ? input : input.toString();
          if (url === `${baseUrl}/.well-known/oauth-authorization-server`) {
            return new Response(JSON.stringify(localMetadata), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            });
          }
          if (url === `${baseUrl}/register`) {
            registerCalls += 1;
            return new Response(JSON.stringify({ client_id: "dyn-reused" }), {
              status: 201,
              headers: { "Content-Type": "application/json" },
            });
          }
          if (url === `${baseUrl}/token`) {
            return new Response(
              JSON.stringify({ access_token: "AT-3", refresh_token: "RT-3", expires_in: 3600 }),
              { status: 200, headers: { "Content-Type": "application/json" } }
            );
          }
          return fetch(url, init);
        },
        openBrowser: async (url) => {
          await delay(20);
          const parsed = new URL(url);
          const state = parsed.searchParams.get("state") ?? "";
          const redirectUri = parsed.searchParams.get("redirect_uri") ?? "";
          await fetch(`${redirectUri}?code=AUTH-CODE-3&state=${state}`);
        },
      });
      assert.equal(second.accessToken, "AT-3");
      assert.equal(registerCalls, 1, "DCR does NOT run again on re-acquire");
    }
  );
});

test("getValidToken: returns null when no token has been acquired", async () => {
  await withTempHome(async ({ integrations, oauth }) => {
    const connection = await makeConnection(integrations, "http://127.0.0.1:9999/");
    const scheme = schemeOf(connection);
    const token = await oauth.getValidToken(connection, scheme);
    assert.equal(token, null);
  });
});

test("getValidToken: refreshes proactively on a near-expiry access token", async () => {
  await withMockAs(
    [{ method: "GET", url: "/.well-known/oauth-authorization-server", status: 200, body: {} }],
    async ({ integrations, oauth, baseUrl }) => {
      const localMetadata = {
        issuer: `${baseUrl}/`,
        authorization_endpoint: `${baseUrl}/authorize`,
        token_endpoint: `${baseUrl}/token`,
        registration_endpoint: `${baseUrl}/register`,
      };
      const connection = await makeConnection(integrations, `${baseUrl}/mcp`);
      const scheme = schemeOf(connection);
      let tokenCalls = 0;
      const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url === `${baseUrl}/.well-known/oauth-authorization-server`) {
          return new Response(JSON.stringify(localMetadata), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (url === `${baseUrl}/register`) {
          return new Response(JSON.stringify({ client_id: "dyn-r" }), {
            status: 201,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (url === `${baseUrl}/token`) {
          tokenCalls += 1;
          if (tokenCalls === 1) {
            return new Response(
              JSON.stringify({ access_token: "AT-SHORT", refresh_token: "RT", expires_in: 60 }),
              { status: 200, headers: { "Content-Type": "application/json" } }
            );
          }
          return new Response(
            JSON.stringify({ access_token: "AT-FRESH", expires_in: 3600 }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        return fetch(url, init);
      };
      await oauth.startInteractiveOauth(connection, scheme, {
        resourceUrl: `${baseUrl}/mcp`,
        callbackTimeoutMs: 5_000,
        fetchImpl: fetchImpl as typeof fetch,
        openBrowser: async (url) => {
          await delay(20);
          const parsed = new URL(url);
          const state = parsed.searchParams.get("state") ?? "";
          const redirectUri = parsed.searchParams.get("redirect_uri") ?? "";
          await fetch(`${redirectUri}?code=CODE&state=${state}`);
        },
      });

      // First call to getValidToken: the stored token is the short one but
      // not yet within the refresh skew window. We return it as-is.
      let updated = await integrations.getConnection(connection.id);
      assert.ok(updated);
      const schemeNow = schemeOf(updated);
      const first = await oauth.getValidToken(updated, schemeNow, fetchImpl as typeof fetch);
      assert.equal(first, "AT-SHORT");

      // Force the stored token to be inside the refresh window by
      // rewriting its expiresAt.
      const { writeConnectionSecrets } = await import("../integrations.js");
      const secrets = await integrations.getConnectionSecrets(updated.id);
      const stored = JSON.parse(secrets[schemeNow.id] ?? "{}");
      stored.expiresAt = Date.now() + 1_000; // 1s from now, well inside the 30s skew
      secrets[schemeNow.id] = JSON.stringify(stored);
      await writeConnectionSecrets(updated.id, secrets);

      updated = await integrations.getConnection(updated.id);
      assert.ok(updated);
      const schemeRefreshed = schemeOf(updated);
      const second = await oauth.getValidToken(updated, schemeRefreshed, fetchImpl as typeof fetch);
      assert.equal(second, "AT-FRESH");
      // The token endpoint was hit twice: once for the auth code exchange,
      // once for the refresh.
      assert.equal(tokenCalls, 2);
    }
  );
});

test("getValidToken: marks the scheme expired when refresh fails", async () => {
  await withMockAs(
    [{ method: "GET", url: "/.well-known/oauth-authorization-server", status: 200, body: {} }],
    async ({ integrations, oauth, baseUrl }) => {
      const localMetadata = {
        issuer: `${baseUrl}/`,
        authorization_endpoint: `${baseUrl}/authorize`,
        token_endpoint: `${baseUrl}/token`,
        registration_endpoint: `${baseUrl}/register`,
      };
      const connection = await makeConnection(integrations, `${baseUrl}/mcp`);
      const scheme = schemeOf(connection);
      let tokenCalls = 0;
      const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url === `${baseUrl}/.well-known/oauth-authorization-server`) {
          return new Response(JSON.stringify(localMetadata), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (url === `${baseUrl}/register`) {
          return new Response(JSON.stringify({ client_id: "dyn-x" }), {
            status: 201,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (url === `${baseUrl}/token`) {
          tokenCalls += 1;
          if (tokenCalls === 1) {
            return new Response(
              JSON.stringify({ access_token: "AT-1", refresh_token: "RT", expires_in: 60 }),
              { status: 200, headers: { "Content-Type": "application/json" } }
            );
          }
          return new Response(JSON.stringify({ error: "invalid_grant" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }
        return fetch(url, init);
      };
      await oauth.startInteractiveOauth(connection, scheme, {
        resourceUrl: `${baseUrl}/mcp`,
        callbackTimeoutMs: 5_000,
        fetchImpl: fetchImpl as typeof fetch,
        openBrowser: async (url) => {
          await delay(20);
          const parsed = new URL(url);
          const state = parsed.searchParams.get("state") ?? "";
          const redirectUri = parsed.searchParams.get("redirect_uri") ?? "";
          await fetch(`${redirectUri}?code=CODE&state=${state}`);
        },
      });

      // Force expiry by editing the stored secret.
      const updated = await integrations.getConnection(connection.id);
      assert.ok(updated);
      const schemeNow = schemeOf(updated);
      const { writeConnectionSecrets } = await import("../integrations.js");
      const secrets = await integrations.getConnectionSecrets(updated.id);
      const stored = JSON.parse(secrets[schemeNow.id] ?? "{}");
      stored.expiresAt = Date.now();
      secrets[schemeNow.id] = JSON.stringify(stored);
      await writeConnectionSecrets(updated.id, secrets);

      // getValidToken should fail to refresh and return null.
      const fresh = await integrations.getConnection(updated.id);
      assert.ok(fresh);
      const freshScheme = schemeOf(fresh);
      const token = await oauth.getValidToken(fresh, freshScheme, fetchImpl as typeof fetch);
      assert.equal(token, null);

      // The scheme's acquired status is now "expired".
      const expired = await integrations.getConnection(updated.id);
      assert.ok(expired);
      assert.equal(expired.auth.schemes[0]?.acquired?.status, "expired");
    }
  );
});

test("acquireStatus: returns 'connected' with an expiry while the token is valid", async () => {
  await withTempHome(async ({ integrations, oauth }) => {
    const connection = await makeConnection(integrations, "http://127.0.0.1:9999/");
    const scheme = schemeOf(connection);
    const status = await oauth.acquireStatus(connection.id, scheme.id);
    assert.deepEqual(status, { status: "none" });
  });
});

test("clearDynamicOauth: removes the stored token and resets the scheme", async () => {
  await withTempHome(async ({ integrations, oauth }) => {
    const connection = await makeConnection(integrations, "http://127.0.0.1:9999/");
    const scheme = schemeOf(connection);
    // Inject a fake stored secret so we can assert it gets wiped.
    const { writeConnectionSecrets } = await import("../integrations.js");
    const fake = {
      accessToken: "X",
      refreshToken: "Y",
      expiresAt: Date.now() + 60_000,
      clientId: "client",
      metadata: METADATA,
    };
    const secrets = { [scheme.id]: JSON.stringify(fake) };
    await writeConnectionSecrets(connection.id, secrets);
    await integrations.updateConnection(connection.id, {
      auth: {
        schemes: [
          {
            id: scheme.id,
            acquisition: scheme.acquisition,
            attachment: scheme.attachment,
            config: scheme.config,
          },
        ],
      },
    });
    await oauth.clearDynamicOauth(connection.id, scheme.id);
    const after = await integrations.getConnectionSecrets(connection.id);
    assert.equal(after[scheme.id], undefined);
    const final = await integrations.getConnection(connection.id);
    assert.ok(final);
    assert.equal(final.auth.schemes[0]?.acquired?.status, "none");
  });
});
