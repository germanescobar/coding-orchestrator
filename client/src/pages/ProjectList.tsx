import { useState, useEffect } from "react";
import { fetchProjects, createProject, deleteProject, type Project } from "../api.ts";

export function ProjectList({ onSelect }: { onSelect: (id: string) => void }) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [path, setPath] = useState("");

  const load = () => {
    fetchProjects().then(setProjects);
  };

  useEffect(load, []);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name || !path) return;
    await createProject(name, path);
    setName("");
    setPath("");
    setShowForm(false);
    load();
  };

  const handleDelete = async (id: string) => {
    await deleteProject(id);
    load();
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-2xl font-semibold">Projects</h2>
        <button
          onClick={() => setShowForm(!showForm)}
          className="bg-blue-600 hover:bg-blue-700 px-4 py-2 rounded text-sm font-medium"
        >
          + Add Project
        </button>
      </div>

      {showForm && (
        <form onSubmit={handleCreate} className="mb-6 bg-gray-900 p-4 rounded-lg border border-gray-800 space-y-3">
          <div>
            <label className="block text-sm text-gray-400 mb-1">Name</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My Project"
              className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="block text-sm text-gray-400 mb-1">Path</label>
            <input
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="/Users/me/projects/my-project"
              className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm"
            />
          </div>
          <div className="flex gap-2">
            <button type="submit" className="bg-green-600 hover:bg-green-700 px-4 py-2 rounded text-sm font-medium">
              Create
            </button>
            <button type="button" onClick={() => setShowForm(false)} className="bg-gray-700 hover:bg-gray-600 px-4 py-2 rounded text-sm">
              Cancel
            </button>
          </div>
        </form>
      )}

      {projects.length === 0 ? (
        <p className="text-gray-500">No projects yet. Add one to get started.</p>
      ) : (
        <div className="space-y-2">
          {projects.map((p) => (
            <div
              key={p.id}
              className="flex items-center justify-between bg-gray-900 border border-gray-800 rounded-lg p-4 hover:border-gray-700 cursor-pointer"
              onClick={() => onSelect(p.id)}
            >
              <div>
                <div className="font-medium">{p.name}</div>
                <div className="text-sm text-gray-500">{p.path}</div>
              </div>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  handleDelete(p.id);
                }}
                className="text-gray-600 hover:text-red-400 text-sm"
              >
                Delete
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
