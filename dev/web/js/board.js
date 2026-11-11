// SVG rendering of the hex board. Pointy-top axial layout, matching tools/build_board.py.
import * as E from "./engine.js";
import { TERRAIN_PATTERN, hasSymbol } from "./sprites.js";

const S = 30; // circumradius in SVG units
const SQ3 = Math.sqrt(3);
const NS = "http://www.w3.org/2000/svg";

const centre = (h) => [S * SQ3 * (h.q + h.r / 2), S * 1.5 * h.r];

function el(tag, attrs = {}, parent) {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (parent) parent.appendChild(n);
  return n;
}

/** A sprite from the sheet (sprites.js), centred on x, y. */
function sprite(id, x, y, size, parent, attrs = {}) {
  return el("use", { href: `#${id}`, x: x - size / 2, y: y - size / 2, width: size, height: size, ...attrs }, parent);
}

const NEIGHBOURS = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];

function corners(cx, cy) {
  return Array.from({ length: 6 }, (_, i) => {
    const a = ((-30 + 60 * i) * Math.PI) / 180;
    return [cx + S * Math.cos(a), cy + S * Math.sin(a)];
  });
}

/** Endpoints of the border shared by hexes a and b. */
function edgeLine(a, b) {
  const [ax, ay] = centre(a), [bx, by] = centre(b);
  const th = Math.atan2(by - ay, bx - ax);
  return [-1, 1].map((s) => {
    const t = th + (s * Math.PI) / 6;
    return [ax + S * Math.cos(t), ay + S * Math.sin(t)];
  });
}

/**
 * Render the board into `svg`. `handlers` = { onDig(ek), onBuild(hk), buildType }.
 * Dig/build targets are highlighted only when the current turn can take them.
 */
export function renderBoard(svg, state, handlers) {
  svg.replaceChildren();
  const { hexes, terrain, edges } = state.board;
  const all = Object.values(hexes);
  const pts = all.map(centre);
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const pad = S + 4;
  const minX = Math.min(...xs) - pad, minY = Math.min(...ys) - pad;
  svg.setAttribute("viewBox", `${minX} ${minY} ${Math.max(...xs) + pad - minX} ${Math.max(...ys) + pad - minY}`);

  const pool = state.turn?.pool || {};
  // Targets only for the device whose turn it is (handlers.interactive: false elsewhere).
  const live = handlers.interactive !== false && !!handlers.onDig;
  const canDigAny = live && state.turn?.phase === "resolve" && pool.dig > 0;
  const canBuildAny = live && state.turn?.phase === "resolve" && pool.build > 0;
  const crossingEdges = new Set(state.crossings.flatMap((c) => c.edges));
  const showHubs = state.config.networkScore === "crossings" || state.config.endOnCrossing;
  const link = E.linkedNetwork(state);
  const net = E.networkHexes(state, link);
  const mats = state.config.materials;
  const haul = mats ? E.hauls(state, link) : undefined;
  const CAMP = { clay: "clay pit", wood: "logging camp", stone: "quarry" };

  const gHex = el("g", {}, svg), gShore = el("g", { class: "shore" }, svg), gEdge = el("g", {}, svg), gTop = el("g", {}, svg);

  // The coastline: an inked line wherever land meets water or the edge of the map.
  for (const h of all) {
    if (terrain[h.terrain].water) continue;
    for (const [dq, dr] of NEIGHBOURS) {
      const n = hexes[`${h.q + dq},${h.r + dr}`];
      if (n && !terrain[n.terrain].water) continue;
      const [[x1, y1], [x2, y2]] = edgeLine(h, { q: h.q + dq, r: h.r + dr });
      el("line", { x1, y1, x2, y2, class: n ? "coastline" : "map-edge" }, gShore);
    }
  }

  for (const h of all) {
    const [cx, cy] = centre(h);
    const t = terrain[h.terrain];
    const poly = el("polygon", {
      points: corners(cx, cy).map((p) => p.join(",")).join(" "),
      fill: TERRAIN_PATTERN[h.terrain] ? `url(#${TERRAIN_PATTERN[h.terrain]})` : t.fill,
      class: "hex" + (t.water ? " water" : ""),
    }, gHex);
    const title = [`${h.key} · ${t.name}`];
    if (!t.water) title.push(`dig ${t.digCost} · build ${t.buildCost}`);
    const owner = (state.harbours || []).indexOf(h.key);
    if (h.harbour) title.push(owner >= 0
      ? `${state.players[owner].name}'s harbour: ${state.players[owner].name}'s starting dig cards start here or from their own canals; bought dig cards may join anyone's`
      : state.harbours?.length ? "harbour (nobody's): only bought dig cards start here" : "harbour: canals may enter the land only here");
    if (h.shore) title.push("shore: beside open water, so it never counts for Reach");
    if (h.feature === "hills") title.push("hills: +1 to dig its borders; a building here scores +1 VP");
    if (h.feature === "marsh") title.push("marsh: 1 cheaper to dig, no building site, +1 Reach when opened");
    if (state.tokens?.[h.key]) title.push(`token site: ${state.tokens[h.key].name} (${state.tokens[h.key].code}) for the first building`);
    if (h.band && !t.water) title.push(`${h.band}: Reach ${E.hexReach(state, h.key)} if opened`);
    if (t.wall) title.push("crag: no site, and no canal between two crags");
    if (t.water && h.band) title.push("lake: once a linked canal reaches one of its corners, all its corners are linked");
    if (h.band === "highland" && state.config.highlandNeedsBought) title.push("highland: only bought dig cards dig here");
    if (E.inlandClosed(state) && E.isInland(state, h.key)) title.push("closed until the inland milestone: canals may run along its border with the coast, but none with inland on both sides, and nothing is built here");
    if (E.isOpened(state, h.key, net)) title.push("opened: counts for Reach for every player whose canal touches it");
    if (h.bonus) title.push(state.claimed[h.key] !== undefined
      ? `discovery ${h.bonus}: taken by ${state.players[state.claimed[h.key]].name}`
      : `discovery ${h.bonus}: the dig that opens this hex takes it`);
    if (!t.water && !(h.slots > 0)) title.push("no building site");
    const tolls = state.config.hauling === "tolls";
    if (mats && tolls && h.shore) title.push("shore: clay comes from here, free; you pay only the tolls");
    if (mats && !tolls && h.harbour) title.push("port: imported cubes come ashore here, then 1 per canal edge to haul");
    if (mats && tolls && h.material && h.material !== "clay") {
      const owner = E.extractorOwner(state, h.key), built = (state.buildings[h.key] || []).length > 0;
      title.push(owner !== undefined
        ? `${state.players[owner].name}'s ${CAMP[h.material]}: ${h.material} for anyone, never running out, ${state.config.extractionFee} each to its owner (free to them)`
        : built ? `${E.TERRAIN_WORD[h.material]}, built over: no ${h.material} here`
        : `${E.TERRAIN_WORD[h.material]}: build a ${CAMP[h.material]} here for a ${h.material} source that never runs out`);
    } else if (mats && !tolls && h.material) {
      const owner = E.extractorOwner(state, h.key), left = state.cubes[h.key] || 0;
      const built = (state.buildings[h.key] || []).length > 0;
      const typed = state.buildingTypes.length > 1, word = E.TERRAIN_WORD[h.material];
      title.push(owner !== undefined
        ? `${state.players[owner].name}'s ${CAMP[h.material]}: ${left} ${h.material} left, ${state.config.extractionFee} a cube to its owner (free to them), plus 1 per canal edge`
        : built ? `${word}, used up: the building here supplies no ${h.material}`
        : `${word}: ${typed ? `build a ${CAMP[h.material]} here to put` : `a building here becomes a ${CAMP[h.material]}, putting`} ${h.material} cubes on the hex, sold at ${state.config.extractionFee} each to its owner`);
    }
    if (h.isKey) title.push("key tile: building here gives a key");
    if (showHubs && state.hubs.includes(h.key)) title.push("hub: a canal route from water to here completes a crossing");

    if (canBuildAny && E.canBuild(state, h.key, handlers.buildType).ok) {
      poly.classList.add("target");
      const price = E.buildPrice(state, h.key, handlers.buildType, state.current, haul);
      title.push(`click to build for ${price.total}${price.picks.length ? ` (${price.picks.map((x) => E.cubeNote(state, x)).join("; ")})` : ""}`);
      poly.addEventListener("click", () => handlers.onBuild(h.key));
    }
    el("title", {}, poly).textContent = title.join("\n");

    if (E.isOpened(state, h.key, net)) poly.classList.add("opened");
    if (E.inlandClosed(state) && E.isInland(state, h.key)) poly.classList.add("locked");
    if (showHubs && state.hubs.includes(h.key)) {
      el("circle", { cx, cy, r: S * 0.62, class: "hub" + (state.crossings.some((c) => c.hub === h.key) ? " done" : "") }, gHex);
    }
    if (h.harbour) sprite("m-harbour", cx + S * 0.28, cy - S * 0.3, S * 0.78, gTop, { class: "harbour-sprite" });
    if (h.harbour && owner >= 0) {
      // Own harbours: a pennant in the owner's colour.
      const px = cx - S * 0.42, py = cy - S * 0.62;
      el("path", { d: `M${px} ${py} v${S * 0.5} M${px} ${py} l${S * 0.34} ${S * 0.1} l${-S * 0.34} ${S * 0.1} z`,
        fill: state.players[owner].colour, stroke: "#3b2a1a", "stroke-width": S * 0.035, class: "harbour-owner" }, gTop);
    }
    if (h.bonus) {
      const taken = state.claimed[h.key] !== undefined;
      const g = el("g", { class: "bonus-token" + (taken ? " claimed" : "") }, gTop);
      sprite("m-discovery", cx + S * 0.38, cy + S * 0.48, S * 0.62, g);
      el("text", { x: cx + S * 0.38, y: cy + S * 0.56, class: "bonus" }, g).textContent = h.bonus;
    }
    if (!t.water && h.slots > 0 && !(state.buildings[h.key] || []).length) {
      sprite("m-site", cx, cy + S * 0.12, S * 0.55, gHex, { class: "site" });
    }
    // Features (stage 2): hills drawn as two rounded hills, marsh as reeds over water.
    if (h.feature === "hills") {
      el("path", { d: `M${cx - S * 0.62} ${cy - S * 0.18} q${S * 0.22} ${-S * 0.34} ${S * 0.44} 0 q${S * 0.18} ${-S * 0.26} ${S * 0.36} 0`,
        fill: "#b39b6e", stroke: "#6b5636", "stroke-width": S * 0.04, class: "feature hills" }, gHex);
    } else if (h.feature === "marsh") {
      const g = el("g", { class: "feature marsh" }, gHex);
      el("ellipse", { cx, cy: cy + S * 0.1, rx: S * 0.55, ry: S * 0.2, fill: "#9fc7c9", opacity: 0.75 }, g);
      for (const dx of [-0.3, -0.1, 0.12, 0.32]) {
        el("path", { d: `M${cx + S * dx} ${cy + S * 0.12} l${S * 0.04} ${-S * 0.34}`, stroke: "#4f7a3a", "stroke-width": S * 0.05, "stroke-linecap": "round" }, g);
      }
    }
    // Site tokens (stage 2): face up; the first building here takes it.
    const tok = state.tokens?.[h.key];
    if (tok) {
      const taken = state.tokenClaimed?.[h.key] !== undefined;
      const g = el("g", { class: "site-token" + (taken ? " claimed" : "") }, gTop);
      el("rect", { x: cx - S * 0.62, y: cy - S * 0.66, width: S * 0.62, height: S * 0.34, rx: S * 0.08, fill: taken ? "#ddd4c4" : "#f6e7b8", stroke: "#7a5f2a", "stroke-width": S * 0.035 }, g);
      el("text", { x: cx - S * 0.31, y: cy - S * 0.42, class: "bonus", "font-size": S * 0.2, "text-anchor": "middle" }, g).textContent = tok.code;
      el("title", {}, g).textContent = taken ? `${tok.name} (${tok.code}), taken by ${state.players[state.tokenClaimed[h.key]].name}`
        : `${tok.name}: ${tok.code} for the first building here`;
    }
    if (mats && h.material) {
      // Trees, a peak or a clay bed, left of centre; it stays once the camp is built.
      const MAT = { clay: "m-clay", wood: "m-forest", stone: "m-mountain" };
      sprite(MAT[h.material], cx - S * 0.45, cy + S * 0.22, S * 0.72, gTop, { class: `material ${h.material}` });
    }
    if (mats && (state.cubes[h.key] || 0) > 0) {
      const g = el("g", { class: "cube-count" }, gTop);
      sprite(`cube-${h.material}`, cx - S * 0.62, cy - S * 0.22, S * 0.36, g);
      el("text", { x: cx - S * 0.34, y: cy - S * 0.12, class: "cubes" }, g).textContent = `${state.cubes[h.key]}`;
    }
    if (h.isKey) sprite("m-key", cx, cy - S * 0.44, S * 0.5, gTop, { class: "key-token" });
    (state.buildings[h.key] || []).forEach((b, i, arr) => {
      const w = S * 0.98, x = cx + (i - (arr.length - 1) / 2) * w * 0.85, y = cy + S * 0.06;
      const bt = state.buildingTypes.find((t) => t.id === b.type) || state.buildingTypes[0];
      const g = el("g", { class: "building", style: `--pc:${state.players[b.p].colour}` }, gTop);
      el("ellipse", { cx: x, cy: y + w * 0.38, rx: w * 0.42, ry: w * 0.1, class: "shadow" }, g);
      sprite(hasSymbol(`b-${bt.id}`) ? `b-${bt.id}` : "b-plain", x, y, w, g);
      el("title", {}, g).textContent = `${state.players[b.p].name}'s ${bt.name} — ${E.buildingVP(state, h.key, b)} VP now${state.buildingTypes.length > 1 ? `\n${bt.rules}` : ""}`;
    });
    if (!t.water && !h.isKey && !(state.buildings[h.key] || []).length) {
      el("text", { x: cx, y: cy - S * 0.45, class: "hex-label", fill: t.ink }, gHex).textContent = h.key;
    }
  }

  for (const e of Object.values(edges)) {
    const [[x1, y1], [x2, y2]] = edgeLine(hexes[e.a], hexes[e.b]);
    const owner = state.dug[e.key];
    if (owner !== undefined) {
      const stranded = !link.edges.has(e.key);
      // Inked banks in the digger's colour, water down the middle.
      el("line", { x1, y1, x2, y2, class: "canal-ink" }, gEdge);
      el("line", { x1, y1, x2, y2, stroke: state.players[owner].colour, class: "canal-bank" + (crossingEdges.has(e.key) ? " crossing" : "") }, gEdge);
      const l = el("line", { x1, y1, x2, y2, class: "canal-water" + (stranded ? " stranded" : "") }, gEdge);
      el("title", {}, l).textContent = `${state.players[owner].name}'s canal${stranded ? " (not yet linked to the sea)" : ""}`;
    } else if (canDigAny && E.canDig(state, e.key).ok) {
      const cost = E.digCost(state, e.key);
      // A land animal's dig away from the network: legal, but cut off until linked.
      const remote = !E.extendsNetwork(state, e.key, link);
      el("line", { x1, y1, x2, y2, class: "dig-hint" + (remote ? " remote" : "") }, gEdge);
      const hit = el("line", { x1, y1, x2, y2, class: "dig-target" }, gEdge);
      el("title", {}, hit).textContent = `dig the ${e.a} | ${e.b} border for ${cost}${remote ? " (away from the network: cut off until someone links it to the sea)" : ""}`;
      hit.addEventListener("click", () => handlers.onDig(e.key));
    }
  }

  // Harbour mouths: the corners where canals start. A corner sits at the
  // centroid of the three hex centres that meet there.
  for (const c of E.harbourMouths(state)) {
    const pts = c.split("/").map((k) => { const [q, r] = k.split(",").map(Number); return centre({ q, r }); });
    const x = pts.reduce((a, p) => a + p[0], 0) / 3, y = pts.reduce((a, p) => a + p[1], 0) / 3;
    const owner = (state.harbours || []).findIndex((hk) => c.split("/").includes(hk));
    const dot = el("circle", { cx: x, cy: y, r: S * 0.14, class: "mouth" }, gTop);
    if (owner >= 0) dot.setAttribute("style", `stroke: ${state.players[owner].colour}`);
    el("title", {}, dot).textContent = owner >= 0 ? `${state.players[owner].name}'s harbour mouth: canals start here` : "harbour mouth: canals start here";
  }
}
