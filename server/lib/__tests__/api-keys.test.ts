import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  PROVIDERS,
  getConfiguredProviders,
  getApiKeyEnvVars,
  getApiKeyField,
  setApiKeyField,
  deleteApiKeyField,
} from "../api-keys.js";
import { apiKeysFile } from "../paths.js";

function withTempHome(seed: Record<string, unknown>, run: () => Promise<void>): Promise<void> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "api-keys-"));
  const original = process.env.CONTROLLER_HOME;
  process.env.CONTROLLER_HOME = dir;
  writeFileSync(path.join(dir, "api-keys.json"), JSON.stringify(seed, null, 2));
  return run().finally(() => {
    if (original === undefined) delete process.env.CONTROLLER_HOME;
    else process.env.CONTROLLER_HOME = original;
    rmSync(dir, { recursive: true, force: true });
  });
}

test("PROVIDERS no longer includes OpenAI", () => {
  assert.ok(!PROVIDERS.some((p) => p.id === "openai"));
});

test("a stored OpenAI key is pruned on read", async () => {
  await withTempHome({ openai: "sk-old", openrouter: "ork-keep" }, async () => {
    const configured = await getConfiguredProviders();
    assert.ok(!configured.includes("openai"));
    assert.ok(configured.includes("openrouter"));

    const env = await getApiKeyEnvVars();
    assert.equal(env.OPENAI_API_KEY, undefined);
    assert.equal(env.OPENROUTER_API_KEY, "ork-keep");

    // Prune persists to disk. The legacy single-value shape is normalized to
    // the multi-field shape on first read, and the removed OpenAI entry is
    // dropped in the same pass.
    const onDisk = JSON.parse(readFileSync(apiKeysFile(), "utf-8"));
    assert.equal("openai" in onDisk, false);
    assert.deepEqual(onDisk.openrouter, { apiToken: "ork-keep" });
    assert.ok(existsSync(apiKeysFile()));
  });
});

test("Cloudflare provider exposes account id, token, and gateway id fields", () => {
  const cloudflare = PROVIDERS.find((p) => p.id === "cloudflare");
  assert.ok(cloudflare, "Cloudflare provider should be registered");
  assert.equal(cloudflare.fields.length, 3);
  const fieldIds = cloudflare.fields.map((f) => f.id);
  assert.deepEqual(fieldIds, ["accountId", "apiToken", "aiGatewayId"]);
  const envVars = cloudflare.fields.map((f) => f.envVar);
  assert.deepEqual(envVars, [
    "CLOUDFLARE_ACCOUNT_ID",
    "CLOUDFLARE_API_TOKEN",
    "CLOUDFLARE_AI_GATEWAY_ID",
  ]);
  // Only the API token is a secret; account and gateway ids are non-sensitive
  // identifiers.
  const secretMap = Object.fromEntries(cloudflare.fields.map((f) => [f.id, f.secret]));
  assert.equal(secretMap.apiToken, true);
  assert.equal(secretMap.accountId, false);
  assert.equal(secretMap.aiGatewayId, false);
});

test("legacy single-field providers still expose a single env-var binding", () => {
  for (const provider of PROVIDERS) {
    if (provider.id === "cloudflare") continue;
    assert.equal(provider.fields.length, 1, `${provider.id} should have one field`);
    assert.ok(provider.envVar, `${provider.id} should keep its envVar shorthand`);
    assert.equal(provider.fields[0].envVar, provider.envVar);
  }
});

test("Cloudflare fields are stored independently and injected as separate env vars", async () => {
  await withTempHome({}, async () => {
    await setApiKeyField("cloudflare", "accountId", "acc-1");
    await setApiKeyField("cloudflare", "apiToken", "tok-1");
    await setApiKeyField("cloudflare", "aiGatewayId", "gw-1");

    const onDisk = JSON.parse(readFileSync(apiKeysFile(), "utf-8"));
    assert.deepEqual(onDisk.cloudflare, {
      accountId: "acc-1",
      apiToken: "tok-1",
      aiGatewayId: "gw-1",
    });

    const env = await getApiKeyEnvVars();
    assert.equal(env.CLOUDFLARE_ACCOUNT_ID, "acc-1");
    assert.equal(env.CLOUDFLARE_API_TOKEN, "tok-1");
    assert.equal(env.CLOUDFLARE_AI_GATEWAY_ID, "gw-1");

    // Deleting one field leaves the others intact.
    await deleteApiKeyField("cloudflare", "aiGatewayId");
    assert.equal(await getApiKeyField("cloudflare", "aiGatewayId"), null);
    assert.equal(await getApiKeyField("cloudflare", "accountId"), "acc-1");
    assert.equal(await getApiKeyField("cloudflare", "apiToken"), "tok-1");

    const after = JSON.parse(readFileSync(apiKeysFile(), "utf-8"));
    assert.deepEqual(after.cloudflare, { accountId: "acc-1", apiToken: "tok-1" });
  });
});

test("deleting the last Cloudflare field removes the provider entry", async () => {
  await withTempHome({}, async () => {
    await setApiKeyField("cloudflare", "apiToken", "tok-1");
    let onDisk = JSON.parse(readFileSync(apiKeysFile(), "utf-8"));
    assert.ok("cloudflare" in onDisk);
    await deleteApiKeyField("cloudflare", "apiToken");
    onDisk = JSON.parse(readFileSync(apiKeysFile(), "utf-8"));
    assert.equal("cloudflare" in onDisk, false);
    assert.deepEqual(await getConfiguredProviders(), []);
  });
});

test("setting an empty Cloudflare field clears just that field", async () => {
  await withTempHome({}, async () => {
    await setApiKeyField("cloudflare", "apiToken", "tok-1");
    await setApiKeyField("cloudflare", "accountId", "acc-1");
    await setApiKeyField("cloudflare", "accountId", "   ");
    const onDisk = JSON.parse(readFileSync(apiKeysFile(), "utf-8"));
    assert.deepEqual(onDisk.cloudflare, { apiToken: "tok-1" });
  });
});

test("unknown field ids are rejected by setApiKeyField", async () => {
  await withTempHome({}, async () => {
    await assert.rejects(
      setApiKeyField("cloudflare", "totallyMadeUp", "x")
    );
    await assert.rejects(setApiKeyField("nope", "apiToken", "x"));
  });
});

test("fields whose id no longer exists on the provider are pruned on read", async () => {
  // Simulate a stored value referencing a field id that has since been
  // renamed or removed from the Cloudflare provider schema. The same
  // "all or nothing" pass that drops removed providers must also drop
  // orphaned fields and rewrite the file so the surface stays consistent.
  await withTempHome(
    { cloudflare: { apiToken: "tok-1", legacyField: "stale" } },
    async () => {
      const accountId = await getApiKeyField("cloudflare", "accountId");
      assert.equal(accountId, null);

      const onDisk = JSON.parse(readFileSync(apiKeysFile(), "utf-8"));
      assert.deepEqual(onDisk.cloudflare, { apiToken: "tok-1" });
    }
  );
});
