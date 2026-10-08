// Chart colours and fonts come from the CSS tokens of the active theme
// (DESIGN § 7), so charts re-theme live with everything else.

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export function chartTokens() {
  return {
    surface: css("--surface"),
    surface2: css("--surface-2"),
    text: css("--text"),
    text2: css("--text-2"),
    muted: css("--text-muted"),
    grid: css("--grid"),
    axis: css("--axis"),
    border: css("--border"),
    accent: css("--accent"),
    gain: css("--gain"),
    loss: css("--loss"),
    divNeg: css("--div-neg"),
    divMid: css("--div-mid"),
    divPos: css("--div-pos"),
    series: Array.from({ length: 8 }, (_, i) => css(`--series-${i + 1}`)),
    other: css("--series-other"),
    fontUi: css("--font-ui"),
    fontMono: css("--font-mono"),
    fontSize: parseFloat(css("--fs-xs")) || 11,
    scheme: document.documentElement.dataset.scheme,
  };
}

/** Resolve a `var(--x)` string (as returned by seriesColour) to a concrete colour. */
export function resolveColour(value) {
  const m = /^var\((--[\w-]+)\)$/.exec(value || "");
  return m ? css(m[1]) : value;
}

/** Call fn() whenever the theme/density/palette changes. Returns an unsubscribe. */
export function onThemeChange(fn) {
  document.addEventListener("iv:themechange", fn);
  return () => document.removeEventListener("iv:themechange", fn);
}

/** "#rrggbb" / "rgb(…)" / "rgba(…)" + alpha (0–1) -> "rgba(r, g, b, a)".
 *  Plain rgba because canvas chart libraries parse colours themselves. */
export function withAlpha(colour, alpha) {
  const c = colour.trim();
  let rgb;
  if (c.startsWith("#")) {
    const hex = c.length === 4 ? [...c.slice(1)].map((x) => x + x).join("") : c.slice(1, 7);
    rgb = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
  } else {
    rgb = (c.match(/[\d.]+/g) || [0, 0, 0]).slice(0, 3).map(Number);
  }
  return `rgba(${rgb.join(", ")}, ${alpha})`;
}
