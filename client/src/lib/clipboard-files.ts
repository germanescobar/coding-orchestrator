/*
 * Extracts File objects from a `DataTransfer` / `ClipboardEvent.clipboardData`
 * payload so the chat composer can forward pasted screenshots into the same
 * `addComposerFiles` code path that already handles drop and the file picker.
 *
 * Why a helper instead of inlining the conversion in the component:
 * - Keeps the paste handler in `SessionView.tsx` declarative and short.
 * - Lets us cover the few non-obvious edge cases (no items, text-only,
 *   mixed text + files, multiple files) with a unit test without spinning up
 *   a React renderer.
 *
 * Behavior contract:
 * - Returns an empty array when the clipboard carries no usable files. Callers
 *   should fall through to the default browser behavior in that case so a
 *   plain text paste still inserts text into the textarea.
 * - When both text and files are present, the files win (the standard
 *   expectation when a screenshot tool also places a text fallback on the
 *   clipboard).
 * - Items whose `getAsFile()` returns `null` are skipped silently — they have
 *   `kind === "file"` but the platform couldn't materialize a `File` (rare,
 *   happens on some mobile browsers).
 */
export function extractFilesFromClipboard(
  clipboardData: DataTransfer | null | undefined
): File[] {
  if (!clipboardData) return [];

  // `clipboardData.items` is a `DataTransferItemList`. The `DataTransfer.files`
  // shortcut only returns the file items, which is exactly what we want, but
  // it can be empty on some browsers when the items are exposed via `items`
  // first. Walk both to be defensive.
  const files: File[] = [];
  const seen = new Set<File>();

  const pushFile = (file: File | null | undefined) => {
    if (!file) return;
    if (seen.has(file)) return;
    seen.add(file);
    files.push(file);
  };

  if (clipboardData.items && clipboardData.items.length > 0) {
    for (let i = 0; i < clipboardData.items.length; i += 1) {
      const item = clipboardData.items[i];
      if (!item || item.kind !== "file") continue;
      pushFile(item.getAsFile());
    }
  }

  if (files.length === 0 && clipboardData.files && clipboardData.files.length > 0) {
    // `DataTransfer.files` is a `FileList`. Iterate by index because
    // `FileList` is iterable in modern browsers but the index form is
    // universally supported.
    for (let i = 0; i < clipboardData.files.length; i += 1) {
      pushFile(clipboardData.files[i] ?? null);
    }
  }

  return files;
}
