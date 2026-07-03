/*
 * `fetch` with a wall-clock timeout. Both the OAuth dynamic module and the
 * client-credentials module need it, and Node's built-in `fetch` doesn't
 * expose a timeout option until you wire one through AbortController. This
 * keeps the call sites readable and makes test injection (`fetchImpl`)
 * uniform — the helper accepts a `fetch` argument so the test can swap in
 * a stub.
 */

export async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`Request to ${url} timed out after ${timeoutMs}ms.`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
