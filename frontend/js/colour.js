// Colour maths for the theme editor (DESIGN § 7): parse, OKLab ΔE, colour-vision
// deficiency simulation and WCAG contrast. Used to warn about palettes whose
// colours are hard to tell apart; warnings never block saving.

/** "#rgb" / "#rrggbb" / "rgb(a)(…)" -> [r, g, b] in 0–255, or null. Alpha is ignored. */
export function parseColour(value) {
  const c = String(value || "").trim();
  if (/^#[0-9a-f]{3}$/i.test(c)) return [...c.slice(1)].map((x) => parseInt(x + x, 16));
  if (/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(c)) return [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
  const m = c.match(/^rgba?\(([^)]+)\)$/i);
  if (m) {
    const parts = m[1].split(/[\s,/]+/).filter(Boolean).slice(0, 3).map(Number);
    if (parts.length === 3 && parts.every(Number.isFinite)) return parts.map((v) => Math.max(0, Math.min(255, Math.round(v))));
  }
  return null;
}

export const toHex = (rgb) => `#${rgb.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;

/** Any CSS colour the browser understands -> "#rrggbb" (via a canvas), or null. */
export function cssToHex(value) {
  const rgb = parseColour(value);
  if (rgb) return toHex(rgb);
  const ctx = document.createElement("canvas").getContext("2d");
  ctx.fillStyle = "#000001";
  ctx.fillStyle = value;
  return ctx.fillStyle === "#000001" ? null : cssToHex(ctx.fillStyle);
}

/** A translucent "rgba(…, a)" flattened onto `bg` -> "#rrggbb" (what the eye sees). */
export function opaqueHex(value, bg) {
  const a = Number(/^rgba\([^)]*[,/]\s*([\d.]+)\s*\)$/i.exec(String(value).trim())?.[1] ?? 1);
  const fg = parseColour(value) || parseColour(cssToHex(value) || "");
  const base = parseColour(cssToHex(bg) || "#000000");
  if (!fg) return null;
  return toHex(fg.map((c, i) => c * a + base[i] * (1 - a)));
}

const toLinear =(v) => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const linearRgb = (rgb) => rgb.map(toLinear);

/** Linear sRGB -> OKLab (Björn Ottosson). */
function oklab([r, g, b]) {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
  ];
}

// Machado, Oliveira & Fernandes (2009), severity 1.0, applied in linear RGB.
const CVD = {
  protan: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
  deutan: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.011820, 0.042940, 0.968881]],
  tritan: [[1.255528, -0.076749, -0.178779], [-0.078411, 0.930809, 0.147602], [0.004733, 0.691367, 0.303900]],
};
export const VISIONS = { normal: "Normal vision", protan: "Protanopia", deutan: "Deuteranopia", tritan: "Tritanopia" };

function simulate(lin, vision) {
  const m = CVD[vision];
  if (!m) return lin;
  return m.map((row) => Math.max(0, Math.min(1, row[0] * lin[0] + row[1] * lin[1] + row[2] * lin[2])));
}

/** How `colour` looks with `vision`, as "#rrggbb" (for the simulated swatch strips). */
export function simulateHex(colour, vision) {
  const lin = simulate(linearRgb(parseColour(colour)), vision);
  return toHex(lin.map((c) => 255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055)));
}

/** OKLab distance ×100 between two colours as seen with `vision`. */
export function deltaE(a, b, vision = "normal") {
  const [p, q] = [a, b].map((c) => oklab(simulate(linearRgb(parseColour(c)), vision)));
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) * 100;
}

/** WCAG 2 contrast ratio (1–21). */
export function contrast(a, b) {
  const lum = (c) => { const [r, g, bl] = linearRgb(parseColour(c)); return 0.2126 * r + 0.7152 * g + 0.0722 * bl; };
  const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
}

export const LIMITS = { cvd: 8, normal: 15, contrast: 3 };

/**
 * Check a categorical palette against DESIGN § 7: adjacent colours must stay apart
 * (OKLab ΔE ≥ 8 under protan/deutan/tritan simulation, ≥ 15 for normal vision) and
 * each colour needs 3:1 contrast against the chart surface.
 */
export function checkPalette(colours, surface) {
  const valid = colours.filter((c) => parseColour(c));
  const pairs = [];
  for (let i = 0; i < valid.length - 1; i++) {
    const row = { a: i, b: i + 1 };
    for (const v of Object.keys(VISIONS)) row[v] = deltaE(valid[i], valid[i + 1], v);
    pairs.push(row);
  }
  const contrasts = valid.map((c) => contrast(c, surface));
  const warnings = [];
  for (const p of pairs) {
    const n = `${p.a + 1} and ${p.b + 1}`;
    if (p.normal < LIMITS.normal) warnings.push(`Colours ${n} look alike (ΔE ${p.normal.toFixed(1)}, want ≥ ${LIMITS.normal}).`);
    for (const v of ["protan", "deutan", "tritan"]) {
      if (p[v] < LIMITS.cvd) warnings.push(`Colours ${n} merge with ${VISIONS[v].toLowerCase()} (ΔE ${p[v].toFixed(1)}, want ≥ ${LIMITS.cvd}).`);
    }
  }
  contrasts.forEach((r, i) => {
    if (r < LIMITS.contrast) warnings.push(`Colour ${i + 1} is faint on the chart surface (${r.toFixed(2)}:1, want ≥ ${LIMITS.contrast}:1) — keep the legend or table view.`);
  });
  return { pairs, contrasts, warnings };
}
