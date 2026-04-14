import { Router } from "express";
import {
  PROVIDERS,
  getApiKey,
  setApiKey,
  deleteApiKey,
} from "../lib/api-keys.js";

export const apiKeysRouter = Router();

/** List all providers with their configuration status (never exposes full keys) */
apiKeysRouter.get("/", async (_req, res) => {
  const result = await Promise.all(
    PROVIDERS.map(async (p) => {
      const key = await getApiKey(p.id);
      return {
        id: p.id,
        name: p.name,
        configured: !!key,
        hint: key ? `${key.slice(0, 4)}...${key.slice(-4)}` : null,
      };
    })
  );
  res.json(result);
});

/** Set an API key for a provider */
apiKeysRouter.put("/:providerId", async (req, res) => {
  const { providerId } = req.params;
  const provider = PROVIDERS.find((p) => p.id === providerId);
  if (!provider) {
    res.status(404).json({ error: "Unknown provider" });
    return;
  }
  const { key } = req.body as { key?: string };
  if (!key || typeof key !== "string") {
    res.status(400).json({ error: "key is required" });
    return;
  }
  await setApiKey(providerId, key.trim());
  res.json({ ok: true });
});

/** Remove an API key for a provider */
apiKeysRouter.delete("/:providerId", async (req, res) => {
  const { providerId } = req.params;
  const provider = PROVIDERS.find((p) => p.id === providerId);
  if (!provider) {
    res.status(404).json({ error: "Unknown provider" });
    return;
  }
  await deleteApiKey(providerId);
  res.json({ ok: true });
});
