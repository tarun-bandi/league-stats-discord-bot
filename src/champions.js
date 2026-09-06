const normalize = (name) => String(name ?? "").replace(/[^a-z0-9]/gi, "").toLowerCase();

async function publicJson(url) {
  const request = new Request(url);
  const cache = globalThis.caches?.default;
  const hit = cache ? await cache.match(request) : null;
  if (hit) return hit.json();
  const response = await fetch(request);
  if (!response.ok) throw new Error("Champion catalog unavailable");
  const value = await response.json();
  if (cache) await cache.put(request, new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json", "Cache-Control": "public,max-age=86400" },
  }));
  return value;
}

export function catalogFromData(version, data) {
  const catalog = new Map();
  if (!/^\d+\.\d+\.\d+$/.test(version)) return catalog;
  for (const champion of Object.values(data ?? {})) {
    if (!/^[A-Za-z0-9]+$/.test(champion.id)) continue;
    const entry = {
      name: champion.name,
      icon: `https://ddragon.leagueoflegends.com/cdn/${version}/img/champion/${champion.id}.png`,
    };
    for (const key of [String(champion.key), normalize(champion.id), normalize(champion.name)]) catalog.set(key, entry);
  }
  return catalog;
}

export function championInfo(catalog, nameOrId) {
  return catalog.get(String(nameOrId)) ?? catalog.get(normalize(nameOrId));
}

export function championThumbnail(catalog, nameOrId) {
  const icon = championInfo(catalog, nameOrId)?.icon;
  return icon ? { thumbnail: { url: icon } } : {};
}

export async function getChampionCatalog() {
  try {
    const realm = await publicJson("https://ddragon.leagueoflegends.com/realms/na.json");
    if (!/^\d+\.\d+\.\d+$/.test(realm.v)) return new Map();
    const champions = await publicJson(`https://ddragon.leagueoflegends.com/cdn/${realm.v}/data/en_US/champion.json`);
    return catalogFromData(realm.v, champions.data);
  } catch {
    // Artwork failure must not hide otherwise valid match/stat results.
    return new Map();
  }
}
