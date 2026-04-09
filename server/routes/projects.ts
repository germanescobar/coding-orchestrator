import { Router } from "express";
import { getProjects, addProject, deleteProject } from "../lib/projects.js";

export const projectsRouter = Router();

projectsRouter.get("/", async (_req, res) => {
  try {
    const projects = await getProjects();
    res.json(projects);
  } catch (err) {
    console.error("GET /projects error:", err);
    res.status(500).json({ error: (err as Error).message });
  }
});

projectsRouter.post("/", async (req, res) => {
  try {
    const { name, path } = req.body as { name: string; path: string };
    if (!name || !path) {
      res.status(400).json({ error: "name and path are required" });
      return;
    }
    const project = await addProject(name, path);
    res.status(201).json(project);
  } catch (err) {
    console.error("POST /projects error:", err);
    res.status(500).json({ error: (err as Error).message });
  }
});

projectsRouter.delete("/:id", async (req, res) => {
  try {
    const deleted = await deleteProject(req.params.id);
    if (!deleted) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    console.error("DELETE /projects error:", err);
    res.status(500).json({ error: (err as Error).message });
  }
});
