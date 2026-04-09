import { useState } from "react";
import { FolderOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { createProject } from "../api.ts";

interface ProjectSetupProps {
  onCreated: () => void;
  onCancel: () => void;
}

export function ProjectSetup({ onCreated, onCancel }: ProjectSetupProps) {
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !path.trim()) return;
    setLoading(true);
    await createProject(name.trim(), path.trim());
    setLoading(false);
    onCreated();
  };

  return (
    <div className="flex flex-1 items-center justify-center">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl border border-border bg-secondary">
            <FolderOpen className="h-6 w-6 text-muted-foreground" />
          </div>
          <h2 className="text-lg font-medium">Add a project</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Point to a local directory where the coding agent will work
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="mb-1.5 block text-sm text-muted-foreground">
              Project name
            </label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="my-project"
              className="w-full rounded-lg border border-border bg-input px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
          <div>
            <label className="mb-1.5 block text-sm text-muted-foreground">
              Directory path
            </label>
            <input
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="/Users/me/projects/my-project"
              className="w-full rounded-lg border border-border bg-input px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring font-mono"
            />
          </div>
          <div className="flex gap-2 pt-2">
            <Button type="submit" disabled={loading || !name.trim() || !path.trim()} className="flex-1">
              {loading ? "Creating..." : "Create project"}
            </Button>
            <Button type="button" variant="outline" onClick={onCancel}>
              Cancel
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
