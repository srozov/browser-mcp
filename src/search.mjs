// Web search through MiniMax's search API, over an injected fetch so it is tested without the network. The request is
// the one the mmx command-line tool makes; the result mapping is moved from the page readers' browser server.

export const MINIMAX_SEARCH = "https://api.minimax.io/v1/coding_plan/search";
const MAX_RESULTS = 10;

/** Web search through MiniMax's search API, the request the mmx CLI makes. */
export async function search(fetchFn, { query, key }) {
  const response = await fetchFn(MINIMAX_SEARCH, { method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ q: query }) });
  // Messages carry the status only: never the key, never a provider body that could echo it.
  if (response.status === 401 || response.status === 403) throw new Error(`search failed: the MiniMax key was refused (HTTP ${response.status})`);
  if (!response.ok) throw new Error(`search failed: MiniMax answered HTTP ${response.status}`);
  const data = await response.json().catch(() => { throw new Error("search failed: MiniMax's answer is not JSON"); });
  const code = data.base_resp?.status_code;
  if (code) throw new Error(`search failed: MiniMax error ${code}: ${data.base_resp.status_msg || "no message"}`);
  if (data.error) throw new Error(`search failed: ${data.error.message || JSON.stringify(data.error)}`);
  const items = data.organic || data.results || data.data || [];
  return items.slice(0, MAX_RESULTS).map((r) => ({ title: r.title || null, url: r.link || r.url || null,
    snippet: (r.snippet || r.content || "").slice(0, 300), date: r.date || null }));
}
