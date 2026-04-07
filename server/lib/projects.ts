import fs from "node:fs/promises";
import path from "node:path";
import { v4 as uuidv4 } from "uuid";

export interface Project {
  id: string;
  name: string;
  path: string;
  createdAt: string;
}

const DATA_DIR = path.join(process.cwd(), ".data");
const PROJECTS_FILE = path.join(DATA_DIR, "projects.json");

async function ensureDataDir() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

export async function getProjects(): Promise<Project[]> {
  try {
    const content = await fs.readFile(PROJECTS_FILE, "utf-8");
    return JSON.parse(content) as Project[];
  } catch {
    return [];
  }
}

export async function addProject(
  name: string,
  projectPath: string
): Promise<Project> {
  await ensureDataDir();
  const projects = await getProjects();
  const project: Project = {
    id: uuidv4(),
    name,
    path: projectPath,
    createdAt: new Date().toISOString(),
  };
  projects.push(project);
  await fs.writeFile(PROJECTS_FILE, JSON.stringify(projects, null, 2));
  return project;
}

export async function getProject(id: string): Promise<Project | null> {
  const projects = await getProjects();
  return projects.find((p) => p.id === id) ?? null;
}

export async function deleteProject(id: string): Promise<boolean> {
  const projects = await getProjects();
  const filtered = projects.filter((p) => p.id !== id);
  if (filtered.length === projects.length) return false;
  await ensureDataDir();
  await fs.writeFile(PROJECTS_FILE, JSON.stringify(filtered, null, 2));
  return true;
}
