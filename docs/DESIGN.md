# IndexVault — Design System

**Direction:** "quiet terminal". Dense, precise and calm, like a Bloomberg terminal redrawn
by Linear. Numbers are the hero. Chrome recedes, and colour is reserved for data and state.
It should feel fast: every interaction answers within 100 ms (a skeleton, a pressed state
or a transition).

---

## 1. Tokens
All styling uses CSS custom properties from `frontend/css/tokens.css`. Themes are
defined as `[data-theme="<name>"]` blocks on `<html>`. Settings write
`data-theme`, `data-density`, `data-radius` and `data-motion`, plus an optional
`--accent` override.

### 1.1 Colour roles (every theme defines all of these)
| Token | Role |
|---|---|
| `--bg` | page background |
| `--surface` | cards, panels, chart surface |
| `--surface-2` | inputs, table header, hover wash |
| `--surface-3` | selected rows, active nav |
| `--border` | 1px hairlines |
| `--text` / `--text-2` / `--text-muted` | primary / secondary / muted ink |
| `--accent` / `--accent-fg` / `--accent-soft` | interactive elements (buttons, focus, links, selection) |
| `--gain` / `--loss` | positive / negative numbers (always paired with ▲▼ or a +/− sign) |
| `--good` `--warning` `--serious` `--critical` | status (always icon + label) |
| `--grid` / `--axis` | chart gridlines / axis lines |
| `--series-1 … --series-8` | categorical chart colours (validated, see § 7) |
| `--div-neg` / `--div-mid` / `--div-pos` | diverging heatmap poles and neutral midpoint |
| `--focus` | focus ring colour |

### 1.2 Built-in themes
| Token | **Midnight** (default, dark) | **Paper** (light) | **Terminal** (dark) | **Saffron** (light) |
|---|---|---|---|---|
| `--bg` | `#0b0e14` | `#f9f9f7` | `#000000` | `#fbf7f0` |
| `--surface` | `#121722` | `#fcfcfb` | `#0a0a0a` | `#fffdf9` |
| `--surface-2` | `#182030` | `#f0efec` | `#141414` | `#f4ede1` |
| `--surface-3` | `#1f2940` | `#e6e4df` | `#1f1f1f` | `#ebe1d0` |
| `--border` | `rgba(255,255,255,.08)` | `rgba(11,11,11,.10)` | `#262626` | `rgba(31,26,20,.12)` |
| `--text` | `#e8ebf1` | `#0b0b0b` | `#f5f5f5` | `#1f1a14` |
| `--text-2` | `#a3acbd` | `#52514e` | `#c8c8c8` | `#5c5246` |
| `--text-muted` | `#6b7488` | `#898781` | `#7a7a7a` | `#8f8577` |
| `--accent` | `#5b8cff` | `#2a78d6` | `#ffb000` | `#d9630a` |
| `--gain` | `#2fbf71` | `#0f7b3f` | `#33d17a` | `#138808` |
| `--loss` | `#f0616d` | `#c62f3b` | `#ff5c57` | `#c0392b` |
| `--grid` | `#1d2433` | `#e1e0d9` | `#1a1a1a` | `#ece3d4` |
| `--axis` | `#2c3548` | `#c3c2b7` | `#333333` | `#d8ccb8` |
| series set | dark | light | dark | light |
| UI font | Inter | Inter | JetBrains Mono (everything) | Inter |

Status colours are fixed across themes: good `#0ca30c`, warning `#fab219`, serious `#ec835a`,
critical `#d03b3b`.

**Gain/loss setting:** "Market (green/red)" is the default. "Colour-blind safe (blue/red)"
sets `--gain` to `--series-1`. Either way, never rely on colour alone: always show a sign
or an arrow.

**Theme + mode (decided in M2):** each built-in theme has a counterpart in the other
scheme — Midnight ↔ Paper, Terminal ↔ Saffron. `appearance.theme` is the one you pick;
`appearance.mode` (light / dark / system) shows its counterpart when the schemes differ,
so the top-bar sun/moon toggle always does something visible. Custom themes use their
base theme's scheme (their token overrides apply only in that scheme).

### 1.3 Typography
- UI: **Inter** (self-hosted, variable), with `font-feature-settings: "cv11", "ss01"`.
- Numbers: **JetBrains Mono** or Inter with `font-variant-numeric: tabular-nums`. Use the
  mono font in tables, KPI values and axis ticks.
- Scale (px at `font_scale = 1`): 11 · 12 · 13 (body) · 14 · 16 · 20 · 24 · 32 (KPI hero).
  Expose as `--fs-xs … --fs-hero`, all multiplied by `--font-scale`.
- Weights: 400 body, 500 labels, 600 headings. Tracking −0.01em on sizes ≥ 20.

### 1.4 Space, radius, elevation
- 4 px base: `--sp-1: 4px` through `--sp-10: 40px`. `data-density="compact"` scales
  padding by 0.75 and table row height from 36 px to 28 px.
- Radius presets: none 0 · sm 4 · md 8 · lg 14 (`--radius`, `--radius-sm`).
- Elevation: flat by default (border only). Popovers and modals get
  `0 12px 32px rgba(0,0,0,.24)` in dark themes and `.12` in light themes.

---

## 2. Layout
- **Rail** 232 px expanded / 64 px collapsed. Icons from a single inline SVG sprite, 20 px,
  1.5 px stroke.
- **Top bar** 56 px, sticky, with a translucent backdrop blur of `--bg`.
- **Content** max-width 1600 px with 24 px gutters (16 px below 768 px), on a 12-column grid.
- **Mobile (< 768 px):** the rail becomes a bottom sheet, the top-bar pickers collapse into
  one "Selection" button, and KPI strips scroll horizontally.

## 3. Components (behaviour and look)
- **KPI card:** label (`--text-2`, 12 px) above a value (mono, 24–32 px), with an optional
  delta pill below (▲ +1.2%) and an optional 32 px sparkline. The value counts up from its
  previous value in 400 ms, unless motion is off.
- **Chart card:** title and subtitle on the left, action icons on the right (table view, PNG,
  CSV, fullscreen) that appear on hover or focus. Show a skeleton shimmer while loading.
  Empty state: an icon, one sentence and an action button.
- **Data table:** sticky header, zebra striping off, row hover `--surface-2`, numbers
  right-aligned in mono, negatives in `--loss` with a − sign, virtual scroll above 200 rows,
  a column menu (hide, reorder, sort), and a sort button in each header.
- **Series picker:** chips coloured by the series' slot colour (a small dot, never a coloured
  chip background). Chips that don't fit collapse into a "+N" chip that opens the picker, so
  part of the selection is never silently hidden. The dropdown has grouped search (category headings), watchlist tabs,
  keyboard navigation and recent picks. Selection order fixes each series' colour slot.
- **Date range:** segmented presets plus a "Custom" popover with two date fields (typed input
  plus the browser's native calendar). Below 1280 px the minor presets (1M 3M 6M YTD 3Y) hide.
- **Command palette:** centred modal 640 px wide with fuzzy search, grouped results and
  shortcut hints on the right.
- **Toast:** bottom-right, stacked, with a progress bar for jobs. Auto-dismiss in 4 s unless
  it's an error.
- **Status pill:** icon + label + status colour at 12% alpha for the background.
- **Buttons:** primary (accent fill), secondary (surface-2), ghost, danger. Height 32 px
  (28 px compact). Pressed state scales to 0.98.
- **Focus:** 2 px `--focus` ring with 2 px offset, on every interactive element.

## 4. Motion
- Durations: 120 ms (hover/press), 200 ms (panels, tabs), 320 ms (page transitions, count-up).
- Easing: `cubic-bezier(.2,.8,.2,1)`.
- Page transition: 8 px rise with a fade. Charts animate their first draw only, never on
  data refresh.
- `data-motion="reduced"` keeps opacity changes only. `"off"` disables all transitions.
  Honour `prefers-reduced-motion` when the setting is "full".

## 5. Signature details (what makes it feel premium)
- A **live "market pulse" strip** under the top bar: a thin ticker of watchlist last prices
  and changes. It scrolls slowly and pauses on hover. It can be toggled off in settings.
- **Crosshair sync:** hovering one time-series chart shows the same date on every other
  chart on the page.
- **Number morphing:** KPI values animate digit by digit when the selection changes.
- **Contextual insight lines** in plain English under key charts ("Current drawdown is
  deeper than 82% of days since 2008").
- **Command palette everything:** every action is reachable from the keyboard.
- **Empty states with personality:** a small line illustration and a helpful next step.

## 6. Iconography & imagery
One consistent outline icon set, drawn as an inline SVG sprite, with no icon-font
dependency. No stock images. Use the logo mark: a simple ascending "V" inside a rounded
square, drawn in `--accent`.

## 7. Chart rules
- **Series colours** follow selection order and are never cycled. Series 9 and later
  fold into grey, and the UI suggests using fewer series.
  - Light set: `#2a78d6 #eb6834 #1baf7a #eda100 #e87ba4 #008300 #4a3aa7 #e34948`
  - Dark set: `#3987e5 #d95926 #199e70 #c98500 #d55181 #008300 #9085e9 #e66767`
  - Both sets pass colour-blind separation checks (adjacent ΔE ≥ 8.4) on every theme
    surface above. In light themes, aqua, yellow and pink fall below 3:1 contrast, so
    light-theme charts must keep a legend or direct labels and offer the table view.
- **One y-axis per chart.** Never a dual axis. To compare scales, rebase to 100 or use
  small multiples.
- Lines are 2 px, gridlines 1 px in `--grid`, no chart borders. The legend sits top-right,
  and there are direct end-labels when there are 4 series or fewer.
- Heatmaps use a diverging scale `--div-neg → --div-mid → --div-pos` with a 2 px cell gap
  and centre at 0. Cell text uses `--text`.
- Tooltips: a crosshair with a unified tooltip on time series and per-mark tooltips on bars
  and cells. Values are formatted with user settings.
- Every chart gets a "view as table" toggle and PNG/CSV export.
- **Custom palettes** (Settings → Theme editor): run a colour-blind check in JS by
  simulating protan/deutan/tritan vision, computing OKLab ΔE between adjacent colours,
  and warning below 8. Also check normal-vision ΔE (warn below 15) and contrast against
  `--surface` (warn below 3:1). Show the warnings inline, but allow saving.

## 8. Voice
Short, factual and friendly. Use Indian conventions: ₹, lakh/crore, and DD-MM-YYYY by
default. Label every caveat where it matters (price index vs TRI, synthetic demo data).
