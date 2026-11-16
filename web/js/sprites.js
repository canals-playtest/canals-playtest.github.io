// Sprite sheet: simple storybook art, drawn as SVG symbols once per page and
// referenced with <use href="#id">. Inked outlines, flat warm colours.
// Anything tinted per player reads the CSS custom property --pc, which <use>
// passes through, so one symbol serves every seat.

const INK = "#3a2a1c";
const CREAM = "#f6ead0";
const NS = "http://www.w3.org/2000/svg";

const o = `stroke="${INK}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"`;
const thin = `stroke="${INK}" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round"`;

// viewBox 0 0 32 32 unless noted.
const SYMBOLS = {
  // --- action roles ------------------------------------------------------
  "i-dig": `<path d="M13 19 L24 8" ${o} stroke-width="3"/><path d="M21 5 l6 6" ${o} stroke-width="3"/>
    <path d="M10 15 l7 7 l-6 6 q-5 1 -7 -1 q-2 -2 -1 -7 z" fill="#c9c4b8" ${o}/>`,
  "i-build": `<path d="M9 26 L19 14" ${o} stroke-width="3.2"/><path d="M15 8 l10 0 l2 3 l-2 3 l-10 0 l-2 -3 z" transform="rotate(40 20 11)" fill="#9aa3a8" ${o}/>`,
  "i-buy": `<path d="M6 13 h20 l-3 13 h-14 z" fill="#d9a35b" ${o}/><path d="M10 13 q6 -10 12 0" fill="none" ${o}/>
    <path d="M9 17 h14 M10 21 h12" ${thin} opacity=".7"/>`,
  "i-earn": `<ellipse cx="16" cy="24" rx="9" ry="3.5" fill="#e9b949" ${o}/><path d="M7 24 v-4" ${o}/><path d="M25 24 v-4" ${o}/>
    <ellipse cx="16" cy="20" rx="9" ry="3.5" fill="#f2c94c" ${o}/><ellipse cx="16" cy="14" rx="7" ry="3" fill="#f2c94c" ${o}/>
    <path d="M9 14 v-3 M23 14 v-3" ${thin}/><ellipse cx="16" cy="11" rx="7" ry="3" fill="#f7d978" ${o}/>`,
  "i-special": `<path d="M16 4 l3.2 7.6 l8 .6 l-6.2 5.2 l2 7.8 l-7 -4.4 l-7 4.4 l2 -7.8 l-6.2 -5.2 l8 -.6 z" fill="#c9a4e0" ${o}/>
    <circle cx="16" cy="15" r="2.2" fill="${CREAM}" ${thin}/>`,

  // --- tokens ------------------------------------------------------------
  "i-coin": `<circle cx="16" cy="16" r="11" fill="#f2c94c" ${o}/><circle cx="16" cy="16" r="7" fill="none" stroke="#b8862b" stroke-width="1.6"/>`,
  "i-pearl": `<path d="M5 22 q11 9 22 0 q-11 4 -22 0 z" fill="#e8c9b8" ${thin}/><circle cx="16" cy="15" r="8" fill="#fbf7f2" ${o}/>
    <circle cx="13" cy="12" r="2.4" fill="#fff" opacity=".9"/>`,
  "i-key": `<circle cx="10" cy="16" r="6" fill="#e3b505" ${o}/><circle cx="10" cy="16" r="2.2" fill="${CREAM}" ${thin}/>
    <path d="M16 16 h12 v4 M24 16 v3" fill="none" ${o} stroke-width="2.6"/>`,
  "i-income": `<circle cx="16" cy="18" r="9" fill="#f2c94c" ${o}/><path d="M16 23 v-9 M12 17 l4 -4 l4 4" fill="none" ${o} stroke="#7a5212"/>
    <path d="M22 9 q3 -5 7 -4 q-1 5 -6 6" fill="#7fb069" ${thin}/>`,
  "i-reach": `<path d="M5 22 h22 l-4 5 h-14 z" fill="#b5835a" ${o}/><path d="M16 21 v-16" ${o}/><path d="M17 6 l8 13 h-8 z" fill="${CREAM}" ${o}/>
    <path d="M15 9 l-7 10 h7 z" fill="#e7d3a8" ${o}/>`,
  "i-hand": `<rect x="6" y="9" width="11" height="16" rx="2" transform="rotate(-14 11 17)" fill="${CREAM}" ${o}/>
    <rect x="11" y="7" width="11" height="16" rx="2" fill="#efe0bd" ${o}/><rect x="16" y="9" width="11" height="16" rx="2" transform="rotate(14 21 17)" fill="${CREAM}" ${o}/>`,
  "i-deck": `<rect x="9" y="9" width="15" height="19" rx="2" fill="#c7b48d" ${o}/><rect x="7" y="6" width="15" height="19" rx="2" fill="${CREAM}" ${o}/>
    <path d="M11 12 h7 M11 16 h7" ${thin} opacity=".6"/>`,
  "i-vp": `<path d="M9 22 q-6 -8 0 -16 M23 22 q6 -8 0 -16" fill="none" stroke="#5e8c4a" stroke-width="3" stroke-linecap="round"/>
    <path d="M7 9 l-3 -1 M6 13 l-3 0 M7 17 l-3 1 M25 9 l3 -1 M26 13 l3 0 M25 17 l3 1" stroke="#5e8c4a" stroke-width="2.2" stroke-linecap="round"/>
    <circle cx="16" cy="14" r="6" fill="#e3b505" ${o}/>`,
  "i-trash": `<path d="M9 10 h14 l-1.5 16 h-11 z" fill="#b9b2a2" ${o}/><path d="M7 10 h18 M13 10 v-3 h6 v3" fill="none" ${o}/>`,

  // --- resource cubes (isometric) ------------------------------------------
  ...Object.fromEntries([["clay", "#c96f4a", "#a6532f", "#e0906b"], ["wood", "#9a6a3a", "#7a5029", "#b98a55"], ["stone", "#a3a6a8", "#7f8386", "#c6c8c9"]]
    .map(([k, side, dark, top]) => [`cube-${k}`,
      `<path d="M16 5 l10 5 l-10 5 l-10 -5 z" fill="${top}" ${thin}/><path d="M6 10 l10 5 v12 l-10 -5 z" fill="${side}" ${thin}/>
       <path d="M26 10 l-10 5 v12 l10 -5 z" fill="${dark}" ${thin}/>`])),

  // --- map features --------------------------------------------------------
  "m-forest": `<path d="M8 27 v-4 M17 26 v-4 M25 27 v-4" ${o}/>
    <path d="M8 23 l-5 0 l5 -9 l-3.5 0 l3.5 -7 l3.5 7 l-3.5 0 l5 9 z" fill="#4f7d3a" ${thin}/>
    <path d="M25 23 l-5 0 l5 -9 l-3.5 0 l3.5 -7 l3.5 7 l-3.5 0 l5 9 z" fill="#5d8f45" ${thin}/>
    <path d="M17 22 l-6 0 l6 -10 l-4 0 l4 -8 l4 8 l-4 0 l6 10 z" fill="#3f6b2e" ${thin}/>`,
  "m-mountain": `<path d="M2 27 l9 -16 l5 7 l5 -12 l9 21 z" fill="#9b9690" ${o}/>
    <path d="M18 11 l3 -5 l3 7 l-2 -1 l-2 2 z" fill="#f4f1ea" ${thin}/><path d="M9 15 l2 -4 l2 3 l-2 0 z" fill="#f4f1ea" ${thin}/>`,
  "m-clay": `<path d="M3 26 q3 -9 13 -10 q10 1 13 10 z" fill="#c96f4a" ${o}/>
    <path d="M9 22 q4 -3 7 -1 M17 24 q4 -3 7 0" fill="none" stroke="#8a4628" stroke-width="1.3" stroke-linecap="round"/>
    <rect x="18" y="9" width="8" height="5" rx="1" fill="#d98861" ${thin}/><rect x="13" y="12" width="8" height="5" rx="1" fill="#c96f4a" ${thin}/>`,
  "m-harbour": `<path d="M3 22 q4 -3 8 0 t8 0 t8 0" fill="none" stroke="#2b6f93" stroke-width="2" stroke-linecap="round"/>
    <path d="M6 18 h20 v4 h-20 z" fill="#b5835a" ${o}/><path d="M9 22 v6 M16 22 v6 M23 22 v6" ${o}/>
    <path d="M22 18 v-13" ${o}/><path d="M22 6 l7 3 l-7 3 z" fill="#d1495b" ${thin}/><path d="M9 18 h5 v-4 h-5 z" fill="${CREAM}" ${thin}/>`,
  "m-key": `<circle cx="16" cy="16" r="13" fill="#fbe7a1" ${o}/><g transform="translate(16 16) scale(.62) translate(-16 -16)">
    <circle cx="10" cy="16" r="6" fill="#e3b505" ${o}/><circle cx="10" cy="16" r="2.2" fill="${CREAM}" ${thin}/>
    <path d="M16 16 h12 v4 M24 16 v3" fill="none" ${o} stroke-width="2.6"/></g>`,
  "m-discovery": `<circle cx="16" cy="16" r="13" fill="#efe1f6" ${o}/><circle cx="16" cy="16" r="10" fill="none" stroke="#7b4d9a" stroke-width="1.2" stroke-dasharray="2 2"/>`,
  "m-site": `<path d="M9 22 l7 -4 l7 4 l-7 4 z" fill="none" stroke="${INK}" stroke-width="1.2" stroke-dasharray="2 1.6" opacity=".55"/>
    <path d="M16 22 v-10" stroke="${INK}" stroke-width="1.3" opacity=".55"/><path d="M16 12 l5 2 l-5 2" fill="#fff6" stroke="${INK}" stroke-width="1" opacity=".55"/>`,

  // --- buildings: walls cream, roofs and doors in the owner's colour --------
  "b-burrow": `<path d="M3 27 q0 -16 13 -16 q13 0 13 16 z" fill="#8bb174" ${o}/><path d="M11 27 q0 -9 5 -9 q5 0 5 9 z" fill="var(--pc,#888)" ${o}/>
    <circle cx="19" cy="23" r="1" fill="${INK}"/>`,
  "b-mill": `<path d="M10 28 l2 -14 h8 l2 14 z" fill="${CREAM}" ${o}/><path d="M9 15 l7 -6 l7 6 z" fill="var(--pc,#888)" ${o}/>
    <g ${thin} fill="#f4ecd8"><path d="M16 10 l-8 -7 l-2 2 z"/><path d="M16 10 l8 -7 l2 2 z"/><path d="M16 10 l-9 6 l2 2 z"/><path d="M16 10 l9 6 l-2 2 z"/></g>
    <circle cx="16" cy="10" r="1.6" fill="${INK}"/><path d="M14 28 v-5 h4 v5" fill="var(--pc,#888)" ${thin}/>`,
  "b-wharf": `<path d="M2 26 q4 -3 7 0 t7 0 t7 0 t7 0" fill="none" stroke="#2b6f93" stroke-width="2" stroke-linecap="round"/>
    <path d="M4 21 h24 v3 h-24 z" fill="#b5835a" ${o}/><path d="M7 21 v-8 h12 v8" fill="${CREAM}" ${o}/>
    <path d="M5 14 l8 -6 l8 6 z" fill="var(--pc,#888)" ${o}/><path d="M24 21 v-12 M24 10 l4 2 l-4 2" fill="none" ${thin}/><rect x="11" y="16" width="4" height="5" fill="var(--pc,#888)" ${thin}/>`,
  "b-inn": `<path d="M6 28 v-12 h16 v12 z" fill="${CREAM}" ${o}/><path d="M4 17 l10 -9 l10 9 z" fill="var(--pc,#888)" ${o}/>
    <path d="M22 18 h6 v3" fill="none" ${thin}/><rect x="25" y="21" width="5" height="5" rx="1" fill="#e3b505" ${thin}/>
    <rect x="11" y="21" width="5" height="7" fill="var(--pc,#888)" ${thin}/><path d="M8 19 h2 v2 h-2 z M18 19 h2 v2 h-2 z" fill="#f2c94c" ${thin}/>`,
  "b-camp": `<path d="M4 27 l9 -16 l9 16 z" fill="var(--pc,#888)" ${o}/><path d="M13 27 l0 -10 l3 10" fill="${CREAM}" ${thin}/>
    <rect x="20" y="22" width="10" height="4" rx="2" fill="#9a6a3a" ${thin}/><circle cx="29" cy="24" r="2" fill="#d6a46b" ${thin}/>
    <path d="M24 21 l4 -7" ${o}/><path d="M26 14 l4 1 l-1 3 z" fill="#b7b2a6" ${thin}/>`,
  "b-quarry": `<path d="M3 28 l4 -12 h14 l6 12 z" fill="#a3a6a8" ${o}/><path d="M9 21 h7 M14 25 h8" ${thin}/>
    <path d="M14 15 l10 -10" ${o} stroke-width="2.6"/><path d="M19 4 q6 0 9 5 q-5 -2 -9 -1 z" fill="#c9c4b8" ${thin}/>
    <rect x="22" y="18" width="7" height="6" fill="var(--pc,#888)" ${thin}/>`,
  "b-pit": `<path d="M6 28 v-10 q0 -8 8 -8 q8 0 8 8 v10 z" fill="#c96f4a" ${o}/><path d="M10 28 v-6 q0 -4 4 -4 q4 0 4 4 v6 z" fill="#4a2b1c" ${thin}/>
    <path d="M12 26 q2 -4 4 0" fill="#f2c94c" stroke="none"/><path d="M19 10 v-5 h4 v8" fill="var(--pc,#888)" ${thin}/><path d="M21 4 q2 -2 1 -4" fill="none" stroke="#9b9690" stroke-width="1.4"/>`,
  "b-digger": `<path d="M3 27 l8 -13 l8 13 z" fill="var(--pc,#888)" ${o}/><path d="M11 27 v-8" ${thin}/>
    <path d="M22 27 v-10" ${o} stroke-width="2.4"/><path d="M19 27 h6 l-1 3 h-4 z" fill="#b7b2a6" ${thin}/><path d="M20 13 h4" ${o}/>
    <path d="M24 27 q3 -3 6 0" fill="#9a6a3a" ${thin}/>`,
  "b-surveyor": `<path d="M10 28 v-17 h10 v17 z" fill="${CREAM}" ${o}/><path d="M8 12 l7 -7 l7 7 z" fill="var(--pc,#888)" ${o}/>
    <rect x="13" y="15" width="4" height="4" fill="#9cc9e0" ${thin}/><path d="M20 17 l9 -4" ${o} stroke-width="2.6"/>
    <circle cx="29" cy="13" r="1.6" fill="#9cc9e0" ${thin}/><path d="M13 28 v-5 h4 v5" fill="var(--pc,#888)" ${thin}/>`,
  "b-hub": `<path d="M3 28 v-12 l9 -6 l9 6 v12 z" fill="${CREAM}" ${o}/><path d="M2 16 l10 -7 l10 7" fill="none" stroke="var(--pc,#888)" stroke-width="3" stroke-linejoin="round"/>
    <path d="M7 28 v-7 h10 v7" fill="var(--pc,#888)" ${thin}/><rect x="21" y="20" width="8" height="8" fill="#b5835a" ${thin}/>
    <path d="M21 20 l8 8 M29 20 l-8 8" stroke="${INK}" stroke-width="1"/><rect x="23" y="13" width="6" height="7" fill="#c99a6a" ${thin}/>`,
  "b-plain": `<path d="M6 28 v-12 h20 v12 z" fill="${CREAM}" ${o}/><path d="M4 17 l12 -10 l12 10 z" fill="var(--pc,#888)" ${o}/>
    <rect x="13" y="20" width="6" height="8" fill="var(--pc,#888)" ${thin}/>`,
};

// Player crests, viewBox 0 0 40 40: an animal head on a badge of the seat's colour.
const CREST_BODY = {
  hare: `<path d="M14 18 q-4 -14 0 -15 q4 1 3 15 z M26 18 q4 -14 0 -15 q-4 1 -3 15 z" fill="${CREAM}" ${o}/>
    <path d="M15 16 q-2 -8 0 -9 M25 16 q2 -8 0 -9" stroke="#e8a9a0" stroke-width="2" fill="none"/>
    <ellipse cx="20" cy="25" rx="10" ry="9" fill="${CREAM}" ${o}/>`,
  heron: `<path d="M12 33 q-2 -14 8 -18 q8 -2 10 4 l8 2 l-8 2 q-2 8 -10 12 z" fill="#dfe7ec" ${o}/>
    <path d="M22 15 q-6 -4 -10 -1" fill="none" ${o}/><path d="M30 19 l8 2 l-8 1 z" fill="#e3b505" ${thin}/>`,
  duck: `<circle cx="18" cy="22" r="10" fill="#7fb069" ${o}/><path d="M26 22 q8 -1 9 3 q-5 3 -10 1 z" fill="#f2a541" ${o}/>
    <path d="M11 29 q7 4 14 0" fill="none" stroke="${CREAM}" stroke-width="2.4"/>`,
  frog: `<ellipse cx="20" cy="25" rx="13" ry="9" fill="#8bc34a" ${o}/><circle cx="13" cy="16" r="5" fill="#8bc34a" ${o}/><circle cx="27" cy="16" r="5" fill="#8bc34a" ${o}/>
    <path d="M12 27 q8 5 16 0" fill="none" ${thin}/>`,
  hedgehog: `<path d="M6 30 l1 -6 l-4 -2 l5 -3 l-2 -5 l6 0 l1 -6 l5 3 l4 -5 l3 5 l6 -2 l-1 6 l5 1 l-3 4 z" fill="#8a6a4f" ${o}/>
    <path d="M20 31 q-6 -11 6 -12 q8 1 9 8 q-3 4 -15 4 z" fill="#e8cfa6" ${o}/><circle cx="35" cy="27" r="1.6" fill="${INK}"/>`,
};
const EYES = {
  hare: [[16, 23], [24, 23]], heron: [[25, 18]], duck: [[22, 19]], frog: [[13, 15.5], [27, 15.5]], hedgehog: [[29, 23]],
};
export const CRESTS = ["hare", "heron", "duck", "frog", "hedgehog"];
for (const name of CRESTS) {
  const eyes = EYES[name].map(([x, y]) => `<circle cx="${x}" cy="${y}" r="1.8" fill="${INK}"/><circle cx="${x + 0.6}" cy="${y - 0.6}" r=".6" fill="#fff"/>`).join("");
  SYMBOLS[`crest-${name}`] = `<circle cx="20" cy="20" r="18" fill="var(--pc,#888)" ${o}/>
    <g clip-path="url(#crest-clip)">${CREST_BODY[name]}${eyes}</g><circle cx="20" cy="20" r="18" fill="none" ${o}/>`;
}
const VIEWBOX = Object.fromEntries(CRESTS.map((n) => [`crest-${n}`, "0 0 40 40"]));

// Terrain fills: a base colour and a light repeating texture.
const PATTERNS = `
  <clipPath id="crest-clip"><circle cx="20" cy="20" r="17"/></clipPath>
  <pattern id="pat-sea" width="24" height="14" patternUnits="userSpaceOnUse">
    <rect width="24" height="14" fill="#9fcbe0"/>
    <path d="M1 8 q3 -3 6 0 t6 0" fill="none" stroke="#d6ebf4" stroke-width="1.2" stroke-linecap="round"/>
    <path d="M13 2 q2 -2 4 0" fill="none" stroke="#c4e0ec" stroke-width="1" stroke-linecap="round"/></pattern>
  <pattern id="pat-coastal" width="16" height="16" patternUnits="userSpaceOnUse">
    <rect width="16" height="16" fill="#ead8b1"/>
    <circle cx="3" cy="4" r=".8" fill="#c9b080"/><circle cx="11" cy="9" r=".7" fill="#c9b080"/><circle cx="6" cy="13" r=".6" fill="#d8c294"/></pattern>
  <pattern id="pat-inland" width="22" height="20" patternUnits="userSpaceOnUse">
    <rect width="22" height="20" fill="#c3d6a0"/>
    <path d="M4 9 l1 -3 M6 9 l0 -4 M8 9 l-1 -3" stroke="#90ad6a" stroke-width="1" stroke-linecap="round"/>
    <path d="M15 18 l1 -3 M17 18 l0 -4 M19 18 l-1 -3" stroke="#a3bd7c" stroke-width="1" stroke-linecap="round"/></pattern>
  <pattern id="pat-highland" width="24" height="20" patternUnits="userSpaceOnUse">
    <rect width="24" height="20" fill="#d3c4a2"/>
    <path d="M3 14 l4 -6 l4 6 M14 7 l3 -4 l3 4" fill="none" stroke="#a8946c" stroke-width="1.1" stroke-linejoin="round"/></pattern>
  <pattern id="pat-lake" width="18" height="12" patternUnits="userSpaceOnUse">
    <rect width="18" height="12" fill="#8fc3d6"/>
    <path d="M2 6 q2 -2 4 0 t4 0" fill="none" stroke="#c6e2ec" stroke-width="1" stroke-linecap="round"/></pattern>
  <pattern id="pat-crag" width="20" height="18" patternUnits="userSpaceOnUse">
    <rect width="20" height="18" fill="#a89a86"/>
    <path d="M2 15 l5 -10 l5 10 M10 15 l4 -7 l4 7" fill="#978a75" stroke="#5f523f" stroke-width="1.1" stroke-linejoin="round"/></pattern>`;

/** Install the sprite sheet once; later calls do nothing. */
export function installSprites() {
  if (document.getElementById("canals-sprites")) return;
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("id", "canals-sprites");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("style", "position:absolute;width:0;height:0;overflow:hidden");
  svg.innerHTML = `<defs>${PATTERNS}${Object.entries(SYMBOLS).map(([id, body]) =>
    `<symbol id="${id}" viewBox="${VIEWBOX[id] || "0 0 32 32"}">${body}</symbol>`).join("")}</defs>`;
  document.body.prepend(svg);
}

export const hasSymbol = (id) => id in SYMBOLS;
export const TERRAIN_PATTERN = { sea: "pat-sea", coastal: "pat-coastal", inland: "pat-inland", highland: "pat-highland", lake: "pat-lake", crag: "pat-crag" };
export const ROLE_ICON = { dig: "i-dig", build: "i-build", buy: "i-buy", earn: "i-earn", special: "i-special" };
export const crestOf = (i) => CRESTS[i % CRESTS.length];

/** An inline icon for HTML: <svg class="icon"><use href="#id"/></svg>. */
export function icon(id, cls = "", title = null, colour = null) {
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("class", `icon ${cls}`.trim());
  svg.setAttribute("viewBox", VIEWBOX[id] || "0 0 32 32");
  if (colour) svg.style.setProperty("--pc", colour);
  if (title) { svg.setAttribute("role", "img"); svg.setAttribute("aria-label", title); const t = document.createElementNS(NS, "title"); t.textContent = title; svg.append(t); }
  else svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS(NS, "use");
  use.setAttribute("href", `#${id}`);
  svg.append(use);
  return svg;
}

/** A player's crest as an inline icon. */
export function crest(player, index, cls = "") {
  return icon(`crest-${player.crest || crestOf(index)}`, `crest ${cls}`.trim(), null, player.colour);
}
