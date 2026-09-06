// Riot's encrypted player identifiers can differ between API applications.
// Keep only a one-way fingerprint in monitor state and private cache keys.
export async function riotKeyFingerprint(key) {
  if (!key) throw new Error("RIOT_API_KEY is not configured");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
