import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentRow, ApiKeysSection } from "../agents-section.tsx";
import type { AgentStatus, ProviderStatus } from "../../api.ts";

const NOOP = () => {};
const NOOP_ASYNC = async () => {};

const CLAUDE_AGENT: AgentStatus = {
  id: "claude",
  name: "Claude",
  command: "claude",
  installed: true,
  enabled: true,
  resolvedPath: "/usr/local/bin/claude",
  version: "1.2.3",
  defaultModel: null,
  autoApprove: false,
};

function renderAgentRow(
  agent: AgentStatus,
  options: { settingsOpen?: boolean; pathEditing?: boolean } = {},
): string {
  return renderToStaticMarkup(
    <AgentRow
      agent={agent}
      onToggle={NOOP}
      onSavePath={NOOP_ASYNC}
      onSaveDefaultModel={NOOP_ASYNC}
      onToggleAutoApprove={NOOP}
      initialSettingsOpen={options.settingsOpen}
      initialPathEditing={options.pathEditing}
    >
      <div>API Keys</div>
    </AgentRow>,
  );
}

test("AgentRow is collapsed to name, command/version badge, settings, and switch by default", () => {
  const html = renderAgentRow(CLAUDE_AGENT);

  assert.match(html, /Claude/);
  assert.match(html, /claude 1\.2\.3/);
  assert.match(html, /Open settings/);
  assert.doesNotMatch(html, /\/usr\/local\/bin\/claude/);
  assert.doesNotMatch(html, /Default model/);
  assert.doesNotMatch(html, /Auto-approve/);
  assert.doesNotMatch(html, /API Keys/);
});

test("AgentRow settings panel shows read-only path and enabled-only settings", () => {
  const html = renderAgentRow(CLAUDE_AGENT, { settingsOpen: true });

  assert.match(html, /Close settings/);
  assert.match(html, /CLI path/);
  assert.match(html, /\/usr\/local\/bin\/claude/);
  assert.match(html, /Edit CLI path/);
  assert.match(html, /Default model/);
  assert.match(html, /Auto-approve/);
  assert.match(html, /API Keys/);
});

test("AgentRow path edit mode exposes explicit confirm and cancel actions", () => {
  const html = renderAgentRow(CLAUDE_AGENT, {
    settingsOpen: true,
    pathEditing: true,
  });

  assert.match(html, /Leave empty to resolve on PATH/);
  assert.match(html, /Confirm path/);
  assert.match(html, /Cancel path edit/);
});

const CLOUDFLARE_PROVIDER: ProviderStatus = {
  id: "cloudflare",
  name: "Cloudflare",
  singleField: false,
  fields: [
    { id: "accountId", label: "Account ID", configured: true, hint: "abcd...wxyz", secret: false },
    { id: "apiToken", label: "API token", configured: true, hint: "abcd...wxyz", secret: true },
    { id: "aiGatewayId", label: "AI Gateway ID", configured: false, hint: null, secret: false },
  ],
};

test("ApiKeysSection renders one row per Cloudflare field with the right labels", () => {
  const html = renderToStaticMarkup(
    <ApiKeysSection providers={[CLOUDFLARE_PROVIDER]} onChange={() => {}} />
  );
  assert.match(html, /Cloudflare/);
  assert.match(html, /Account ID/);
  assert.match(html, /API token/);
  assert.match(html, /AI Gateway ID/);
  // Each configured field surfaces its hint; the unconfigured one doesn't.
  assert.match(html, /abcd\.\.\.wxyz/);
  // Multi-field providers expose add / update / delete controls for every
  // field independently.
  assert.match(html, /Update Account ID|Add Account ID/);
  assert.match(html, /Update API token|Add API token/);
  assert.match(html, /Add AI Gateway ID/);
  // The unconfigured field should only offer the "add" action, not "update"
  // or "delete" (no value to mutate or remove yet).
  assert.match(html, /Add AI Gateway ID/);
  assert.doesNotMatch(html, /Update AI Gateway ID/);
  assert.doesNotMatch(html, /Delete AI Gateway ID/);
});

const GROQ_PROVIDER: ProviderStatus = {
  id: "groq",
  name: "Groq",
  singleField: true,
  fields: [
    { id: "apiToken", label: "API key", configured: true, hint: "gsk-...abcd", secret: true },
  ],
};

test("ApiKeysSection renders a single field for single-field providers", () => {
  const html = renderToStaticMarkup(
    <ApiKeysSection providers={[GROQ_PROVIDER]} onChange={() => {}} />
  );
  assert.match(html, /Groq/);
  assert.match(html, /API key/);
  assert.match(html, /gsk-\.\.\.abcd/);
  // Legacy single-field path only renders the canonical "add / update / delete"
  // surface for the single field — no per-field sub-form, no second input.
  assert.match(html, /Update API key|Add API key/);
  assert.match(html, /Delete API key/);
});
