(function () {
  const STORAGE_KEY = "boxplot-v1";
  const FM_COLORS = ["#7A3412", "#2E8B3C", "#3A3A3A", "#8FB56A", "#00B7CE", "#123C48", "#1B6FCB", "#E0A820"];
  const MEAN_COLOR = "#2f9e2f";
  const MEDIAN_COLOR = "#c47a12";
  const INK = "#1c2430";
  const GRID = "#d5dde6";
  const FONT = '13px "Segoe UI", Arial, Helvetica, sans-serif';
  const FONT_BOLD = '700 13px "Segoe UI", Arial, Helvetica, sans-serif';
  const TITLE_FONT = '700 20px "Segoe UI", Arial, Helvetica, sans-serif';
  const ZOOM_MIN = 0.5;
  const ZOOM_MAX = 8;
  const ZOOM_STEP = 0.25;

  const state = {
    title: "Mud Weight Distribution by Formation",
    yLabel: "Mud Weight (unit as recorded)",
    xLabel: "Formation",
    decimalComma: true,
    yMin: null,
    yMax: null,
    show: { box: true, median: true, mean: true, whisker: true, outlier: true, legend: true },
    numbers: { min: false, q1: false, median: false, mean: false, q3: false, max: false, outlier: false },
    columns: []
  };

  const NUMBER_ROWS = [
    { key: "min", label: "Min" },
    { key: "q1", label: "Q1" },
    { key: "median", label: "Median" },
    { key: "mean", label: "Mean" },
    { key: "q3", label: "Q3" },
    { key: "max", label: "Max" },
    { key: "outlier", label: "Outlier" }
  ];

  let viewZoom = 1;
  let zoomAnchor = null;
  let zoomWheel = 0;
  let panGesture = null;
  let lastScene = null;
  let drawQueued = false;
  let hadStored = false;

  function uid() {
    return "b" + Math.random().toString(36).slice(2, 10);
  }

  function esc(value) {
    return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    }[ch]));
  }

  function parseNum(value) {
    let text = String(value ?? "").trim().toLowerCase();
    if (!text) return null;
    text = text.replace(/\s+/g, "");
    if (!text || text === "-" || text === "." || text === "," || text === "-." || text === "-,") return NaN;
    const comma = text.lastIndexOf(",");
    const dot = text.lastIndexOf(".");
    if (comma >= 0 && dot >= 0) {
      if (comma > dot) text = text.replace(/\./g, "").replace(",", ".");
      else text = text.replace(/,/g, "");
    } else if (comma >= 0) {
      text = text.replace(",", ".");
    }
    const n = Number(text);
    return Number.isFinite(n) ? n : NaN;
  }

  function fmtAxis(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return "";
    const rounded = Math.round(n * 100) / 100;
    let text = String(rounded);
    if (Math.abs(rounded - Math.round(rounded)) < 1e-9) text = String(Math.round(rounded)) + ".0";
    else if (Math.abs(rounded * 10 - Math.round(rounded * 10)) < 1e-8) text = rounded.toFixed(1);
    return state.decimalComma ? text.replace(".", ",") : text;
  }

  function numToInput(value) {
    if (value == null || Number.isNaN(value)) return "";
    const text = String(value);
    return state.decimalComma ? text.replace(".", ",") : text;
  }

  function column(name, values, color, index) {
    return {
      id: uid(),
      name: name || "Kolom " + (index + 1),
      color: /^#[0-9a-fA-F]{6}$/.test(color || "") ? color : FM_COLORS[index % FM_COLORS.length],
      values: (values || []).map((value) => (value == null || Number.isNaN(value) ? null : value))
    };
  }

  function rowCount() {
    return state.columns.reduce((max, item) => Math.max(max, item.values.length), 0);
  }

  function finiteValues(item) {
    return item.values.filter((value) => value != null && Number.isFinite(value));
  }

  function quantile(sorted, p) {
    const n = sorted.length;
    if (!n) return null;
    if (n === 1) return sorted[0];
    const pos = (n - 1) * p;
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    if (lo === hi) return sorted[lo];
    return sorted[lo] * (hi - pos) + sorted[hi] * (pos - lo);
  }

  function summarize(values) {
    const sorted = values.slice().sort((a, b) => a - b);
    const n = sorted.length;
    if (!n) return null;
    const q1 = quantile(sorted, 0.25);
    const median = quantile(sorted, 0.5);
    const q3 = quantile(sorted, 0.75);
    const iqr = q3 - q1;
    const lowFence = q1 - 1.5 * iqr;
    const highFence = q3 + 1.5 * iqr;
    const inside = sorted.filter((value) => value >= lowFence - 1e-9 && value <= highFence + 1e-9);
    const mean = sorted.reduce((sum, value) => sum + value, 0) / n;
    return {
      n,
      min: sorted[0],
      max: sorted[n - 1],
      q1,
      median,
      q3,
      mean,
      whiskerLow: inside.length ? inside[0] : sorted[0],
      whiskerHigh: inside.length ? inside[inside.length - 1] : sorted[n - 1],
      outliers: sorted.filter((value) => value < lowFence - 1e-9 || value > highFence + 1e-9)
    };
  }

  function statsOf(item) {
    return summarize(finiteValues(item));
  }

  function sampleColumns() {
    const pre = [10.4, 10.4, 10.39, 10.38, 10.22, 9.95, 9.94];
    for (let i = 0; i < 10; i += 1) pre.push(9.75);
    for (let i = 0; i < 7; i += 1) pre.push(9.74);
    const parigi = Array(pre.length).fill(9.31);
    parigi[4] = 9.83;
    const main = Array(pre.length).fill(9.5);
    const massive = [];
    for (let i = 0; i < pre.length; i += 1) massive.push(i % 3 === 1 ? 9.59 : 9.6);
    const stringers = Array(pre.length).fill(9.71);
    stringers[6] = 9.7;
    stringers[14] = 9.7;
    stringers[pre.length - 1] = 9.72;
    const massiveFm = [];
    for (let i = 0; i < pre.length; i += 1) massiveFm.push(i % 5 === 0 ? 9.8 : 9.79);
    const brf = Array(pre.length).fill(10.9);
    const nmta = Array(pre.length).fill(10.9);
    const names = ["Pre Parigi", "Parigi Top", "Main Fm", "Massive Fm", "Baturaja Stringers", "Baturaja Massive Fm", "BRF Base", "NMTA Fm"];
    const series = [pre, parigi, main, massive, stringers, massiveFm, brf, nmta];
    return names.map((name, index) => column(name, series[index], FM_COLORS[index % FM_COLORS.length], index));
  }

  function niceStep(span) {
    const rough = span / 6;
    if (!(rough > 0)) return 1;
    const pow = Math.pow(10, Math.floor(Math.log10(rough)));
    const err = rough / pow;
    const nice = err >= 7 ? 10 : err >= 3 ? 5 : err >= 1.5 ? 2 : 1;
    return nice * pow;
  }

  function axisScale(series) {
    const values = [];
    series.forEach((item) => {
      const stats = item.stats;
      if (!stats) return;
      if (state.show.box || state.show.median) values.push(stats.q1, stats.q3, stats.median);
      if (state.show.mean) values.push(stats.mean);
      if (state.show.whisker) values.push(stats.whiskerLow, stats.whiskerHigh);
      if (state.show.outlier) values.push.apply(values, stats.outliers);
      if (!state.show.box && !state.show.median && !state.show.mean && !state.show.whisker && !state.show.outlier) {
        values.push(stats.min, stats.max);
      }
    });
    let dataMin = values.length ? Math.min.apply(null, values) : 0;
    let dataMax = values.length ? Math.max.apply(null, values) : 1;
    if (dataMax - dataMin < 1e-9) {
      dataMin -= 0.5;
      dataMax += 0.5;
    }
    const pad = (dataMax - dataMin) * 0.08;
    let min = state.yMin != null ? state.yMin : dataMin - pad;
    let max = state.yMax != null ? state.yMax : dataMax + pad;
    if (state.yMin != null && min > dataMin) min = dataMin;
    if (state.yMax != null && max < dataMax) max = dataMax;
    if (!(max > min)) max = min + 1;
    const step = niceStep(max - min);
    const start = Math.floor(min / step) * step;
    const end = Math.ceil(max / step) * step;
    const ticks = [];
    for (let tick = start; tick <= end + step * 0.5; tick += step) ticks.push(Math.round(tick * 1e6) / 1e6);
    return { min: start, max: end, ticks };
  }

  function wrapLabel(ctx, text, maxWidth) {
    const words = String(text || "").split(/\s+/).filter(Boolean);
    if (!words.length) return [""];
    const lines = [];
    let line = "";
    words.forEach((word) => {
      const next = line ? line + " " + word : word;
      if (line && ctx.measureText(next).width > maxWidth) {
        lines.push(line);
        line = word;
      } else line = next;
    });
    if (line) lines.push(line);
    return lines.slice(0, 3);
  }

  function yOf(scale, plotTop, plotH, value) {
    return plotTop + (scale.max - value) / (scale.max - scale.min) * plotH;
  }

  function legendItems() {
    const items = [];
    if (state.show.mean) items.push("mean");
    if (state.show.median) items.push("median");
    return items;
  }

  function drawMeanMark(ctx, x, y) {
    const arm = 5;
    ctx.lineWidth = 2.2;
    ctx.strokeStyle = MEAN_COLOR;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(x - arm, y - arm);
    ctx.lineTo(x + arm, y + arm);
    ctx.moveTo(x - arm, y + arm);
    ctx.lineTo(x + arm, y - arm);
    ctx.stroke();
  }

  function drawMedianMark(ctx, x, y) {
    ctx.lineWidth = 2.6;
    ctx.strokeStyle = MEDIAN_COLOR;
    ctx.lineCap = "butt";
    ctx.beginPath();
    ctx.moveTo(x - 12, y);
    ctx.lineTo(x + 12, y);
    ctx.stroke();
  }

  function drawSymbolLegend(ctx, centerX, y) {
    const items = legendItems();
    if (!items.length) return;
    ctx.font = '12px "Segoe UI", Arial, Helvetica, sans-serif';
    ctx.textBaseline = "middle";
    const gap = 8;
    const between = 28;
    const iconW = { mean: 14, median: 24 };
    let total = 0;
    items.forEach((kind, index) => {
      total += iconW[kind] + gap + ctx.measureText(kind).width;
      if (index) total += between;
    });
    let x = centerX - total / 2;
    items.forEach((kind, index) => {
      if (index) x += between;
      if (kind === "mean") drawMeanMark(ctx, x + iconW.mean / 2, y);
      else drawMedianMark(ctx, x + iconW.median / 2, y);
      x += iconW[kind] + gap;
      ctx.fillStyle = "#4b5563";
      ctx.textAlign = "left";
      ctx.fillText(kind, x, y);
      x += ctx.measureText(kind).width;
    });
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
  }

  function numberText(stats, key, maxWidth, ctx) {
    if (key === "outlier") {
      if (!stats.outliers.length) return "—";
      const full = stats.outliers.map(fmtAxis).join(", ");
      if (ctx.measureText(full).width <= maxWidth) return full;
      return stats.outliers.length + " nilai";
    }
    return Number.isFinite(stats[key]) ? fmtAxis(stats[key]) : "—";
  }

  function optionalLimit(value) {
    if (value == null || value === "") return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  function applyFlags(target, source) {
    if (!source || typeof source !== "object") return;
    Object.keys(target).forEach((key) => {
      if (Object.prototype.hasOwnProperty.call(source, key)) target[key] = !!source[key];
    });
  }

  function renderCanvas(canvas, scale) {
    const series = state.columns.map((item) => ({ item, stats: statsOf(item) })).filter((entry) => entry.stats);
    const empty = !series.length;
    const count = Math.max(series.length, 1);
    const numberRows = NUMBER_ROWS.filter((row) => state.numbers[row.key]);
    const legendOn = state.show.legend !== false;
    const foot = numberRows.length
      ? (legendOn ? 156 : 128) + numberRows.length * 24
      : (legendOn ? 108 : 88);
    const w = Math.max(980, 170 + count * 136);
    const h = 520 + foot;
    canvas.width = Math.round(w * scale);
    canvas.height = Math.round(h * scale);
    const ctx = canvas.getContext("2d");
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, w, h);
    if (empty) {
      ctx.fillStyle = "#655e54";
      ctx.font = FONT;
      ctx.textAlign = "center";
      ctx.fillText("Tempel data dari Excel untuk membuat box plot.", w / 2, h / 2);
      return { w, h, empty: true };
    }

    const margin = { top: 54, right: 36, bottom: foot, left: 92 };
    const plotW = w - margin.left - margin.right;
    const plotH = h - margin.top - margin.bottom;
    const plotTop = margin.top;
    const plotLeft = margin.left;
    const scaleY = axisScale(series);

    ctx.strokeStyle = GRID;
    ctx.lineWidth = 1;
    ctx.font = FONT;
    ctx.fillStyle = INK;
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    scaleY.ticks.forEach((tick) => {
      const y = yOf(scaleY, plotTop, plotH, tick);
      ctx.beginPath();
      ctx.moveTo(plotLeft, y);
      ctx.lineTo(plotLeft + plotW, y);
      ctx.stroke();
      ctx.fillText(fmtAxis(tick), plotLeft - 10, y);
    });

    ctx.strokeStyle = INK;
    ctx.strokeRect(plotLeft + 0.5, plotTop + 0.5, plotW - 1, plotH - 1);

    ctx.save();
    ctx.translate(22, plotTop + plotH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.font = FONT_BOLD;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(state.yLabel || "Nilai", 0, 0);
    ctx.restore();

    ctx.font = TITLE_FONT;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillText(state.title || "Box & Whisker", w / 2, 16);

    const slot = plotW / series.length;
    series.forEach((entry, index) => {
      const stats = entry.stats;
      const cx = plotLeft + slot * index + slot / 2;
      const boxW = Math.min(52, slot * 0.52);
      const yLo = yOf(scaleY, plotTop, plotH, stats.whiskerLow);
      const yHi = yOf(scaleY, plotTop, plotH, stats.whiskerHigh);
      const yQ1 = yOf(scaleY, plotTop, plotH, stats.q1);
      const yQ3 = yOf(scaleY, plotTop, plotH, stats.q3);
      const yMed = yOf(scaleY, plotTop, plotH, stats.median);
      const yMean = yOf(scaleY, plotTop, plotH, stats.mean);
      const color = entry.item.color || FM_COLORS[index % FM_COLORS.length];
      const flat = Math.abs(stats.q3 - stats.q1) < 1e-9;

      if (state.show.whisker) {
        ctx.strokeStyle = INK;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(cx, yHi);
        ctx.lineTo(cx, yLo);
        ctx.moveTo(cx - 10, yHi);
        ctx.lineTo(cx + 10, yHi);
        ctx.moveTo(cx - 10, yLo);
        ctx.lineTo(cx + 10, yLo);
        ctx.stroke();
      }

      if (state.show.box) {
        if (flat) {
          ctx.strokeStyle = color;
          ctx.lineWidth = 3;
          ctx.beginPath();
          ctx.moveTo(cx - boxW / 2, yMed);
          ctx.lineTo(cx + boxW / 2, yMed);
          ctx.stroke();
        } else {
          const top = Math.min(yQ1, yQ3);
          const height = Math.max(2, Math.abs(yQ3 - yQ1));
          ctx.fillStyle = color;
          ctx.strokeStyle = INK;
          ctx.lineWidth = 1.1;
          ctx.fillRect(cx - boxW / 2, top, boxW, height);
          ctx.strokeRect(cx - boxW / 2 + 0.5, top + 0.5, boxW - 1, height - 1);
        }
      }

      if (state.show.median) {
        ctx.strokeStyle = MEDIAN_COLOR;
        ctx.lineWidth = 2.4;
        ctx.beginPath();
        ctx.moveTo(cx - boxW / 2, yMed);
        ctx.lineTo(cx + boxW / 2, yMed);
        ctx.stroke();
      }

      if (state.show.outlier) {
        stats.outliers.forEach((value) => {
          const y = yOf(scaleY, plotTop, plotH, value);
          ctx.beginPath();
          ctx.arc(cx, y, 4.2, 0, Math.PI * 2);
          ctx.fillStyle = "#ffffff";
          ctx.fill();
          ctx.lineWidth = 1.2;
          ctx.strokeStyle = INK;
          ctx.stroke();
        });
      }

      if (state.show.mean) {
        const arm = 5;
        ctx.lineWidth = 4;
        ctx.strokeStyle = "#ffffff";
        ctx.beginPath();
        ctx.moveTo(cx - arm, yMean - arm);
        ctx.lineTo(cx + arm, yMean + arm);
        ctx.moveTo(cx - arm, yMean + arm);
        ctx.lineTo(cx + arm, yMean - arm);
        ctx.stroke();
        ctx.lineWidth = 2;
        ctx.strokeStyle = MEAN_COLOR;
        ctx.stroke();
      }

      ctx.fillStyle = INK;
      ctx.font = FONT;
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      const lines = wrapLabel(ctx, entry.item.name, slot - 8);
      lines.forEach((line, lineIndex) => {
        ctx.fillText(line, cx, plotTop + plotH + 12 + lineIndex * 16);
      });
    });

    const below = plotTop + plotH;
    ctx.fillStyle = INK;
    ctx.font = FONT_BOLD;
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    ctx.fillText(state.xLabel || "Kategori", plotLeft + plotW / 2, below + 72);

    if (legendOn) drawSymbolLegend(ctx, plotLeft + plotW / 2, below + 92);

    if (numberRows.length) {
      const tableTop = below + (legendOn ? 124 : 96);
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.font = '700 12px "Segoe UI", Arial, Helvetica, sans-serif';
      ctx.fillStyle = INK;
      numberRows.forEach((row, rowIndex) => {
        const y = tableTop + rowIndex * 24 + 12;
        if (rowIndex % 2 === 0) {
          ctx.fillStyle = "#f4f7fb";
          ctx.fillRect(plotLeft, y - 12, plotW, 24);
          ctx.fillStyle = INK;
        }
        ctx.textAlign = "right";
        ctx.fillText(row.label, plotLeft - 10, y);
        ctx.textAlign = "center";
        ctx.font = '12px "Segoe UI", Arial, Helvetica, sans-serif';
        series.forEach((entry, index) => {
          const cx = plotLeft + slot * index + slot / 2;
          ctx.fillText(numberText(entry.stats, row.key, slot - 12, ctx), cx, y);
        });
        ctx.font = '700 12px "Segoe UI", Arial, Helvetica, sans-serif';
      });
    }

    return { w, h, empty: false };
  }

  function setStatus(text) {
    const el = document.getElementById("bx-status");
    if (el) el.textContent = text || "";
  }

  function fittedWidth(sheet) {
    if (!sheet || !lastScene) return 0;
    const available = sheet.clientWidth - 24;
    if (available < 80) return 0;
    return Math.min(lastScene.w, available);
  }

  function updateZoomUi() {
    const label = document.getElementById("bx-zoom-label");
    if (label) label.textContent = Math.round(viewZoom * 100) + "%";
    const zoomOut = document.getElementById("bx-zoom-out");
    const zoomIn = document.getElementById("bx-zoom-in");
    if (zoomOut) zoomOut.disabled = viewZoom <= ZOOM_MIN + 0.001;
    if (zoomIn) zoomIn.disabled = viewZoom >= ZOOM_MAX - 0.001;
  }

  function applyZoom() {
    const canvas = document.getElementById("bx-chart");
    const sheet = document.getElementById("bx-sheet");
    const base = fittedWidth(sheet);
    if (!canvas || !base) return;
    const cssW = base * viewZoom;
    const cssH = lastScene.h * (cssW / lastScene.w);
    canvas.style.width = cssW + "px";
    canvas.style.height = cssH + "px";
    if (zoomAnchor) {
      sheet.scrollLeft = zoomAnchor.rx * cssW - zoomAnchor.viewX + canvas.offsetLeft;
      sheet.scrollTop = zoomAnchor.ry * cssH - zoomAnchor.viewY + canvas.offsetTop;
      zoomAnchor = null;
    }
    updateZoomUi();
  }

  function setViewZoom(next, event) {
    const zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(next / ZOOM_STEP) * ZOOM_STEP));
    if (Math.abs(zoom - viewZoom) < 0.001) return;
    const sheet = document.getElementById("bx-sheet");
    const canvas = document.getElementById("bx-chart");
    if (sheet && canvas && canvas.offsetWidth) {
      const rect = sheet.getBoundingClientRect();
      const viewX = event ? event.clientX - rect.left : sheet.clientWidth / 2;
      const viewY = event ? event.clientY - rect.top : sheet.clientHeight / 2;
      zoomAnchor = {
        rx: (sheet.scrollLeft + viewX - canvas.offsetLeft) / canvas.offsetWidth,
        ry: (sheet.scrollTop + viewY - canvas.offsetTop) / canvas.offsetHeight,
        viewX,
        viewY
      };
    }
    viewZoom = zoom;
    applyZoom();
  }

  function draw() {
    const canvas = document.getElementById("bx-chart");
    if (!canvas) return;
    try {
      lastScene = renderCanvas(canvas, 2);
      applyZoom();
      ["bx-png", "bx-jpg", "bx-pdf"].forEach((id) => {
        const button = document.getElementById(id);
        if (button) button.disabled = !!lastScene.empty;
      });
    } catch (err) {
      setStatus("Gambar gagal dibuat.");
    }
  }

  function requestDraw() {
    if (drawQueued) return;
    drawQueued = true;
    requestAnimationFrame(() => {
      drawQueued = false;
      draw();
    });
  }

  function persist() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot())); } catch (err) { /* storage unavailable */ }
  }

  function findColumn(id) {
    return state.columns.find((item) => item.id === id);
  }

  function renderTable() {
    const host = document.getElementById("bx-table");
    const count = document.getElementById("bx-col-count");
    if (count) count.textContent = state.columns.length ? state.columns.length + " kolom" : "";
    if (!host) return;
    const rows = rowCount();
    if (!state.columns.length) {
      host.innerHTML = '<p class="empty">Belum ada kolom. Tempel dari Excel atau tambah kolom.</p>';
      return;
    }
    const head = state.columns.map((item) => (
      '<th data-col="' + esc(item.id) + '"><div class="bx-head">' +
      '<input data-field="color" type="color" value="' + esc(item.color) + '" aria-label="Warna ' + esc(item.name) + '" />' +
      '<input data-field="name" type="text" spellcheck="false" value="' + esc(item.name) + '" aria-label="Header kolom" />' +
      '<button type="button" class="bx-icon" data-action="remove-col" aria-label="Hapus kolom">×</button>' +
      "</div></th>"
    )).join("");
    let body = "";
    for (let row = 0; row < rows; row += 1) {
      const cells = state.columns.map((item) => (
        '<td data-col="' + esc(item.id) + '"><input data-field="value" data-row="' + row + '" type="text" inputmode="decimal" autocomplete="off" spellcheck="false" value="' + esc(numToInput(item.values[row])) + '" /></td>'
      )).join("");
      body += '<tr><td class="bx-rowhead">' + (row + 1) +
        ' <button type="button" class="bx-icon" data-action="remove-row" data-row="' + row + '" aria-label="Hapus baris">×</button></td>' +
        cells + "</tr>";
    }
    host.innerHTML = '<div class="bx-table-wrap"><table class="bx-table"><thead><tr><th class="bx-rowhead"></th>' +
      head + "</tr></thead><tbody>" + body + "</tbody></table></div>";
  }

  function splitLine(line) {
    if (line.includes("\t")) return line.split("\t");
    if (line.includes(";")) return line.split(";");
    return [line];
  }

  function looksNumeric(cell) {
    const text = String(cell ?? "").trim();
    if (!text) return true;
    const n = parseNum(text);
    return n != null && !Number.isNaN(n);
  }

  function parseGrid(text) {
    const lines = String(text || "").replace(/\u00a0/g, " ").split(/\r?\n/).filter((line) => line.trim() !== "");
    if (!lines.length) return null;
    const rows = lines.map((line) => splitLine(line).map((cell) => cell.trim()));
    const width = rows.reduce((max, row) => Math.max(max, row.length), 0);
    if (width < 1) return null;
    const headerRow = rows[0].some((cell) => cell && !looksNumeric(cell));
    const headers = headerRow ? rows[0] : [];
    const body = headerRow ? rows.slice(1) : rows;
    return { width, headers, body };
  }

  function applyGrid(text) {
    const grid = parseGrid(text);
    if (!grid || !grid.body.length && !grid.headers.length) {
      setStatus("Tempelan kosong atau tidak dikenali.");
      return false;
    }
    const previous = state.columns.slice();
    const columns = [];
    for (let index = 0; index < grid.width; index += 1) {
      const header = (grid.headers[index] || "").trim();
      const name = header || (previous[index] && !grid.headers.length ? previous[index].name : "Kolom " + (index + 1));
      const match = previous.find((item) => item.name.trim().toLowerCase() === name.trim().toLowerCase());
      const values = grid.body.map((row) => {
        const cell = row[index] == null ? "" : row[index];
        if (!String(cell).trim()) return null;
        const n = parseNum(cell);
        return n == null || Number.isNaN(n) ? null : n;
      });
      columns.push(column(name, values, match ? match.color : FM_COLORS[index % FM_COLORS.length], index));
    }
    state.columns = columns.filter((item) => item.name || finiteValues(item).length);
    if (!state.columns.length) state.columns = columns;
    persist();
    renderTable();
    requestDraw();
    const rows = rowCount();
    setStatus(state.columns.length + " kolom, " + rows + " baris, dari tempelan Excel.");
    return true;
  }

  function addColumn() {
    const rows = rowCount();
    const values = Array(rows).fill(null);
    state.columns.push(column("Kolom " + (state.columns.length + 1), values, null, state.columns.length));
    persist();
    renderTable();
    requestDraw();
  }

  function addRow() {
    if (!state.columns.length) addColumn();
    state.columns.forEach((item) => item.values.push(null));
    persist();
    renderTable();
  }

  function applyChrome() {
    const title = document.getElementById("bx-title");
    const yLabel = document.getElementById("bx-ylabel");
    const xLabel = document.getElementById("bx-xlabel");
    const decimal = document.getElementById("bx-decimal");
    const yMin = document.getElementById("bx-ymin");
    const yMax = document.getElementById("bx-ymax");
    if (title && document.activeElement !== title) title.value = state.title;
    if (yLabel && document.activeElement !== yLabel) yLabel.value = state.yLabel;
    if (xLabel && document.activeElement !== xLabel) xLabel.value = state.xLabel;
    if (decimal) decimal.value = state.decimalComma ? "comma" : "dot";
    if (yMin && document.activeElement !== yMin) yMin.value = state.yMin == null ? "" : numToInput(state.yMin);
    if (yMax && document.activeElement !== yMax) yMax.value = state.yMax == null ? "" : numToInput(state.yMax);
    Object.keys(state.show).forEach((key) => {
      const input = document.getElementById("bx-show-" + key);
      if (input) input.checked = state.show[key];
    });
    Object.keys(state.numbers).forEach((key) => {
      const input = document.getElementById("bx-num-" + key);
      if (input) input.checked = state.numbers[key];
    });
  }

  function normalizeColumn(raw, index) {
    const values = Array.isArray(raw && raw.values) ? raw.values.map((value) => {
      const n = Number(value);
      return Number.isFinite(n) ? n : null;
    }) : [];
    return column(raw && raw.name, values, raw && raw.color, index);
  }

  function ingest(data) {
    if (!data || !Array.isArray(data.columns)) return false;
    state.title = data.title || "Mud Weight Distribution by Formation";
    state.yLabel = data.yLabel || "Mud Weight (unit as recorded)";
    state.xLabel = data.xLabel || "Formation";
    state.decimalComma = data.decimalComma !== false;
    state.yMin = optionalLimit(data.yMin);
    state.yMax = optionalLimit(data.yMax);
    applyFlags(state.show, data.show);
    applyFlags(state.numbers, data.numbers);
    state.columns = data.columns.map(normalizeColumn);
    return true;
  }

  function loadStored() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return false;
      return ingest(JSON.parse(raw));
    } catch (err) {
      return false;
    }
  }

  function snapshot() {
    return {
      title: state.title,
      yLabel: state.yLabel,
      xLabel: state.xLabel,
      decimalComma: state.decimalComma,
      yMin: state.yMin,
      yMax: state.yMax,
      show: Object.assign({}, state.show),
      numbers: Object.assign({}, state.numbers),
      columns: state.columns.map((item) => ({
        id: item.id,
        name: item.name,
        color: item.color,
        values: item.values.slice()
      }))
    };
  }

  function loadProject(data) {
    if (!ingest(data)) return false;
    applyChrome();
    persist();
    renderTable();
    requestDraw();
    return true;
  }

  function loadSample() {
    state.columns = sampleColumns();
    persist();
    renderTable();
    requestDraw();
    setStatus("Contoh mud weight dimuat. Tempel data Excel untuk menggantinya.");
  }

  function clearAll() {
    state.columns = [];
    persist();
    renderTable();
    requestDraw();
    setStatus("Tabel dikosongkan.");
  }

  function onTableInput(event) {
    const input = event.target;
    const cell = input.closest("[data-col]");
    if (!cell) return;
    const item = findColumn(cell.dataset.col);
    if (!item) return;
    if (input.dataset.field === "name") item.name = input.value;
    else if (input.dataset.field === "value") {
      const row = Number(input.dataset.row);
      const raw = input.value.trim();
      if (!raw) {
        item.values[row] = null;
        input.classList.remove("bad");
      } else {
        const n = parseNum(raw);
        if (n == null || Number.isNaN(n)) input.classList.add("bad");
        else {
          item.values[row] = n;
          input.classList.remove("bad");
        }
      }
    }
    persist();
    requestDraw();
  }

  function onTableChange(event) {
    const input = event.target;
    if (input.dataset.field !== "color") return;
    const cell = input.closest("[data-col]");
    const item = cell && findColumn(cell.dataset.col);
    if (!item) return;
    item.color = input.value;
    persist();
    requestDraw();
  }

  function onTableClick(event) {
    const button = event.target.closest("[data-action]");
    if (!button) return;
    if (button.dataset.action === "remove-col") {
      const cell = button.closest("[data-col]");
      state.columns = state.columns.filter((item) => item.id !== cell.dataset.col);
    } else if (button.dataset.action === "remove-row") {
      const row = Number(button.dataset.row);
      state.columns.forEach((item) => item.values.splice(row, 1));
    }
    persist();
    renderTable();
    requestDraw();
  }

  function onTablePaste(event) {
    const text = event.clipboardData && event.clipboardData.getData("text");
    if (!text || (!text.includes("\t") && !text.includes("\n") && !text.includes(";"))) return;
    event.preventDefault();
    applyGrid(text);
  }

  function readLimit(id) {
    const input = document.getElementById(id);
    if (!input) return null;
    const raw = input.value.trim();
    if (!raw) {
      input.classList.remove("bad");
      return null;
    }
    const n = parseNum(raw);
    if (n == null || Number.isNaN(n)) {
      input.classList.add("bad");
      return undefined;
    }
    input.classList.remove("bad");
    return n;
  }

  function fileStem() {
    const raw = (state.title || "box-whisker").trim() || "box-whisker";
    return raw.replace(/[\\/:*?"<>|]/g, "").replace(/\s+/g, " ").slice(0, 80);
  }

  function downloadBlob(blob, name) {
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 2500);
  }

  function canvasBlob(canvas, type, quality) {
    return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
  }

  async function exportImage(kind) {
    if (!lastScene || lastScene.empty) {
      setStatus("Belum ada data untuk diunduh.");
      return;
    }
    const buttons = ["bx-png", "bx-jpg", "bx-pdf"].map((id) => document.getElementById(id));
    buttons.forEach((button) => { if (button) button.disabled = true; });
    try {
      const canvas = document.createElement("canvas");
      const figure = renderCanvas(canvas, 2);
      if (kind === "pdf") {
        await exportPdf(canvas, figure);
        return;
      }
      const type = kind === "jpg" ? "image/jpeg" : "image/png";
      const blob = await canvasBlob(canvas, type, 0.95);
      if (!blob) throw new Error("blob");
      downloadBlob(blob, fileStem() + "." + (kind === "jpg" ? "jpg" : "png"));
      setStatus(kind === "jpg" ? "JPG berhasil diunduh." : "PNG berhasil diunduh.");
    } catch (err) {
      setStatus("Berkas gagal dibuat. Coba lagi.");
    } finally {
      const empty = !lastScene || lastScene.empty;
      buttons.forEach((button) => { if (button) button.disabled = empty; });
    }
  }

  async function exportPdf(canvas, figure) {
    if (!window.jspdf || !window.jspdf.jsPDF) {
      setStatus("Pustaka PDF belum termuat. Buka ulang halaman ini.");
      return;
    }
    const { jsPDF } = window.jspdf;
    const aspect = figure.w / figure.h;
    const wide = figure.w > 1100;
    const format = wide ? "a3" : "a4";
    const orientation = aspect >= 1 ? "landscape" : "portrait";
    const pdf = new jsPDF({ orientation, unit: "mm", format });
    const pageW = pdf.internal.pageSize.getWidth();
    const pageH = pdf.internal.pageSize.getHeight();
    const margin = 8;
    const maxW = pageW - margin * 2;
    const maxH = pageH - margin * 2;
    const ratio = figure.w / figure.h;
    let w = maxW;
    let h = w / ratio;
    if (h > maxH) {
      h = maxH;
      w = h * ratio;
    }
    pdf.addImage(canvas.toDataURL("image/png"), "PNG", (pageW - w) / 2, (pageH - h) / 2, w, h);
    pdf.setProperties({ title: state.title || "Box & Whisker", subject: "Box and whisker plot" });
    pdf.save(fileStem() + ".pdf");
    setStatus("PDF berhasil diunduh.");
  }

  function bindChartView() {
    const canvas = document.getElementById("bx-chart");
    const sheet = document.getElementById("bx-sheet");
    if (!canvas || !sheet) return;
    canvas.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      panGesture = { id: event.pointerId, x: event.clientX, y: event.clientY, left: sheet.scrollLeft, top: sheet.scrollTop };
      canvas.classList.add("panning");
      try { canvas.setPointerCapture(event.pointerId); } catch (err) { /* pointer sudah lepas */ }
    });
    canvas.addEventListener("pointermove", (event) => {
      if (!panGesture || event.pointerId !== panGesture.id) return;
      sheet.scrollLeft = panGesture.left - (event.clientX - panGesture.x);
      sheet.scrollTop = panGesture.top - (event.clientY - panGesture.y);
    });
    const endPan = (event) => {
      if (!panGesture || (event && event.pointerId !== panGesture.id)) return;
      panGesture = null;
      canvas.classList.remove("panning");
    };
    canvas.addEventListener("pointerup", endPan);
    canvas.addEventListener("pointercancel", endPan);
    sheet.addEventListener("wheel", (event) => {
      event.preventDefault();
      zoomWheel += -event.deltaY / 400;
      if (Math.abs(zoomWheel) < ZOOM_STEP) return;
      const steps = Math.trunc(zoomWheel / ZOOM_STEP);
      zoomWheel -= steps * ZOOM_STEP;
      setViewZoom(viewZoom + steps * ZOOM_STEP, event);
    }, { passive: false });
  }

  function bind() {
    const table = document.getElementById("bx-table");
    table.addEventListener("input", onTableInput);
    table.addEventListener("change", onTableChange);
    table.addEventListener("click", onTableClick);
    table.addEventListener("paste", onTablePaste);
    document.getElementById("bx-paste").addEventListener("paste", onTablePaste);
    document.getElementById("bx-paste-apply").addEventListener("click", () => {
      applyGrid(document.getElementById("bx-paste").value);
    });
    document.getElementById("bx-add-col").addEventListener("click", addColumn);
    document.getElementById("bx-add-row").addEventListener("click", addRow);
    document.getElementById("bx-sample").addEventListener("click", loadSample);
    document.getElementById("bx-clear").addEventListener("click", clearAll);
    document.getElementById("bx-title").addEventListener("input", (event) => {
      state.title = event.target.value;
      persist();
      requestDraw();
    });
    document.getElementById("bx-ylabel").addEventListener("input", (event) => {
      state.yLabel = event.target.value;
      persist();
      requestDraw();
    });
    document.getElementById("bx-xlabel").addEventListener("input", (event) => {
      state.xLabel = event.target.value;
      persist();
      requestDraw();
    });
    document.getElementById("bx-decimal").addEventListener("change", (event) => {
      state.decimalComma = event.target.value === "comma";
      applyChrome();
      persist();
      renderTable();
      requestDraw();
    });
    document.getElementById("bx-ymin").addEventListener("input", () => {
      const value = readLimit("bx-ymin");
      if (value === undefined) return;
      state.yMin = value;
      persist();
      requestDraw();
    });
    document.getElementById("bx-toggles").addEventListener("change", (event) => {
      const input = event.target;
      if (!input.dataset || !input.dataset.flag) return;
      const group = input.dataset.group === "numbers" ? state.numbers : state.show;
      if (!Object.prototype.hasOwnProperty.call(group, input.dataset.flag)) return;
      group[input.dataset.flag] = input.checked;
      persist();
      requestDraw();
    });
    document.getElementById("bx-ymax").addEventListener("input", () => {
      const value = readLimit("bx-ymax");
      if (value === undefined) return;
      state.yMax = value;
      persist();
      requestDraw();
    });
    document.getElementById("bx-png").addEventListener("click", () => exportImage("png"));
    document.getElementById("bx-jpg").addEventListener("click", () => exportImage("jpg"));
    document.getElementById("bx-pdf").addEventListener("click", () => exportImage("pdf"));
    document.getElementById("bx-zoom-in").addEventListener("click", () => setViewZoom(viewZoom + ZOOM_STEP));
    document.getElementById("bx-zoom-out").addEventListener("click", () => setViewZoom(viewZoom - ZOOM_STEP));
    document.getElementById("bx-zoom-fit").addEventListener("click", () => setViewZoom(1));
    bindChartView();
    const sheet = document.getElementById("bx-sheet");
    if (typeof ResizeObserver !== "undefined" && sheet) {
      const observer = new ResizeObserver(() => {
        const panel = document.getElementById("panel-boxplot");
        if (panel && !panel.hidden) applyZoom();
      });
      observer.observe(sheet);
    }
  }

  function init() {
    applyChrome();
    renderTable();
    bind();
    const panel = document.getElementById("panel-boxplot");
    if (panel && !panel.hidden) draw();
    setStatus(hadStored ? "Data box plot terakhir dibuka kembali." : "Contoh mud weight dimuat. Tempel data Excel untuk menggantinya.");
  }

  hadStored = loadStored();
  if (!hadStored) state.columns = sampleColumns();
  window.BoxWhisker = { draw, snapshot, load: loadProject };
  document.addEventListener("DOMContentLoaded", init);
})();
