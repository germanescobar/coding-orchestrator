import { Router } from "express";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const modelsRouter = Router();

export interface Model {
  id: string;
  name: string;
  size: string;
}

modelsRouter.get("/", async (_req, res) => {
  try {
    const { stdout } = await execFileAsync("ollama", ["list"]);
    const lines = stdout.trim().split("\n").slice(1); // skip header
    const models: Model[] = lines
      .filter(Boolean)
      .map((line) => {
        const parts = line.split(/\s{2,}/);
        const name = parts[0]?.trim() ?? "";
        const size = parts[2]?.trim() ?? "";
        return {
          id: `ollama/${name}`,
          name,
          size,
        };
      });
    res.json(models);
  } catch {
    res.json([]);
  }
});
