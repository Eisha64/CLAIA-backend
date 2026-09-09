// These calls run on the SERVER, not in a browser, so the CORS failures we
// hit inside the chat artifact don't apply here. CORS is a browser-enforced
// policy — server-to-server HTTP requests are never subject to it.

async function lookupMedlinePlus(term) {
  if (!term || !term.trim()) return null;
  try {
    const url = `https://wsearch.nlm.nih.gov/ws/query?db=healthTopics&term=${encodeURIComponent(term)}&rettype=brief`;
    const res = await fetch(url);
    console.log(`[MedlinePlus] GET ${url} -> status ${res.status}`);
    if (!res.ok) return null;
    const text = await res.text();
    console.log(`[MedlinePlus] response body (first 500 chars): ${text.slice(0, 500)}`);

    // More forgiving match: allow any attribute order/extra whitespace around name="title"/"snippet"
    const titleMatch = text.match(/<content[^>]*name="title"[^>]*>([\s\S]*?)<\/content>/);
    const snippetMatch = text.match(/<content[^>]*name="snippet"[^>]*>([\s\S]*?)<\/content>/);
    const strip = (s) => (s ? s.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim() : "");
    const title = strip(titleMatch?.[1]);
    const snippet = strip(snippetMatch?.[1]);
    console.log(`[MedlinePlus] parsed title="${title}" snippet="${snippet.slice(0, 100)}"`);
    if (!title && !snippet) return null;
    return { title, snippet };
  } catch (e) {
    console.error("MedlinePlus lookup failed:", e.message);
    return null;
  }
}

async function searchRxNorm(term, limit = 6) {
  if (!term || term.trim().length < 3) return [];
  try {
    const url = `https://rxnav.nlm.nih.gov/REST/drugs.json?name=${encodeURIComponent(term.trim())}`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = await res.json();
    const groups = data?.drugGroup?.conceptGroup || [];
    const seen = new Set();
    const results = [];
    for (const group of groups) {
      if (!["SCD", "SBD"].includes(group.tty)) continue;
      for (const prop of group.conceptProperties || []) {
        const name = prop.name;
        if (!name || seen.has(name.toLowerCase())) continue;
        seen.add(name.toLowerCase());
        results.push(name);
        if (results.length >= limit) return results;
      }
    }
    return results;
  } catch (e) {
    console.error("RxNorm search failed:", e.message);
    return [];
  }
}

module.exports = { lookupMedlinePlus, searchRxNorm };
