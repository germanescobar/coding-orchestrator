import express from "express";
import cors from "cors";
import { projectsRouter } from "./routes/projects.js";
import { sessionsRouter } from "./routes/sessions.js";
import { modelsRouter } from "./routes/models.js";
import { apiKeysRouter } from "./routes/api-keys.js";
import { getAgentProviders } from "./lib/agents.js";

const app = express();
app.use(cors());
app.use(express.json());

app.use("/api/projects", projectsRouter);
app.use("/api/projects", sessionsRouter);
app.use("/api/models", modelsRouter);
app.use("/api/api-keys", apiKeysRouter);

// Agent providers
app.get("/api/agent-providers", (_req, res) => {
  const providers = getAgentProviders().map((p) => ({ id: p.id, name: p.name }));
  res.json(providers);
});

const PORT = 3100;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
