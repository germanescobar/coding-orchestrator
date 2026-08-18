import test from "node:test";
import assert from "node:assert/strict";
import { extractFilesFromClipboard } from "./clipboard-files.ts";

/*
 * The chat composer (issue #314) forwards pasted clipboard images into the
 * existing `addComposerFiles` pipeline. `extractFilesFromClipboard` is the
 * small bridge between the raw `ClipboardEvent.clipboardData` and that
 * pipeline. These tests cover the edge cases that matter for the spec:
 *
 *   - image-only clipboard  -> returns the file(s)
 *   - text-only clipboard   -> returns [] (so default browser behavior runs)
 *   - mixed text + files    -> returns the files (file wins over text)
 *   - missing/empty clipboard -> returns [] (no crash)
 *   - item whose `getAsFile()` returns null -> skipped silently
 */

/* Minimal DataTransferItem stub. */
function makeFileItem(file: File | null): DataTransferItem {
  const item: Partial<DataTransferItem> = {
    kind: "file",
    type: file?.type ?? "",
    getAsFile: () => file,
  };
  return item as DataTransferItem;
}

function makeStringItem(type: string, value: string): DataTransferItem {
  const item: Partial<DataTransferItem> = {
    kind: "string",
    type,
    getAsString: (cb: (s: string) => void) => cb(value),
  };
  // Cast: `DataTransferItem` is broader than what we use; only `kind`/`type`/
  // `getAsFile`/`getAsString` matter to the helper.
  return item as DataTransferItem;
}

function makeDataTransfer(
  items: DataTransferItem[],
  files?: File[]
): DataTransfer {
  const dataTransfer: Partial<DataTransfer> = {
    items,
    files: (files ?? []) as unknown as FileList,
  };
  return dataTransfer as DataTransfer;
}

test("returns files when the clipboard carries an image", () => {
  const png = new File(["fake-png-bytes"], "screenshot.png", { type: "image/png" });
  const dt = makeDataTransfer([makeFileItem(png)]);

  const result = extractFilesFromClipboard(dt);
  assert.equal(result.length, 1);
  assert.equal(result[0], png);
  assert.equal(result[0].name, "screenshot.png");
  assert.equal(result[0].type, "image/png");
});

test("returns multiple files when the clipboard carries several images", () => {
  const png = new File(["a"], "a.png", { type: "image/png" });
  const jpg = new File(["b"], "b.jpg", { type: "image/jpeg" });
  const dt = makeDataTransfer([makeFileItem(png), makeFileItem(jpg)]);

  const result = extractFilesFromClipboard(dt);
  assert.equal(result.length, 2);
  assert.deepEqual(
    result.map((f) => f.name),
    ["a.png", "b.jpg"]
  );
});

test("returns [] for text-only pastes so default browser behavior runs", () => {
  const dt = makeDataTransfer([makeStringItem("text/plain", "hello world")]);

  const result = extractFilesFromClipboard(dt);
  assert.deepEqual(result, []);
});

test("prefers files when the clipboard carries both text and a file", () => {
  const png = new File(["x"], "shot.png", { type: "image/png" });
  const dt = makeDataTransfer([
    makeStringItem("text/plain", "fallback caption"),
    makeFileItem(png),
  ]);

  const result = extractFilesFromClipboard(dt);
  assert.equal(result.length, 1);
  assert.equal(result[0], png);
});

test("returns [] when clipboardData is null or undefined", () => {
  assert.deepEqual(extractFilesFromClipboard(null), []);
  assert.deepEqual(extractFilesFromClipboard(undefined), []);
});

test("returns [] when the clipboard is empty", () => {
  const dt = makeDataTransfer([]);
  assert.deepEqual(extractFilesFromClipboard(dt), []);
});

test("skips file items whose getAsFile() returns null", () => {
  const real = new File(["y"], "real.png", { type: "image/png" });
  const dt = makeDataTransfer([makeFileItem(null), makeFileItem(real)]);

  const result = extractFilesFromClipboard(dt);
  assert.equal(result.length, 1);
  assert.equal(result[0], real);
});

test("falls back to DataTransfer.files when items are unavailable", () => {
  // Some platforms populate `files` directly without exposing a usable
  // `items` list. The helper should still surface the files.
  const png = new File(["z"], "z.png", { type: "image/png" });
  const dataTransfer: Partial<DataTransfer> = {
    files: [png] as unknown as FileList,
  };
  // No `items` exposed — force the fallback branch.
  (dataTransfer as { items?: unknown }).items = undefined;

  const result = extractFilesFromClipboard(dataTransfer as DataTransfer);
  assert.equal(result.length, 1);
  assert.equal(result[0], png);
});
