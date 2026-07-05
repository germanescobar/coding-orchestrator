/*
 * At-rest JSON store for integration secrets (issue #130).
 *
 * Two storage formats are supported, identified by the on-disk envelope:
 *
 *   1. Encrypted (`{ v: 1, enc: true, blob }`). The blob is base64 of
 *      `safeStorage.encryptString`'s output. Used when the server runs
 *      inside an Electron build that has access to a stable keychain
 *      identity — i.e. a properly signed/notarized build. The OS
 *      keychain is what makes the ciphertext unreadable to other
 *      processes.
 *
 *   2. Plaintext (`{ v: 1, enc: false, data }`). A 0600 file with the
 *      JSON inline. Used when safeStorage is unavailable (the server
 *      is running under `tsx` for tests, or as a forked process where
 *      `electron` resolves to a binary path string rather than the
 *      module).
 *
 * The historical Controller builds (issue #130) shipped only ad-hoc
 * signed Electron binaries. Each rebuild produces a different code-
 * signing identity, so safeStorage's per-binary keychain entry changes
 * with every release — old ciphertext is unreadable by the new
 * binary, throwing "Error while decrypting the ciphertext provided to
 * safeStorage.decryptString" on every read. To avoid that footgun we
 * use the plaintext envelope for now and document the trade-off:
 * secrets at rest are protected by 0600 file permissions only, not
 * OS-level encryption. A future notarized build can opt back into the
 * encrypted envelope by setting `CONTROLLER_ENCRYPT_SECRETS=1`.
 *
 * Recovery from a corrupt (un-decryptable) encrypted file: on read we
 * rename the existing file to `<file>.broken-<iso>` and return the
 * fallback, so the rest of the app keeps working. The user re-
 * authorizes affected connections. The connections themselves live in
 * `integrations.json` (plaintext) and are preserved.
 */

import fs from "node:fs/promises";
import path from "node:path";

interface EncryptedEnvelope {
  v: 1;
  enc: true;
  /** base64 of safeStorage ciphertext over the JSON payload. */
  blob: string;
}

interface PlaintextEnvelope {
  v: 1;
  enc: false;
  data: unknown;
}

type Envelope = EncryptedEnvelope | PlaintextEnvelope;

type SafeStorage = {
  isEncryptionAvailable: () => boolean;
  encryptString: (plainText: string) => Buffer;
  decryptString: (encrypted: Buffer) => string;
};

let cachedSafeStorage: SafeStorage | null | undefined;

/**
 * When `CONTROLLER_ENCRYPT_SECRETS=1`, prefer the encrypted envelope even
 * outside Electron when safeStorage is available. Default off: the project
 * ships only ad-hoc-signed builds, where the per-binary keychain entry
 * changes every rebuild and turns the encrypted envelope into a trap.
 */
function preferEncryption(): boolean {
  return process.env.CONTROLLER_ENCRYPT_SECRETS === "1";
}

/*
 * Resolve Electron's `safeStorage` if we are running inside Electron and the OS
 * keychain is ready. Cached because the answer cannot change within a process.
 * Outside Electron, `import("electron")` resolves to the binary path string, so
 * `safeStorage` is undefined and we return null.
 */
async function getSafeStorage(): Promise<SafeStorage | null> {
  if (cachedSafeStorage !== undefined) return cachedSafeStorage;
  try {
    const electron = (await import("electron")) as unknown as {
      safeStorage?: SafeStorage;
    };
    const ss = electron.safeStorage;
    cachedSafeStorage = ss && ss.isEncryptionAvailable() ? ss : null;
  } catch {
    cachedSafeStorage = null;
  }
  return cachedSafeStorage;
}

/**
 * Read and parse a JSON value, returning `fallback` when the file is absent,
 * unreadable, or encrypted with a key the current process can't access.
 *
 * The decrypt-failure path is the important one: when `safeStorage.decryptString`
 * throws, the file on disk was written by a build whose keychain identity the
 * current process no longer has (typical when the Electron app has been
 * rebuilt and re-signed). Renaming the file aside and returning the fallback
 * keeps the rest of the app functional; the user re-authorizes any affected
 * OAuth schemes.
 */
export async function readSecretJson<T>(file: string, fallback: T): Promise<T> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf-8");
  } catch {
    return fallback;
  }

  let envelope: Envelope;
  try {
    envelope = JSON.parse(raw) as Envelope;
  } catch {
    return fallback;
  }

  if (!envelope.enc) {
    return envelope.data as T;
  }

  const safeStorage = await getSafeStorage();
  if (!safeStorage) {
    // Encrypted envelope but no keychain access in this process. The
    // file was written by Electron; we can't read it from `tsx` / tests.
    // Treat as missing so reads don't crash the rest of the app.
    console.warn(
      `[secret-store] ${file} is encrypted with the OS keychain, which is ` +
        "not available in this process. Treating as empty."
    );
    return fallback;
  }
  try {
    const decrypted = safeStorage.decryptString(Buffer.from(envelope.blob, "base64"));
    return JSON.parse(decrypted) as T;
  } catch (error) {
    // Most common cause: the file was written by a different (rebuilt /
    // re-signed) Electron binary whose keychain entry the current
    // process can't access. Quarantine the file so we don't keep
    // tripping on it, and return the fallback.
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const broken = `${file}.broken-${stamp}`;
    console.warn(
      `[secret-store] Failed to decrypt ${file} (${error instanceof Error ? error.message : String(error)}). ` +
        `Moving it aside to ${broken} and treating secrets as empty. ` +
        "Affected connections will need to be re-authorized."
    );
    try {
      await fs.rename(file, broken);
    } catch {
      // Best-effort: if rename fails (permission, etc.) we still want
      // the read to succeed and the next write to overwrite.
    }
    return fallback;
  }
}

/** Encrypt (when possible) and persist a JSON value, creating parent dirs. */
export async function writeSecretJson(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });

  if (preferEncryption()) {
    const safeStorage = await getSafeStorage();
    if (safeStorage) {
      try {
        const blob = safeStorage.encryptString(JSON.stringify(value)).toString("base64");
        const envelope: EncryptedEnvelope = { v: 1, enc: true, blob };
        await fs.writeFile(file, JSON.stringify(envelope), { mode: 0o600 });
        return;
      } catch (error) {
        // If the keychain is in a weird state (just-rebuilt binary,
        // locked keychain, etc.) the encrypt call can throw. Fall
        // through to the plaintext path so the write still succeeds.
        console.warn(
          `[secret-store] Failed to encrypt ${file} (${error instanceof Error ? error.message : String(error)}). ` +
            "Falling back to plaintext envelope."
        );
      }
    }
  }

  const envelope: PlaintextEnvelope = { v: 1, enc: false, data: value };
  await fs.writeFile(file, JSON.stringify(envelope, null, 2), { mode: 0o600 });
}
