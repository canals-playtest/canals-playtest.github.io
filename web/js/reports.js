// Sends finished-game reports to the designer, for playtest analysis.
//
// The published site carries the address of a small Cloudflare Worker
// (tools/report-worker/) in web/site.json, written by tools/build_site.sh.
// Each finished game is queued in this browser and posted there; anything that
// fails to send is retried the next time the page opens. Nothing is sent when
// there is no address (local play from the repository) or the player has
// switched sharing off. ?report=URL overrides the address, for testing.

const QUEUE = "canals.reportQueue";
const LAST = "canals.reportLast";       // { at, ok, status, error } of the last attempt
const SHARE = "canals.shareReports";
const MAX_QUEUED = 20;

let site = null;
async function siteConfig() {
  if (site) return site;
  try {
    const res = await fetch(new URL("../site.json", import.meta.url), { cache: "no-store" });
    site = res.ok ? await res.json() : {};
  } catch { site = {}; }
  const override = new URLSearchParams(location.search).get("report");
  if (override) site = { ...site, reportUrl: override };
  // Without a scheme the browser would post to a path on this site instead.
  if (site.reportUrl && !/^[a-z]+:\/\//i.test(site.reportUrl)) site = { ...site, reportUrl: `https://${site.reportUrl}` };
  return site;
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

/** How many reports wait in this browser, and how the last attempt went. */
export function reportStatus() {
  return { queued: read(QUEUE, []).length, last: read(LAST, null) };
}

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
        let why = "";
        if (!res.ok) { try { const j = await res.json(); why = [j.error, j.detail].filter(Boolean).join(": "); } catch { why = res.statusText; } }
        write(LAST, { at: Date.now(), ok: res.ok, status: res.status, error: res.ok ? null : `${res.status} ${why}`.trim() });
        if (!res.ok && res.status !== 400 && res.status !== 413) continue;   // keep it and retry later
        // Sent, or refused for good (malformed or too large): either way it leaves the queue.
        q = q.filter((x) => x.id !== item.id);
        write(QUEUE, q);
        if (res.ok) sent++;
      } catch (err) {
        // Offline, or the Worker refused this site (the browser then hides its reply): retry later.
        write(LAST, { at: Date.now(), ok: false, status: 0, error: `couldn't reach the report service (${err.message || err}); offline, or ALLOWED_ORIGINS doesn't match this site` });
      }
    }
    return { sent, queued: q.length };
  })().finally(() => { flushing = null; });
  return flushing;
}
