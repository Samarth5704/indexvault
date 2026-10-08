# Vendored files

Downloaded 2026-10-08 from cdn.jsdelivr.net/npm (mirror of the npm registry).
Loaded locally only — never from a CDN at runtime. To upgrade: download the new
file, update this table (version + sha256), and check the charts still render.

| File | Package | Version | License | sha256 |
|---|---|---|---|---|
| `vendor/lightweight-charts.standalone.production.js` | lightweight-charts (TradingView) | 5.2.1 (2026-08-12) | Apache-2.0 (`licenses/`) | `e21cc5caa0226ef30bd8549c50b9ef926615f2a4ee6b4e486353477a55f598cf` |
| `vendor/echarts.min.js` | echarts (Apache) | 6.1.0 (2026-05-19) | Apache-2.0 (`licenses/`) | `b66b25aeb4df84e33199dc21694014d336d222cbd9deb0e5a7c14bd6aa0d0fd0` |
| `fonts/inter-latin-wght.woff2` | @fontsource-variable/inter | 5.3.0 (2026-07-19) | OFL-1.1 (`fonts/Inter-OFL.txt`) | `3100e775e8616cd2611beecfa23a4263d7037586789b43f035236a2e6fbd4c62` |
| `fonts/inter-latin-ext-wght.woff2` | @fontsource-variable/inter | 5.3.0 | OFL-1.1 | `34b9c504cab7a73e37b746343a449132e56cf7b5481af2cb81dc74dcff25c956` |
| `fonts/jetbrains-mono-latin-wght.woff2` | @fontsource-variable/jetbrains-mono | 5.3.0 (2026-07-19) | OFL-1.1 (`fonts/JetBrainsMono-OFL.txt`) | `18be452724bfdc236c074ca94a249a7f41a86752c7d04ab258ce9ed5651f6a7e` |
| `fonts/jetbrains-mono-latin-ext-wght.woff2` | @fontsource-variable/jetbrains-mono | 5.3.0 | OFL-1.1 | `79bfdab9ba467e26eea4122e6f2567e188dd8a09a8c730d501fc487c4ab99c6e` |

Notes
- Both chart libraries are the UMD/standalone builds: they define the globals
  `LightweightCharts` and `echarts`. Load them with a classic `<script>` only on pages
  that draw charts (from M4).
- Fonts are variable (weight axis 100–900). The latin-ext subsets are needed for ₹ (U+20B9).
