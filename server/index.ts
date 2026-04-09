import express from "express";
import cors from "cors";
import { projectsRouter } from "./routes/projects.js";
import { sessionsRouter } from "./routes/sessions.js";
import { modelsRouter } from "./routes/models.js";

const app = express();
app.use(cors());
app.use(express.json());

app.use("/api/projects", projectsRouter);
app.use("/api/projects", sessionsRouter);
app.use("/api/models", modelsRouter);

const PORT = 3100;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
