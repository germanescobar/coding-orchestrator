/*
 * OAuth 2.0 dynamic / MCP credential acquisition (issue #280).
 *
 * The MCP authorization spec (https://modelcontextprotocol.io/specification/2025-06-18/authorization)
 * says: a remote MCP server can advertise its authorization server via
 * `/.well-known/oauth-authorization-server` (RFC 8414) and require dynamic
 * client registration (RFC 7591). The user has no client id/secret to paste —
 * Controller discovers both endpoints, registers a client, then runs the
 * authorization-code flow with PKCE against a loopback callback to capture
 * the redirect.
 *
 * This module is the missing outbound-execution half of the integrations
 * design: `getValidToken(connection, scheme)` returns a fresh access token
 * (refreshing when needed); the existing `resolveConnectionAuth` calls into
 * it and attaches the bearer just like client-credentials does. The
 * interactive start (`startInteractiveOauth`) and the status fetch
 * (`acquireStatus`) are exposed over HTTP for the form.
 *
 * The loopback listener runs on `127.0.0.1` and is bound for the lifetime of
 * one acquisition only. The client registration's `redirect_uris` is
 * parameterized so the test suite can drive the flow without depending on
 * port allocation race conditions.
 */

import http from "node:http";
import { AddressInfo } from "node:net";
import { createHash, randomBytes } from "node:crypto";
import type { AcquiredState, AuthScheme, IntegrationConnection } from "./integrations.js";
import {
  getConnection,
  getConnectionSecrets,
  updateSchemeAcquired,
  writeConnectionSecrets,
} from "./integrations.js";
import { fetchWithTimeout } from "./http-fetch.js";

const LOOPBACK_HOST = "127.0.0.1";
const REQUEST_TIMEOUT_MS = 15_000;
const EXPIRY_SKEW_MS = 30_000;

/*
 * The token cache is keyed by connection + scheme id so a single connection's
 * multiple schemes (rare) and a single scheme across connections stay
 * separate. The token lives both here (for fast same-process reuse) and in the
 * encrypted secret store (so a process restart doesn't force the user to
 * re-authorize).
 */
interface CachedToken {
  accessToken: string;
  refreshToken?: string;
  /** Epoch ms after which the token should be refreshed. */
  expiresAt: number;
}

const cache = new Map<string, CachedToken>();

/** Persisted shape of an `oauth_dynamic` scheme's secret value. */
export interface OAuthDynamicSecret {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  /**
   * Persisted dynamic client registration so we can refresh / re-authorize
   * without re-registering (some ASes require a consistent client_id).
   */
  clientId: string;
  clientSecret?: string;
  /** Authorization server metadata snapshot at registration time. */
  metadata: OAuthMetadata;
  scopes?: string;
  resource?: string;
}

/** RFC 8414 authorization-server metadata (only fields we use). */
export interface OAuthMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  scopes_supported?: string[];
  code_challenge_methods_supported?: string[];
  grant_types_supported?: string[];
}

export class OAuthDynamicError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "metadata_not_found"
      | "dcr_failed"
      | "token_exchange_failed"
      | "refresh_failed"
      | "user_cancelled"
      | "invalid_state"
      | "callback_timeout"
      | "as_error"
  ) {
    super(message);
    this.name = "OAuthDynamicError";
  }
}

// --- Public API ---

/**
 * Return a valid access token for an `oauth_dynamic` scheme, refreshing it
 * when the cached one is missing or close to expiring. The refreshed token is
 * persisted to the encrypted secret store so a process restart can resume.
 *
 * Returns null when the scheme has no acquired secret yet (the user hasn't
 * authorized). The caller should then surface the "needs to be connected"
 * re-auth signal.
 */
export async function getValidToken(
  connection: IntegrationConnection,
  scheme: AuthScheme,
  fetchImpl: typeof fetch = fetch
): Promise<string | null> {
  if (scheme.acquisition !== "oauth_dynamic") {
    throw new Error("getValidToken only applies to oauth_dynamic schemes");
  }
  const key = `${connection.id}:${scheme.id}`;
  const stored = await loadSecret(connection.id, scheme.id);
  if (!stored) return null;

  const cached = cache.get(key);
  if (
    cached &&
    cached.accessToken === stored.accessToken &&
    cached.expiresAt === stored.expiresAt &&
    cached.expiresAt > Date.now()
  ) {
    return cached.accessToken;
  }

  // Stale or empty cache — see if we can refresh without user interaction.
  const aboutToExpire = stored.expiresAt - Date.now() < EXPIRY_SKEW_MS;
  if (aboutToExpire && stored.refreshToken) {
    try {
      const refreshed = await refreshAccessToken(stored, fetchImpl);
      cache.set(key, toCached(refreshed));
      await saveSecret(connection.id, scheme.id, refreshed);
      await markAcquired(connection.id, scheme, {
        status: "connected",
        expiresAt: new Date(refreshed.expiresAt).toISOString(),
      });
      return refreshed.accessToken;
    } catch {
      // Refresh failed: mark the scheme expired so the UI offers Reconnect.
      await markAcquired(connection.id, scheme, { status: "expired" });
      return null;
    }
  }

  // Token still valid; warm the cache.
  const token: CachedToken = toCached(stored);
  cache.set(key, token);
  return token.accessToken;
}

/** Status of an `oauth_dynamic` scheme for the UI. */
export interface AcquireStatus {
  status: "none" | "connected" | "expired";
  expiresAt?: string;
}

/** Read-only view of an `oauth_dynamic` scheme's state, for the form to render. */
export async function acquireStatus(
  connectionId: string,
  schemeId: string
): Promise<AcquireStatus | null> {
  const connection = await getConnection(connectionId);
  if (!connection) return null;
  const scheme = connection.auth.schemes.find((s) => s.id === schemeId);
  if (!scheme) return null;
  if (scheme.acquisition !== "oauth_dynamic") return null;

  const stored = await loadSecret(connectionId, schemeId);
  if (!stored) return { status: "none" };
  if (stored.expiresAt - Date.now() < EXPIRY_SKEW_MS) {
    return {
      status: "expired",
      expiresAt: new Date(stored.expiresAt).toISOString(),
    };
  }
  return {
    status: "connected",
    expiresAt: new Date(stored.expiresAt).toISOString(),
  };
}

/** Options for `startInteractiveOauth`. The defaults match the MCP spec. */
export interface InteractiveOauthOptions {
  /** Override the server URL the metadata is discovered from. */
  resourceUrl?: string;
  /** Override the scopes the user is asked to grant. */
  scopes?: string;
  /**
   * Override the loopback URL the authorization code is delivered to. Mostly
   * for tests; production should let the function pick an ephemeral port.
   */
  redirectUri?: string;
  /**
   * Hook for the UI to open the authorization URL in the user's default
   * browser. Defaults to logging the URL — production injects an Electron
   * `shell.openExternal` call via `setBrowserOpener`.
   */
  openBrowser?: (authorizationUrl: string) => Promise<void> | void;
  /** Reject after this many ms with a callback_timeout error. */
  callbackTimeoutMs?: number;
  /**
   * Override the HTTP fetch implementation. Tests inject a `fetch` whose
   * `Response` is the real one but with deterministic request bodies.
   */
  fetchImpl?: typeof fetch;
}

let defaultBrowserOpener: (url: string) => Promise<void> | void = (url) => {
  // The opener is replaced by `installDefaultBrowserOpener` at server
  // startup. In dev / tests that step is skipped, so we log instead —
  // either an Electron or dev-mode human can wire the real opener.
  console.warn(`[oauth-dynamic] open browser: ${url}`);
};

/**
 * Install the production browser opener. Called once at server startup
 * (from `index.ts` when the server runs inside the Electron main process,
 * which is the only environment that has `shell.openExternal` available).
 * Outside Electron we leave the no-op default in place.
 */
export async function installDefaultBrowserOpener(): Promise<void> {
  try {
    const electron = (await import("electron")) as unknown as {
      shell?: { openExternal: (url: string) => Promise<void> };
    };
    if (electron.shell?.openExternal) {
      defaultBrowserOpener = (url) => electron.shell!.openExternal(url);
    }
  } catch {
    // Running outside Electron (e.g. a dev `tsx` process) — leave the
    // warning-log default in place so the flow is still observable.
  }
}

/** Replace the default browser opener (mostly for tests). */
export function setBrowserOpener(opener: (url: string) => Promise<void> | void): void {
  defaultBrowserOpener = opener;
}

/**
 * Run the full interactive OAuth flow for an `oauth_dynamic` scheme. The
 * scheme's secret is replaced with the resulting token set and its
 * `acquired.status` is set to "connected".
 */
export async function startInteractiveOauth(
  connection: IntegrationConnection,
  scheme: AuthScheme,
  options: InteractiveOauthOptions = {}
): Promise<OAuthDynamicSecret> {
  if (scheme.acquisition !== "oauth_dynamic") {
    throw new Error("startInteractiveOauth only applies to oauth_dynamic schemes");
  }
  const resourceUrl = options.resourceUrl ?? connection.transport.config.url?.trim();
  if (!resourceUrl) {
    throw new OAuthDynamicError(
      "This connection has no URL configured. Set the MCP server URL first.",
      "metadata_not_found"
    );
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const opener = options.openBrowser ?? defaultBrowserOpener;
  const callbackTimeoutMs = options.callbackTimeoutMs ?? 5 * 60_000;

  const metadata = await discoverMetadata(resourceUrl, fetchImpl);

  // Reuse a previously-registered client when one is still on file so the
  // user isn't re-prompted for the same app on every reconnect.
  const priorSecret = await loadSecret(connection.id, scheme.id);
  const client = priorSecret
    ? { client_id: priorSecret.clientId, client_secret: priorSecret.clientSecret }
    : await dynamicClientRegistration(metadata, fetchImpl, options.redirectUri);

  const scopes = options.scopes ?? scheme.config.scopes?.trim() ?? priorSecret?.scopes ?? "";
  const redirectUri = options.redirectUri ?? (await startLoopbackListener(callbackTimeoutMs));
  const { code, verifier } = await runAuthorizationCodeFlow({
    metadata,
    client,
    redirectUri,
    resourceUrl,
    scopes,
    opener,
    fetchImpl,
  });

  let tokenResult: OAuthDynamicSecret;
  try {
    tokenResult = await exchangeCodeForToken({
      metadata,
      client,
      code,
      verifier,
      redirectUri,
      resourceUrl,
      scopes,
      fetchImpl,
    });
  } finally {
    // Stop the loopback listener — it's done its job whether the exchange
    // succeeded or failed.
    await stopLoopbackListener();
  }

  tokenResult.metadata = metadata;
  tokenResult.scopes = scopes;
  tokenResult.resource = resourceUrl;

  await saveSecret(connection.id, scheme.id, tokenResult);
  const key = `${connection.id}:${scheme.id}`;
  cache.set(key, toCached(tokenResult));
  await markAcquired(connection.id, scheme, {
    status: "connected",
    expiresAt: new Date(tokenResult.expiresAt).toISOString(),
  });
  return tokenResult;
}

/** Clear an `oauth_dynamic` scheme's stored token + state. */
export async function clearDynamicOauth(connectionId: string, schemeId: string): Promise<void> {
  const secrets = await getConnectionSecrets(connectionId);
  delete secrets[schemeId];
  await writeConnectionSecrets(connectionId, secrets);
  for (const key of Array.from(cache.keys())) {
    if (key === `${connectionId}:${schemeId}`) cache.delete(key);
  }
  const connection = await getConnection(connectionId);
  const scheme = connection?.auth.schemes.find((s) => s.id === schemeId);
  if (connection && scheme) await markAcquired(connectionId, scheme, { status: "none" });
}

// --- Metadata + DCR ---

/**
 * Discover the authorization server's metadata. The MCP spec points at
 * `/.well-known/oauth-authorization-server` (RFC 8414), but the discovery
 * URL has to be derived from the MCP server's URL. Per the spec we use the
 * URL *as if it were an issuer*; if the metadata document isn't there we
 * surface a clear error so the form can show it.
 */
export async function discoverMetadata(
  resourceUrl: string,
  fetchImpl: typeof fetch = fetch
): Promise<OAuthMetadata> {
  const discoveryUrl = buildDiscoveryUrl(resourceUrl);
  const res = await fetchWithTimeout(fetchImpl, discoveryUrl, { method: "GET" }, REQUEST_TIMEOUT_MS);
  if (res.status === 404) {
    throw new OAuthDynamicError(
      `MCP server ${resourceUrl} does not advertise an OAuth authorization server. ` +
        "It may not require OAuth, or may need a different URL.",
      "metadata_not_found"
    );
  }
  if (!res.ok) {
    throw new OAuthDynamicError(
      `OAuth metadata discovery failed (HTTP ${res.status}).`,
      "metadata_not_found"
    );
  }
  const json = (await res.json()) as Partial<OAuthMetadata>;
  if (!json.authorization_endpoint || !json.token_endpoint || !json.issuer) {
    throw new OAuthDynamicError(
      "Authorization server metadata is missing required endpoints.",
      "metadata_not_found"
    );
  }
  return json as OAuthMetadata;
}

/**
 * Build the well-known URL the spec mandates: append
 * `/.well-known/oauth-authorization-server` to the MCP server's origin.
 * Trailing slashes are normalized.
 */
function buildDiscoveryUrl(resourceUrl: string): string {
  const url = new URL(resourceUrl);
  url.pathname = `${url.pathname.replace(/\/$/, "")}/.well-known/oauth-authorization-server`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

/**
 * RFC 7591 dynamic client registration. The MCP spec REQUIRES DCR for
 * servers that don't issue static client ids; the resulting client is then
 * used for the authorization-code flow.
 */
export async function dynamicClientRegistration(
  metadata: OAuthMetadata,
  fetchImpl: typeof fetch = fetch,
  redirectUri?: string
): Promise<DCRClient> {
  const endpoint = metadata.registration_endpoint;
  if (!endpoint) {
    throw new OAuthDynamicError(
      "Authorization server does not support dynamic client registration.",
      "dcr_failed"
    );
  }
  const body = {
    client_name: "Controller",
    redirect_uris: redirectUri ? [redirectUri] : ["http://127.0.0.1/callback"],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none", // PKCE public client
  };
  const res = await fetchWithTimeout(
    fetchImpl,
    endpoint,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
    },
    REQUEST_TIMEOUT_MS
  );
  if (!res.ok) {
    throw new OAuthDynamicError(
      `Dynamic client registration failed (HTTP ${res.status}).`,
      "dcr_failed"
    );
  }
  const json = (await res.json()) as DCRClient;
  if (!json.client_id) {
    throw new OAuthDynamicError("Dynamic client registration returned no client_id.", "dcr_failed");
  }
  return json;
}

export interface DCRClient {
  client_id: string;
  client_secret?: string;
  /** How long the registration stays valid (RFC 7591 §3.2.1). */
  client_id_expires_at?: number;
  redirect_uris?: string[];
}

// --- Authorization-code + PKCE ---

/*
 * The loopback listener: a tiny HTTP server that handles a single redirect
 * carrying the authorization code. It lives only for the duration of one
 * acquisition; the caller passes the listener's redirect_uri to the
 * authorization request and we tear it down in `stopLoopbackListener`.
 */
let loopbackServer: http.Server | null = null;
let loopbackTimer: NodeJS.Timeout | null = null;

interface CallbackPayload {
  code: string;
  state: string;
  error?: string;
  errorDescription?: string;
}

interface AuthorizationCodeFlowInput {
  metadata: OAuthMetadata;
  client: DCRClient;
  redirectUri: string;
  resourceUrl: string;
  scopes: string;
  opener: (url: string) => Promise<void> | void;
  fetchImpl: typeof fetch;
}

async function runAuthorizationCodeFlow(input: AuthorizationCodeFlowInput): Promise<{
  code: string;
  state: string;
  verifier: string;
}> {
  const { metadata, client, redirectUri, resourceUrl, scopes, opener } = input;
  const state = randomBytes(16).toString("base64url");
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");

  const authorizeUrl = new URL(metadata.authorization_endpoint);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("client_id", client.client_id);
  authorizeUrl.searchParams.set("redirect_uri", redirectUri);
  authorizeUrl.searchParams.set("state", state);
  authorizeUrl.searchParams.set("code_challenge", challenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");
  if (scopes) authorizeUrl.searchParams.set("scope", scopes);
  // RFC 8707: bind the token to the MCP server's URL.
  authorizeUrl.searchParams.set("resource", resourceUrl);

  // Set up the callback waiter *before* opening the browser, so we can't
  // miss the redirect when the AS bounces the user back quickly.
  const payloadPromise = new Promise<CallbackPayload>((resolve, reject) => {
    pendingCallback = { resolve, reject };
  });

  await opener(authorizeUrl.toString());
  const payload = await payloadPromise;
  pendingCallback = null;

  if (payload.error) {
    throw new OAuthDynamicError(
      `Authorization server error: ${payload.error}${payload.errorDescription ? ` — ${payload.errorDescription}` : ""}`,
      "as_error"
    );
  }
  if (payload.state !== state) {
    throw new OAuthDynamicError("Authorization callback state did not match.", "invalid_state");
  }
  if (!payload.code) {
    throw new OAuthDynamicError("Authorization callback did not include a code.", "as_error");
  }
  return { code: payload.code, state: payload.state, verifier };
}

let pendingCallback: {
  resolve: (v: CallbackPayload) => void;
  reject: (e: Error) => void;
} | null = null;

async function startLoopbackListener(timeoutMs: number): Promise<string> {
  if (loopbackServer) await stopLoopbackListener();
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${LOOPBACK_HOST}`);
    if (url.pathname !== "/callback") {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found");
      return;
    }
    const code = url.searchParams.get("code") ?? "";
    const state = url.searchParams.get("state") ?? "";
    const error = url.searchParams.get("error") ?? undefined;
    const errorDescription = url.searchParams.get("error_description") ?? undefined;
    if (pendingCallback) {
      const { resolve } = pendingCallback;
      resolve({ code, state, error, errorDescription });
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(
      "<!doctype html><meta charset=utf-8><title>Controller</title>" +
        "<p style=\"font-family:sans-serif\">You can close this tab and return to Controller.</p>"
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, LOOPBACK_HOST, () => resolve());
  });
  loopbackServer = server;
  const port = (server.address() as AddressInfo).port;
  if (loopbackTimer) clearTimeout(loopbackTimer);
  loopbackTimer = setTimeout(() => {
    if (pendingCallback) {
      const { reject } = pendingCallback;
      pendingCallback = null;
      reject(new OAuthDynamicError("Authorization callback timed out.", "callback_timeout"));
    }
  }, timeoutMs);
  return `http://${LOOPBACK_HOST}:${port}/callback`;
}

async function stopLoopbackListener(): Promise<void> {
  if (loopbackTimer) {
    clearTimeout(loopbackTimer);
    loopbackTimer = null;
  }
  if (pendingCallback) {
    // We tore down before the callback landed — surface a clear failure so
    // the in-flight `runAuthorizationCodeFlow` doesn't hang.
    const { reject } = pendingCallback;
    pendingCallback = null;
    reject(new OAuthDynamicError("Authorization listener stopped before callback.", "as_error"));
  }
  if (!loopbackServer) return;
  const server = loopbackServer;
  loopbackServer = null;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

interface ExchangeInput {
  metadata: OAuthMetadata;
  client: DCRClient;
  code: string;
  verifier: string;
  redirectUri: string;
  resourceUrl: string;
  scopes: string;
  fetchImpl: typeof fetch;
}

async function exchangeCodeForToken(input: ExchangeInput): Promise<OAuthDynamicSecret> {
  const { metadata, client, code, verifier, redirectUri, resourceUrl, scopes, fetchImpl } = input;
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: client.client_id,
    code_verifier: verifier,
    redirect_uri: redirectUri,
  });
  if (client.client_secret) body.set("client_secret", client.client_secret);
  if (scopes) body.set("scope", scopes);
  body.set("resource", resourceUrl);

  const res = await fetchWithTimeout(
    fetchImpl,
    metadata.token_endpoint,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body,
    },
    REQUEST_TIMEOUT_MS
  );
  const json = (await parseTokenResponse(res)) as Record<string, unknown>;
  return tokenResponseToSecret(json, client, metadata);
}

async function refreshAccessToken(stored: OAuthDynamicSecret, fetchImpl: typeof fetch = fetch): Promise<OAuthDynamicSecret> {
  if (!stored.refreshToken) {
    throw new OAuthDynamicError("No refresh token available.", "refresh_failed");
  }
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: stored.refreshToken,
    client_id: stored.clientId,
  });
  if (stored.clientSecret) body.set("client_secret", stored.clientSecret);
  if (stored.scopes) body.set("scope", stored.scopes);
  if (stored.resource) body.set("resource", stored.resource);

  const res = await fetchWithTimeout(
    fetchImpl,
    stored.metadata.token_endpoint,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body,
    },
    REQUEST_TIMEOUT_MS
  );
  if (!res.ok) {
    throw new OAuthDynamicError(`Token refresh failed (HTTP ${res.status}).`, "refresh_failed");
  }
  const json = (await parseTokenResponse(res)) as Record<string, unknown>;
  // Refresh responses don't always include a new refresh_token; keep the
  // existing one when the AS omits it.
  if (!json.refresh_token && stored.refreshToken) json.refresh_token = stored.refreshToken;
  return tokenResponseToSecret(json, { client_id: stored.clientId }, stored.metadata);
}

async function parseTokenResponse(res: Response): Promise<unknown> {
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    if (!res.ok) {
      throw new OAuthDynamicError(
        `Token endpoint returned HTTP ${res.status}.`,
        "token_exchange_failed"
      );
    }
    throw new OAuthDynamicError("Token endpoint returned a non-JSON response.", "as_error");
  }
  if (!res.ok) {
    const message =
      typeof body === "object" && body && (body as { error_description?: string }).error_description
        ? (body as { error_description?: string }).error_description
        : typeof body === "object" && body && (body as { error?: string }).error
          ? (body as { error?: string }).error
          : `HTTP ${res.status}`;
    throw new OAuthDynamicError(`Token endpoint error: ${message}`, "token_exchange_failed");
  }
  return body;
}

function tokenResponseToSecret(
  json: Record<string, unknown>,
  client: { client_id: string; client_secret?: string },
  metadata: OAuthMetadata
): OAuthDynamicSecret {
  const accessToken = json.access_token;
  if (typeof accessToken !== "string" || !accessToken) {
    throw new OAuthDynamicError("Token response did not include an access_token.", "as_error");
  }
  const refreshToken = typeof json.refresh_token === "string" ? json.refresh_token : undefined;
  const expiresIn = typeof json.expires_in === "number" ? json.expires_in : 3600;
  return {
    accessToken,
    refreshToken,
    expiresAt: Date.now() + expiresIn * 1000 - EXPIRY_SKEW_MS,
    clientId: client.client_id,
    clientSecret: client.client_secret,
    metadata,
  };
}

// --- Persistence helpers ---

async function loadSecret(connectionId: string, schemeId: string): Promise<OAuthDynamicSecret | null> {
  const secrets = await getConnectionSecrets(connectionId);
  const raw = secrets[schemeId];
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as OAuthDynamicSecret;
    if (!parsed.accessToken || !parsed.metadata) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function saveSecret(
  connectionId: string,
  schemeId: string,
  value: OAuthDynamicSecret
): Promise<void> {
  const secrets = await getConnectionSecrets(connectionId);
  secrets[schemeId] = JSON.stringify(value);
  await writeConnectionSecrets(connectionId, secrets);
}

function toCached(secret: OAuthDynamicSecret): CachedToken {
  return {
    accessToken: secret.accessToken,
    refreshToken: secret.refreshToken,
    expiresAt: secret.expiresAt,
  };
}

async function markAcquired(
  connectionId: string,
  scheme: AuthScheme,
  acquired: AcquiredState
): Promise<void> {
  await updateSchemeAcquired(connectionId, scheme.id, acquired);
}
