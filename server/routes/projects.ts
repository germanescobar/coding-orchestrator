import { Router } from "express";
import { getProjects, addProject, deleteProject } from "../lib/projects.js";

export const projectsRouter = Router();

projectsRouter.get("/", async (_req, res) => {
  const projects = await getProjects();
  res.json(projects);
});

projectsRouter.post("/", async (req, res) => {
  const { name, path } = req.body as { name: string; path: string };
  if (!name || !path) {
    res.status(400).json({ error: "name and path are required" });
    return;
  }
  const project = await addProject(name, path);
  res.status(201).json(project);
});

projectsRouter.delete("/:id", async (req, res) => {
  const deleted = await deleteProject(req.params.id);
  if (!deleted) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  res.json({ ok: true });
});
