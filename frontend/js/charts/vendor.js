// Lazy-load the vendored chart libraries (classic UMD scripts) once, on first use.
// Pages without charts never download them. See vendor/VERSIONS.md.

const loading = new Map();

function loadScript(src, globalName) {
  if (window[globalName]) return Promise.resolve(window[globalName]);
  if (!loading.has(src)) {
    loading.set(src, new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src;
      s.onload = () => (window[globalName] ? resolve(window[globalName]) : reject(new Error(`${globalName} missing after load`)));
      s.onerror = () => { loading.delete(src); reject(new Error(`Couldn't load ${src}`)); };
      document.head.append(s);
    }));
  }
  return loading.get(src);
}

/** TradingView Lightweight Charts 5.x (window.LightweightCharts). */
export const lightweight = () => loadScript("vendor/lightweight-charts.standalone.production.js", "LightweightCharts");

/** Apache ECharts 6.x (window.echarts). */
export const echarts = () => loadScript("vendor/echarts.min.js", "echarts");
