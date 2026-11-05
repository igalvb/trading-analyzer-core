/**
 * The CLI rendering of showPriceChart: one self-contained HTML page (data
 * embedded as JSON) that draws the same series, colours, dash styles, axis
 * window and title with Chart.js. NEW code, not a port: legacy has no HTML
 * (F-C1), so there is nothing to compare it with; it is structure-tested.
 * Chart.js itself is loaded from a CDN script tag, so the page needs network
 * access when opened (decision pending: vendor it or keep the CDN).
 *
 * The caller writes the string to out/ + priceChartFileName(ticker).
 */

import type { PriceChartResult } from './priceChart.ts';

const CHART_JS_URL = 'https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js';
const LINE_SEP = String.fromCharCode(0x2028);
const PARA_SEP = String.fromCharCode(0x2029);

const htmlEsc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const dayOf = (v: unknown): string => (Object.prototype.toString.call(v) === '[object Date]' ? (v as Date).toISOString().slice(0, 10) : String(v));

/** A file-system-safe name: only letters, digits, dot, underscore and dash survive. */
export function priceChartFileName(ticker: string): string {
  return ticker.replace(/[^A-Za-z0-9._-]/g, '_') + '-chart.html';
}

export function renderPriceChartHtml(r: Pick<PriceChartResult, 'ticker' | 'headers' | 'rows' | 'entryLabel'> & { readonly spec: { readonly options: Record<string, unknown> } }): string {
  const series = (r.spec.options.series ?? {}) as Record<string, Record<string, unknown>>;
  const viewWindow = ((r.spec.options.vAxis ?? {}) as { viewWindow?: { min?: number; max?: number } }).viewWindow ?? {};
  const title = String(r.spec.options.title ?? r.ticker);
  const datasets = r.headers.slice(1).map((header, idx) => {
    const s = series[idx] ?? {};
    const lineWidth = typeof s.lineWidth === 'number' ? s.lineWidth : 1;
    const pointSize = typeof s.pointSize === 'number' ? s.pointSize : 0;
    return {
      label: header, data: r.rows.map((row) => row[idx + 1] ?? null), borderColor: s.color, backgroundColor: s.color, borderWidth: lineWidth,
      borderDash: Array.isArray(s.lineDashStyle) ? s.lineDashStyle : [], pointRadius: pointSize / 2, pointStyle: s.pointShape === 'diamond' ? 'rectRot' : 'circle',
      showLine: lineWidth > 0, spanGaps: true,
    };
  });
  const config = {
    type: 'line',
    data: { labels: r.rows.map((row) => dayOf(row[0])), datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { title: { display: true, text: title, font: { size: 15, weight: 'bold' } }, legend: { position: 'top' } },
      scales: { y: { min: viewWindow.min, max: viewWindow.max } },
    },
  };
  // '<' is escaped so no label can close the script tag; the two JS line separators are escaped too.
  const json = JSON.stringify(config).replace(/</g, '\\u003c').split(LINE_SEP).join('\\u2028').split(PARA_SEP).join('\\u2029');
  return '<!DOCTYPE html><html><head><meta charset="utf-8"><title>' + htmlEsc(title) + '</title>\n' +
    '<script src="' + CHART_JS_URL + '"></script>\n' +
    '<style>body{font-family:Arial,sans-serif;margin:16px}#wrap{width:1200px;max-width:100%;height:700px}p{color:#2e7d32;font-style:italic}</style></head><body>\n' +
    '<div id="wrap"><canvas id="chart"></canvas></div>\n' +
    '<p>' + htmlEsc(r.entryLabel) + '</p>\n' +
    '<script>\nconst config = ' + json + ';\nnew Chart(document.getElementById("chart"), config);\n</script></body></html>\n';
}
