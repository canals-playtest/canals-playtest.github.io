// Sends finished-game reports to the designer, for playtest analysis.
//
// The published site carries the address of a small Cloudflare Worker
// (tools/report-worker/) in web/site.json, written by tools/build_site.sh.
// Each finished game is queued in this browser and posted there; anything that
// fails to send is retried the next time the page opens. Nothing is sent when
// there is no address (local play from the repository) or the player has
// switched sharing off. ?report=URL overrides the address, for testing.

const QUEUE = "canals.reportQueue";
const SHARE = "canals.shareReports";
const MAX_QUEUED = 20;

let config = null;
async function siteConfig() {
  if (config) return config;
  try {
    const res = await fetch(new URL("../site.json", import.meta.url), { cache: "no-store" });
    config = res.ok ? await res.json() : {};
  } catch { config = {}; }
  const override = new URLSearchParams(location.search).get("report");
  if (override) config = { ...config, reportUrl: override };
  return config;
}

const read = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k)); return v ?? d; } catch { return d; } };
const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } };

/** Whether this browser shares its finished games (on unless switched off). */
export const sharing = () => read(SHARE, true) !== false;
export const setSharing = (on) => write(SHARE, !!on);

/** Is reporting set up for this site? */
export async function reportingAvailable() { return !!(await siteConfig()).reportUrl; }

/** The site's build, to tell reports from different versions apart. */
export async function siteVersion() { return (await siteConfig()).version || null; }

/** Queue a finished game's report and try to send everything queued. */
export async function submitReport(rep) {
  if (!sharing()) return { sent: 0, queued: 0, off: true };
  const q = read(QUEUE, []).filter((x) => x.id !== rep.id);
  q.push({ id: rep.id, rep });
  write(QUEUE, q.slice(-MAX_QUEUED));
  return flushReports();
}

let flushing = null;
/** Send whatever is queued; reports that fail stay for next time. */
export function flushReports() {
  if (flushing) return flushing;
  flushing = (async () => {
    const url = (await siteConfig()).reportUrl;
    let q = read(QUEUE, []), sent = 0;
    if (!url || !q.length || !sharing()) return { sent, queued: q.length };
    for (const item of [...q]) {
      try {
        const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(item.rep) });
        if (!res.ok && res.status !== 400 && res.status !== 413) continue;   // keep it and retry later
        // Sent, or refused for good (malformed or too large): either way it leaves the queue.
        q = q.filter((x) => x.id !== item.id);
        write(QUEUE, q);
        if (res.ok) sent++;
      } catch { /* offline: retry later */ }
    }
    return { sent, queued: q.length };
  })().finally(() => { flushing = null; });
  return flushing;
}
