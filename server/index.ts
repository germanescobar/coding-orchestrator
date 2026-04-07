import express from "express";
import cors from "cors";
import { projectsRouter } from "./routes/projects.js";
import { sessionsRouter } from "./routes/sessions.js";

const app = express();
app.use(cors());
app.use(express.json());

app.use("/api/projects", projectsRouter);
app.use("/api/projects", sessionsRouter);

const PORT = 3100;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
