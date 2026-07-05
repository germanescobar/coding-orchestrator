import fs from "node:fs/promises";
import { apiKeysFile, ensureOrchestratorHome } from "./paths.js";

/**
 * A single editable value on a provider (e.g., the API token, an account id).
 * Single-key providers expose one field; multi-field providers expose several.
 */
export interface ProviderField {
  /** Stable id used in the API and the JSON store (e.g., "apiToken"). */
  id: string;
  /** Human label rendered in the Settings UI (e.g., "API token"). */
  label: string;
  /** Environment variable injected into the spawned agent process. */
  envVar: string;
  /** True when the value is a secret (masked in the UI, password input). */
  secret: boolean;
}

export interface ProviderConfig {
  id: string;
  name: string;
  /** When present, the provider exposes a single value (back-compat shape). */
  envVar?: string;
  /** All editable fields on the provider. Always populated at module load. */
  fields: ProviderField[];
}

const FIELD_API_TOKEN: ProviderField = {
  id: "apiToken",
  label: "API key",
  envVar: "",
  secret: true,
};

function singleFieldProvider(
  id: string,
  name: string,
  envVar: string
): ProviderConfig {
  return {
    id,
    name,
    envVar,
    fields: [{ ...FIELD_API_TOKEN, envVar }],
  };
}

export const PROVIDERS: ProviderConfig[] = [
  singleFieldProvider("ollama-cloud", "Ollama Cloud", "OLLAMA_API_KEY"),
  singleFieldProvider("openrouter", "OpenRouter", "OPENROUTER_API_KEY"),
  {
    id: "cloudflare",
    name: "Cloudflare",
    fields: [
      {
        id: "accountId",
        label: "Account ID",
        envVar: "CLOUDFLARE_ACCOUNT_ID",
        secret: false,
      },
      {
        id: "apiToken",
        label: "API token",
        envVar: "CLOUDFLARE_API_TOKEN",
        secret: true,
      },
      {
        id: "aiGatewayId",
        label: "AI Gateway ID",
        envVar: "CLOUDFLARE_AI_GATEWAY_ID",
        secret: false,
      },
    ],
  },
];

// Provider ids no longer supported. A stored key for any of these is pruned
// the next time the store is read so it stops being surfaced or injected.
const REMOVED_PROVIDER_IDS = ["openai", "groq"];

/**
 * Persisted shape: provider id -> field id -> value. The first nesting is
 * always the provider id (so multi-field providers group their fields) and
 * the second is the field id, which is stable across releases.
 */
type ApiKeyStore = Record<string, Record<string, string>>;

async function readStore(): Promise<ApiKeyStore> {
  try {
    const content = await fs.readFile(apiKeysFile(), "utf-8");
    const raw = JSON.parse(content) as unknown;
    const normalized = normalizeStore(raw);
    const cleaned = await pruneRemovedProviders(normalized);
    // If normalization mutated the shape (e.g., dropped a removed provider
    // that only existed in the legacy single-value format), persist the
    // rewrite so the on-disk file matches the in-memory view.
    if (raw && typeof raw === "object" && !arraysEqualKeys(raw, cleaned)) {
      await writeStore(cleaned);
    }
    return cleaned;
  } catch {
    return {};
  }
}

function arraysEqualKeys(raw: unknown, store: ApiKeyStore): boolean {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const rawKeys = Object.keys(raw as Record<string, unknown>).sort();
  const storeKeys = Object.keys(store).sort();
  if (rawKeys.length !== storeKeys.length) return false;
  for (let i = 0; i < rawKeys.length; i += 1) {
    if (rawKeys[i] !== storeKeys[i]) return false;
  }
  return true;
}

/**
 * Accept the legacy `Record<providerId, string>` shape (single value per
 * provider) and the newer `Record<providerId, Record<fieldId, string>>`
 * shape, returning the new shape. Empty / non-object values are dropped.
 */
function normalizeStore(raw: unknown): ApiKeyStore {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const result: ApiKeyStore = {};
  for (const [providerId, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "string") {
      // Legacy single-value shape: store under the provider's lone field.
      if (!value) continue;
      const provider = PROVIDERS.find((p) => p.id === providerId);
      if (!provider || provider.fields.length !== 1) continue;
      result[providerId] = { [provider.fields[0].id]: value };
      continue;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const fields: Record<string, string> = {};
    for (const [fieldId, fieldValue] of Object.entries(value as Record<string, unknown>)) {
      if (typeof fieldValue === "string" && fieldValue.length > 0) {
        fields[fieldId] = fieldValue;
      }
    }
    if (Object.keys(fields).length > 0) {
      result[providerId] = fields;
    }
  }
  return result;
}

/** Drop keys for removed providers, persisting the change when one is found. */
async function pruneRemovedProviders(store: ApiKeyStore): Promise<ApiKeyStore> {
  const hadRemoved = REMOVED_PROVIDER_IDS.some((id) => id in store);
  let mutated = hadRemoved;
  if (hadRemoved) {
    for (const id of REMOVED_PROVIDER_IDS) {
      delete store[id];
    }
  }
  // Drop fields belonging to providers whose definitions have been removed,
  // and drop any field ids that no longer exist on their provider.
  for (const provider of PROVIDERS) {
    const entry = store[provider.id];
    if (!entry) continue;
    const valid = new Set(provider.fields.map((f) => f.id));
    for (const fieldId of Object.keys(entry)) {
      if (!valid.has(fieldId)) {
        delete entry[fieldId];
        mutated = true;
      }
    }
    if (Object.keys(entry).length === 0) {
      delete store[provider.id];
      mutated = true;
    }
  }
  if (mutated) await writeStore(store);
  return store;
}

async function writeStore(store: ApiKeyStore) {
  await ensureOrchestratorHome();
  await fs.writeFile(apiKeysFile(), JSON.stringify(store, null, 2));
}

function getProvider(providerId: string): ProviderConfig | undefined {
  return PROVIDERS.find((p) => p.id === providerId);
}

function getField(
  provider: ProviderConfig,
  fieldId: string
): ProviderField | undefined {
  return provider.fields.find((f) => f.id === fieldId);
}

/** Returns the configured value for a single field, or null when unset. */
export async function getApiKeyField(
  providerId: string,
  fieldId: string
): Promise<string | null> {
  const provider = getProvider(providerId);
  if (!provider) return null;
  if (!getField(provider, fieldId)) return null;
  const store = await readStore();
  return store[providerId]?.[fieldId] ?? null;
}

/** Sets a single field on a provider. Empty values clear the field. */
export async function setApiKeyField(
  providerId: string,
  fieldId: string,
  value: string
): Promise<void> {
  const provider = getProvider(providerId);
  if (!provider) throw new Error(`Unknown provider: ${providerId}`);
  if (!getField(provider, fieldId)) {
    throw new Error(`Unknown field: ${providerId}.${fieldId}`);
  }
  const store = await readStore();
  const trimmed = value.trim();
  if (!store[providerId]) store[providerId] = {};
  if (trimmed.length === 0) {
    delete store[providerId][fieldId];
  } else {
    store[providerId][fieldId] = trimmed;
  }
  if (Object.keys(store[providerId]).length === 0) {
    delete store[providerId];
  }
  await writeStore(store);
}

/** Removes a single field on a provider. The provider entry stays if other fields exist. */
export async function deleteApiKeyField(
  providerId: string,
  fieldId: string
): Promise<void> {
  const provider = getProvider(providerId);
  if (!provider) return;
  if (!getField(provider, fieldId)) return;
  const store = await readStore();
  if (store[providerId]) {
    delete store[providerId][fieldId];
    if (Object.keys(store[providerId]).length === 0) {
      delete store[providerId];
    }
    await writeStore(store);
  }
}

/**
 * Back-compat helpers for single-field providers. The route layer and the
 * legacy tests call these; multi-field providers should use the field-level
 * helpers above.
 */
export async function getApiKey(providerId: string): Promise<string | null> {
  const provider = getProvider(providerId);
  if (!provider) return null;
  if (provider.fields.length !== 1) {
    // Treat multi-field providers as "configured" but the legacy single-key
    // surface returns null to avoid leaking the wrong field.
    return null;
  }
  return getApiKeyField(providerId, provider.fields[0].id);
}

export async function setApiKey(
  providerId: string,
  key: string
): Promise<void> {
  const provider = getProvider(providerId);
  if (!provider) throw new Error(`Unknown provider: ${providerId}`);
  if (provider.fields.length !== 1) {
    throw new Error(
      `Provider ${providerId} is multi-field; set fields individually.`
    );
  }
  await setApiKeyField(providerId, provider.fields[0].id, key);
}

export async function deleteApiKey(providerId: string): Promise<void> {
  const provider = getProvider(providerId);
  if (!provider) return;
  if (provider.fields.length !== 1) return;
  await deleteApiKeyField(providerId, provider.fields[0].id);
}

/** Returns provider IDs that have at least one field configured. */
export async function getConfiguredProviders(): Promise<string[]> {
  const store = await readStore();
  return Object.keys(store).filter(
    (id) => store[id] && Object.keys(store[id]).length > 0
  );
}

/** Build env vars object for all configured provider fields. */
export async function getApiKeyEnvVars(): Promise<Record<string, string>> {
  const store = await readStore();
  const env: Record<string, string> = {};
  for (const provider of PROVIDERS) {
    const entry = store[provider.id];
    if (!entry) continue;
    for (const field of provider.fields) {
      const value = entry[field.id];
      if (value) env[field.envVar] = value;
    }
  }
  return env;
}
