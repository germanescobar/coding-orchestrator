import { useState, useEffect } from "react";
import { Key, Trash2, Check, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  fetchProviders,
  setProviderKey,
  deleteProviderKey,
  type ProviderStatus,
} from "../api.ts";

interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function SettingsDialog({ open, onOpenChange }: SettingsDialogProps) {
  const [providers, setProviders] = useState<ProviderStatus[]>([]);
  const [editingProvider, setEditingProvider] = useState<string | null>(null);
  const [keyInput, setKeyInput] = useState("");
  const [saving, setSaving] = useState(false);

  const load = () => {
    fetchProviders().then(setProviders).catch(() => {});
  };

  useEffect(() => {
    if (open) load();
  }, [open]);

  const handleSave = async (providerId: string) => {
    if (!keyInput.trim()) return;
    setSaving(true);
    await setProviderKey(providerId, keyInput.trim());
    setKeyInput("");
    setEditingProvider(null);
    setSaving(false);
    load();
  };

  const handleDelete = async (providerId: string) => {
    await deleteProviderKey(providerId);
    load();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>
            Configure API keys for model providers.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            API Keys
          </h3>
          {providers.map((provider) => (
            <div
              key={provider.id}
              className="flex items-center justify-between rounded-lg border border-border p-3"
            >
              <div className="flex items-center gap-3 min-w-0">
                <Key className="h-4 w-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0">
                  <div className="text-sm font-medium">{provider.name}</div>
                  {provider.configured && provider.hint && (
                    <div className="text-xs text-muted-foreground font-mono">
                      {provider.hint}
                    </div>
                  )}
                </div>
              </div>

              <div className="flex items-center gap-1.5 shrink-0">
                {editingProvider === provider.id ? (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      handleSave(provider.id);
                    }}
                    className="flex items-center gap-1.5"
                  >
                    <input
                      type="password"
                      value={keyInput}
                      onChange={(e) => setKeyInput(e.target.value)}
                      placeholder="Paste key..."
                      autoFocus
                      className="w-32 rounded-md border border-border bg-transparent px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
                    />
                    <Button
                      type="submit"
                      size="icon-sm"
                      variant="ghost"
                      disabled={saving || !keyInput.trim()}
                    >
                      {saving ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Check className="h-3.5 w-3.5" />
                      )}
                    </Button>
                  </form>
                ) : (
                  <>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      onClick={() => {
                        setEditingProvider(provider.id);
                        setKeyInput("");
                      }}
                    >
                      <span className="text-xs">
                        {provider.configured ? "Update" : "Add"}
                      </span>
                    </Button>
                    {provider.configured && (
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        onClick={() => handleDelete(provider.id)}
                        className="text-muted-foreground hover:text-destructive"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    )}
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
