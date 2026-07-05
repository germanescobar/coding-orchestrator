import { Router } from "express";
import {
  PROVIDERS,
  getApiKeyField,
  setApiKeyField,
  deleteApiKeyField,
  type ProviderField,
} from "../lib/api-keys.js";

export const apiKeysRouter = Router();

interface FieldStatus {
  id: string;
  label: string;
  configured: boolean;
  hint: string | null;
  secret: boolean;
}

interface ProviderStatusResponse {
  id: string;
  name: string;
  /** When true, the row uses the legacy single-input shape. */
  singleField: boolean;
  fields: FieldStatus[];
}

function hintFor(field: ProviderField, value: string | null): string | null {
  if (!value) return null;
  // Account / gateway ids tend to be short hex strings; the token is much
  // longer. Show enough of either end to confirm the right value is loaded
  // without leaking the secret.
  if (value.length <= 8) return value;
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

/** List all providers with their per-field configuration status. */
apiKeysRouter.get("/", async (_req, res) => {
  const result: ProviderStatusResponse[] = await Promise.all(
    PROVIDERS.map(async (p) => {
      const fields = await Promise.all(
        p.fields.map(async (f) => {
          const value = await getApiKeyField(p.id, f.id);
          return {
            id: f.id,
            label: f.label,
            configured: value !== null,
            hint: hintFor(f, value),
            secret: f.secret,
          };
        })
      );
      return {
        id: p.id,
        name: p.name,
        singleField: p.fields.length === 1,
        fields,
      };
    })
  );
  res.json(result);
});

/** Set a single field on a provider. */
apiKeysRouter.put("/:providerId/:fieldId", async (req, res) => {
  const { providerId, fieldId } = req.params;
  const provider = PROVIDERS.find((p) => p.id === providerId);
  if (!provider) {
    res.status(404).json({ error: "Unknown provider" });
    return;
  }
  const field = provider.fields.find((f) => f.id === fieldId);
  if (!field) {
    res.status(404).json({ error: "Unknown field" });
    return;
  }
  const { value } = req.body as { value?: string };
  if (typeof value !== "string") {
    res.status(400).json({ error: "value is required" });
    return;
  }
  await setApiKeyField(providerId, fieldId, value);
  res.json({ ok: true });
});

/** Remove a single field on a provider. */
apiKeysRouter.delete("/:providerId/:fieldId", async (req, res) => {
  const { providerId, fieldId } = req.params;
  const provider = PROVIDERS.find((p) => p.id === providerId);
  if (!provider) {
    res.status(404).json({ error: "Unknown provider" });
    return;
  }
  const field = provider.fields.find((f) => f.id === fieldId);
  if (!field) {
    res.status(404).json({ error: "Unknown field" });
    return;
  }
  await deleteApiKeyField(providerId, fieldId);
  res.json({ ok: true });
});
