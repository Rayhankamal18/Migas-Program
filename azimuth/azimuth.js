const STORAGE_KEY = "azimuth-chart-v1";
const PLOT_R = 292;
const LABEL_PAD = 40;
const PAD_X = 22;
const PAD_TOP = 18;
const PAD_BOTTOM = 16;
const EXPORT_SCALE = 2;
const DEFAULT_TEMPLATE = "{sumur}, I : {inc}, A : {az}";
const CAPTION_FONT = 'italic 22px "Palatino Linotype", Palatino, "Book Antiqua", "Times New Roman", serif';
const AZ_FONT = "12px Arial, Helvetica, sans-serif";
const INC_FONT = "11px Arial, Helvetica, sans-serif";
const LEGEND_FONT = "13px Arial, Helvetica, sans-serif";
const LEGEND_TEXT_W = 330;

const PALETTE = [
  "#2A3C8F", "#D31216", "#E39412", "#1AA392",
  "#C4A15A", "#A8B82E", "#6B4C9A", "#3D6B3D",
  "#C45C26", "#2F6F9F", "#A33B5A", "#4E6B8A",
  "#8C6A2F", "#3E7C6F", "#B04A3A", "#5C5C5C"
];

const PARIGI = [
  { formation: "Parigi Top", well: "OOA-1", azAwal: 236.16, azAkhir: 240.85, incAwal: 28.75, incAkhir: 58.19, color: "#2A3C8F" },
  { formation: "Parigi Top", well: "OOA-2ST2", azAwal: 151.69, azAkhir: 152.39, incAwal: 42.2, incAkhir: 57.69, color: "#D31216" },
  { formation: "Parigi Top", well: "OOA-3", azAwal: 79.37, azAkhir: 283.01, incAwal: 0.69, incAkhir: 16.42, color: "#E39412" },
  { formation: "Parigi Top", well: "OOA-4", azAwal: 0.33, azAkhir: 359.33, incAwal: 46.41, incAkhir: 72.63, color: "#1AA392" }
];

const WPA = [
  { formation: "WPA, UPA", well: "WPA-01ST", azAwal: 308, azAkhir: 248, incAwal: 57, incAkhir: 81, color: "#C4A15A" },
  { formation: "WPA, UPA", well: "WPA-02", azAwal: 342, azAkhir: 8, incAwal: 32, incAkhir: 73, color: "#A8B82E" },
  { formation: "WPA, UPA", well: "WPA-03", azAwal: 308, azAkhir: 248, incAwal: 57, incAkhir: 81, color: "#2A3C8F" },
  { formation: "WPA, UPA", well: "WPA-03ST", azAwal: 275, azAkhir: 242, incAwal: 65, incAkhir: 74, color: "#D31216" },
  { formation: "WPA, UPA", well: "WPA-04", azAwal: 290, azAkhir: 262, incAwal: 51, incAkhir: 69, color: "#E39412" },
  { formation: "WPA, UPA", well: "WPA-04ST", azAwal: 282, azAkhir: 264, incAwal: 57, incAkhir: 71, color: "#1AA392" },
  { formation: "WPA, UPA", well: "UPA-15", azAwal: 262, azAkhir: 260, incAwal: 85, incAkhir: 83, color: "#3AABB0" },
  { formation: "WPA, UPA", well: "UPA-15ST", azAwal: 260, azAkhir: 260, incAwal: 84, incAkhir: 84, color: "#D57A8A" },
  { formation: "WPA, UPA", well: "UPA-16", azAwal: 283, azAkhir: 282, incAwal: 60, incAkhir: 73, color: "#A89888" },
  { formation: "WPA, UPA", well: "UPA-16", azAwal: 282, azAkhir: 284, incAwal: 73, incAkhir: 80, color: "#8DAA14" }
];

const state = {
  records: [],
  formation: "Parigi Top",
  caption: "",
  captionTouched: false,
  arcMode: "short",
  strokeWidth: 1.8,
  fillOpacity: 0,
  incStep: 5,
  incMin: null,
  incMax: null,
  decimalComma: false,
  legendTemplate: DEFAULT_TEMPLATE,
  pdfAll: true,
  hoverId: null,
  viewZoom: 1,
  sheets: []
};

let measureCanvas = null;
let drawQueued = false;
let zoomAnchor = null;
let zoomWheel = 0;
let lastDraw = null;

const ZOOM_MIN = 0.5;
const ZOOM_MAX = 8;
const ZOOM_STEP = 0.25;

function uid() {
  return "w" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function clamp(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
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

function NORM(value) {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[_./-]+/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hasWord(text, words) {
  return words.some((word) => (
    text === word ||
    text.startsWith(word + " ") ||
    text.endsWith(" " + word) ||
    text.includes(" " + word + " ")
  ));
}

function isAzLabel(text) {
  return text.includes("azimuth") || text.includes("azimut") || hasWord(text, ["azi", "az"]);
}

function isIncLabel(text) {
  return text.includes("inklinasi") || text.includes("inclin") || hasWord(text, ["inc", "i"]);
}

const AWAL_WORDS = ["awal", "start", "initial", "from"];
const AKHIR_WORDS = ["akhir", "end", "final", "to"];

function classifyHeader(cell) {
  const text = NORM(cell);
  if (!text) return null;
  if (["well", "sumur", "nama sumur", "well name", "nama well", "lubang", "lubang bor"].includes(text) || text.includes("nama sumur")) {
    return "well";
  }
  if (["formasi", "formation", "lapangan", "horizon", "marker"].includes(text) || text.includes("nama formasi")) {
    return "formation";
  }
  const az = isAzLabel(text);
  const inc = isIncLabel(text);
  const awal = hasWord(text, AWAL_WORDS);
  const akhir = hasWord(text, AKHIR_WORDS);
  if (az && awal && !akhir) return "azAwal";
  if (az && akhir && !awal) return "azAkhir";
  if (inc && awal && !akhir) return "incAwal";
  if (inc && akhir && !awal) return "incAkhir";
  return null;
}

function parsePastedPairs(text) {
  const rows = [];
  String(text || "").split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const cells = trimmed.split(/[\t;]| {2,}|\s+/).map((part) => part.trim()).filter(Boolean);
    const values = [];
    cells.forEach((cell) => {
      const value = num(cell);
      if (value != null) values.push(value);
    });
    if (values.length >= 2) rows.push([values[0], values[1]]);
  });
  return rows;
}

function num(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (value == null) return null;
  let text = String(value).trim().replace(/\s+/g, "").replace(/[°º]/g, "");
  if (!text || text === "-" || text === "—" || text === "–") return null;
  if (text.includes(",") && text.includes(".")) {
    if (text.lastIndexOf(",") > text.lastIndexOf(".")) text = text.replace(/\./g, "").replace(",", ".");
    else text = text.replace(/,/g, "");
  } else if (text.includes(",")) {
    text = text.replace(",", ".");
  }
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

function normAz(value) {
  return ((Number(value) % 360) + 360) % 360;
}

function sectorSweep(azAwal, azAkhir, mode) {
  const start = normAz(azAwal);
  const end = normAz(azAkhir);
  const clockwise = (end - start + 360) % 360;
  if (mode === "cw") return { start, sweep: clockwise };
  if (mode === "ccw") return { start: end, sweep: (360 - clockwise) % 360 };
  if (clockwise === 0) return { start, sweep: 0 };
  if (clockwise <= 180) return { start, sweep: clockwise };
  return { start: end, sweep: 360 - clockwise };
}

function formatNum(value, comma) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "";
  const rounded = Math.round((n + Number.EPSILON) * 100) / 100;
  let text = rounded.toFixed(2).replace(/\.00$/, "").replace(/(\.\d)0$/, "$1");
  if (comma) text = text.replace(".", ",");
  return text;
}

function makeLegend(rec, template, comma) {
  const fmt = (value) => formatNum(value, comma);
  const incSame = Math.abs(rec.incAwal - rec.incAkhir) < 0.05;
  const azGap = Math.abs(normAz(rec.azAwal) - normAz(rec.azAkhir));
  const azSame = Math.min(azGap, 360 - azGap) < 0.05;
  const inc = incSame ? fmt(rec.incAwal) : `${fmt(rec.incAwal)} - ${fmt(rec.incAkhir)}`;
  const az = azSame ? fmt(rec.azAwal) : `${fmt(rec.azAwal)} - ${fmt(rec.azAkhir)}`;
  const tpl = template || DEFAULT_TEMPLATE;
  return tpl
    .replace(/\{sumur\}/g, rec.well)
    .replace(/\{well\}/g, rec.well)
    .replace(/\{formasi\}/g, rec.formation || "")
    .replace(/\{inc\}/g, inc)
    .replace(/\{az\}/g, az)
    .replace(/\{incAwal\}/g, fmt(rec.incAwal))
    .replace(/\{incAkhir\}/g, fmt(rec.incAkhir))
    .replace(/\{azAwal\}/g, fmt(rec.azAwal))
    .replace(/\{azAkhir\}/g, fmt(rec.azAkhir));
}

function legendText(rec) {
  if (rec.legendOverride) return rec.legendOverride;
  return makeLegend(rec, state.legendTemplate, state.decimalComma);
}

function defaultCaption(formation) {
  if (!formation || formation === "Tanpa formasi") return "Gambar 1. Inklinasi dan Azimuth.";
  return `Gambar 1. Inklinasi dan Azimuth di Formasi ${formation}.`;
}

function columnLetter(index) {
  let n = index + 1;
  let text = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    text = String.fromCharCode(65 + rem) + text;
    n = Math.floor((n - 1) / 26);
  }
  return text;
}

function fillRight(row, width) {
  const source = row || [];
  const count = Math.max(width || 0, source.length);
  const out = [];
  let last = "";
  for (let i = 0; i < count; i += 1) {
    const value = String(source[i] ?? "").trim();
    if (value) last = value;
    out.push(value || last);
  }
  return out;
}

function detectSimple(row) {
  const cols = {};
  (row || []).forEach((cell, index) => {
    const kind = classifyHeader(cell);
    if (kind && cols[kind] == null) cols[kind] = index;
  });
  if (cols.well == null) return null;
  if ([cols.azAwal, cols.azAkhir, cols.incAwal, cols.incAkhir].some((value) => value == null)) return null;
  return { type: "simple", cols };
}

function detectMulti(rows, index) {
  const norm = (rows[index] || []).map((cell) => NORM(cell));
  const awalIdx = [];
  const akhirIdx = [];
  norm.forEach((cell, col) => {
    if (["awal", "start", "initial"].includes(cell)) awalIdx.push(col);
    if (["akhir", "end", "final"].includes(cell)) akhirIdx.push(col);
  });
  if (awalIdx.length < 2 || akhirIdx.length < 2) return null;

  const width = Math.max(norm.length, ...rows.slice(Math.max(0, index - 3), index).map((row) => (row || []).length));
  const parents = [];
  for (let r = Math.max(0, index - 3); r < index; r += 1) parents.push(fillRight(rows[r], width));

  function parentText(col) {
    for (let p = parents.length - 1; p >= 0; p -= 1) {
      const text = NORM(parents[p][col] || "");
      if (!text) continue;
      if (["awal", "akhir", "start", "end", "initial", "final", "well", "sumur"].includes(text)) continue;
      return text;
    }
    return "";
  }

  const cols = {};
  function claim(kind, col) {
    if (cols[kind] == null) cols[kind] = col;
  }
  awalIdx.forEach((col) => {
    const label = parentText(col);
    if (isAzLabel(label)) claim("azAwal", col);
    else if (isIncLabel(label)) claim("incAwal", col);
  });
  akhirIdx.forEach((col) => {
    const label = parentText(col);
    if (isAzLabel(label)) claim("azAkhir", col);
    else if (isIncLabel(label)) claim("incAkhir", col);
  });
  if (cols.azAwal == null) cols.azAwal = awalIdx[0];
  if (cols.incAwal == null) cols.incAwal = awalIdx[1];
  if (cols.azAkhir == null) cols.azAkhir = akhirIdx[0];
  if (cols.incAkhir == null) cols.incAkhir = akhirIdx[1];
  const picked = [cols.azAwal, cols.azAkhir, cols.incAwal, cols.incAkhir];
  if (picked.some((value) => value == null) || new Set(picked).size < 4) return null;

  const used = new Set(picked);
  let wellCol = null;
  for (let r = Math.max(0, index - 3); r <= index && wellCol == null; r += 1) {
    const row = rows[r] || [];
    for (let c = 0; c < row.length; c += 1) {
      if (used.has(c)) continue;
      const text = NORM(row[c]);
      if (["well", "sumur", "nama sumur", "well name", "nama well", "nama"].includes(text)) {
        wellCol = c;
        break;
      }
    }
  }
  if (wellCol == null) {
    wellCol = 0;
    if (used.has(wellCol)) {
      for (let c = 0; c < width + 1; c += 1) {
        if (!used.has(c)) {
          wellCol = c;
          break;
        }
      }
    }
  }
  cols.well = wellCol;
  cols.formation = null;
  return { type: "multi", headerRow: index, dataStart: index + 1, cols };
}

function fallbackSheet(name) {
  const text = String(name || "").trim();
  if (!text || /^(sheet\d*|data|isian|contoh)$/i.test(text)) return "Tanpa formasi";
  return text;
}

function inferFormation(rows, block) {
  const headerWords = ["well", "sumur", "awal", "akhir", "start", "end", "initial", "final"];
  for (let r = block.headerRow - 1; r >= Math.max(0, block.headerRow - 6); r -= 1) {
    const row = rows[r] || [];
    const joined = row.map((cell) => NORM(cell)).filter(Boolean);
    if (!joined.length) continue;
    if (joined.some((text) => isAzLabel(text) || isIncLabel(text) || headerWords.includes(text))) continue;
    if (row.filter((cell) => num(cell) != null).length >= 2) break;
    for (const cell of row) {
      const text = String(cell ?? "").trim();
      if (text && text.length <= 80 && num(text) == null) return text;
    }
  }
  return "";
}

function rowToRecord(row, cols) {
  const well = String(row[cols.well] ?? "").trim();
  const azAwal = num(row[cols.azAwal]);
  const azAkhir = num(row[cols.azAkhir]);
  const incAwal = num(row[cols.incAwal]);
  const incAkhir = num(row[cols.incAkhir]);
  const values = [azAwal, azAkhir, incAwal, incAkhir];
  const present = values.filter((value) => value != null).length;
  if (present === 0) return null;
  if (present < 4) return "skip";
  const formationCell = cols.formation == null ? "" : String(row[cols.formation] ?? "").trim();
  return {
    well: well || "Tanpa nama",
    azAwal,
    azAkhir,
    incAwal,
    incAkhir,
    formationCell
  };
}

function collectBlock(rows, block, end, sheetName) {
  const records = [];
  let skipped = 0;
  const inferred = block.type === "simple" && block.cols.formation != null
    ? ""
    : (inferFormation(rows, block) || fallbackSheet(sheetName));
  let carried = inferred;
  for (let r = block.dataStart; r < end; r += 1) {
    const parsed = rowToRecord(rows[r] || [], block.cols);
    if (parsed === "skip") {
      skipped += 1;
      continue;
    }
    if (!parsed) continue;
    let formation = carried || fallbackSheet(sheetName);
    if (parsed.formationCell) {
      carried = parsed.formationCell;
      formation = parsed.formationCell;
    }
    records.push({
      formation: formation || "Tanpa formasi",
      well: parsed.well,
      azAwal: parsed.azAwal,
      azAkhir: parsed.azAkhir,
      incAwal: parsed.incAwal,
      incAkhir: parsed.incAkhir
    });
  }
  return { records, skipped };
}

function parseSheetRows(rows, sheetName) {
  const source = rows || [];
  const starts = [];
  for (let i = 0; i < source.length; i += 1) {
    const simple = detectSimple(source[i]);
    if (simple) {
      starts.push({ ...simple, headerRow: i, dataStart: i + 1 });
      continue;
    }
    const multi = detectMulti(source, i);
    if (multi) starts.push(multi);
  }
  if (!starts.length) {
    const hasContent = source.some((row) => (row || []).some((cell) => String(cell ?? "").trim() !== ""));
    return { records: [], skipped: 0, needsMapping: hasContent, empty: !hasContent };
  }
  const records = [];
  let skipped = 0;
  for (let b = 0; b < starts.length; b += 1) {
    const end = b + 1 < starts.length ? starts[b + 1].headerRow : source.length;
    const collected = collectBlock(source, starts[b], end, sheetName);
    records.push(...collected.records);
    skipped += collected.skipped;
  }
  return { records, skipped, needsMapping: false, empty: records.length === 0 };
}

function parseWorkbook(workbook) {
  const records = [];
  let skipped = 0;
  const sheets = [];
  let contentWithoutRows = false;
  for (const name of workbook.SheetNames) {
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[name], { header: 1, raw: true, defval: "" });
    sheets.push({ name, rows });
    const parsed = parseSheetRows(rows, name);
    records.push(...parsed.records);
    skipped += parsed.skipped;
    if (parsed.needsMapping) contentWithoutRows = true;
  }
  if (records.length > 500) records.length = 500;
  return {
    records,
    skipped,
    sheets,
    needsMapping: records.length === 0 && contentWithoutRows
  };
}

function decorate(rawList) {
  return rawList.map((rec, index) => ({
    id: uid(),
    formation: rec.formation || "Tanpa formasi",
    well: rec.well || "Tanpa nama",
    azAwal: Number(rec.azAwal),
    azAkhir: Number(rec.azAkhir),
    incAwal: Number(rec.incAwal),
    incAkhir: Number(rec.incAkhir),
    color: /^#[0-9a-fA-F]{6}$/.test(rec.color || "") ? rec.color : PALETTE[index % PALETTE.length],
    visible: rec.visible !== false,
    legendOverride: rec.legendOverride || null
  }));
}

function formationsOf(records) {
  const seen = [];
  records.forEach((rec) => {
    const name = rec.formation || "Tanpa formasi";
    if (!seen.includes(name)) seen.push(name);
  });
  return seen;
}

function currentFormationRecords() {
  return state.records.filter((rec) => rec.formation === state.formation);
}

function visibleRecords(records) {
  return (records || currentFormationRecords()).filter((rec) => rec.visible);
}

function readBound(value) {
  if (value == null || value === "" || !Number.isFinite(Number(value))) return null;
  return Number(value);
}

function incScale(records) {
  const step = state.incStep || 5;
  const list = records || [];
  const dataMax = list.reduce((max, rec) => Math.max(max, rec.incAwal, rec.incAkhir), 0);
  const userMin = readBound(state.incMin);
  const userMax = readBound(state.incMax);
  let min = userMin == null ? 0 : Math.max(0, userMin);
  let max = userMax == null
    ? Math.max(90, min + step, Math.ceil((Math.max(dataMax, 0) - 1e-6) / step) * step)
    : userMax;
  if (userMin != null && userMax != null && max < min) {
    const swap = min;
    min = Math.max(0, max);
    max = swap;
  }
  if (max <= min) max = min + step;
  return { min, max, step };
}

function incRadius(inc, scale) {
  const span = scale.max - scale.min;
  const clamped = Math.min(scale.max, Math.max(scale.min, Math.max(0, inc)));
  return (clamped - scale.min) / span * PLOT_R;
}

function hexToRgba(hex, alpha) {
  let h = String(hex || "").replace("#", "").trim();
  if (h.length === 3) h = h.split("").map((ch) => ch + ch).join("");
  if (!/^[0-9a-fA-F]{6}$/.test(h)) h = "888888";
  const n = parseInt(h, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

function measureCtx() {
  if (!measureCanvas) measureCanvas = document.createElement("canvas");
  return measureCanvas.getContext("2d");
}

function wrapText(ctx, text, maxWidth) {
  const words = String(text || "").split(/\s+/).filter(Boolean);
  if (!words.length) return [""];
  const lines = [];
  let line = "";
  words.forEach((word) => {
    const test = line ? `${line} ${word}` : word;
    if (ctx.measureText(test).width <= maxWidth) {
      line = test;
      return;
    }
    if (line) lines.push(line);
    if (ctx.measureText(word).width > maxWidth) {
      let chunk = "";
      for (const ch of word) {
        if (ctx.measureText(chunk + ch).width > maxWidth && chunk) {
          lines.push(chunk);
          chunk = ch;
        } else chunk += ch;
      }
      line = chunk;
    } else {
      line = word;
    }
  });
  if (line) lines.push(line);
  return lines.length ? lines : [""];
}

function legendLayout(ctx, records) {
  ctx.font = LEGEND_FONT;
  const items = records.map((rec) => {
    const lines = wrapText(ctx, legendText(rec), LEGEND_TEXT_W);
    return { rec, lines, h: Math.max(18, lines.length * 17) + 8 };
  });
  return {
    items,
    h: items.reduce((sum, item) => sum + item.h, 0),
    w: 16 + 8 + LEGEND_TEXT_W
  };
}

function layoutFor(records, caption) {
  const ctx = measureCtx();
  const legend = records.length ? legendLayout(ctx, records) : { items: [], h: 0, w: 0 };
  const plotBox = (PLOT_R + LABEL_PAD) * 2;
  const gap = records.length ? 34 : 0;
  const w = PAD_X + plotBox + gap + legend.w + PAD_X;
  ctx.font = CAPTION_FONT;
  const lines = wrapText(ctx, caption || "", Math.max(240, w - PAD_X * 2));
  const captionH = lines.length * 30 + 6;
  const contentH = Math.max(plotBox, legend.h);
  const h = PAD_TOP + contentH + 16 + captionH + PAD_BOTTOM;
  return { w, h, plotBox, legend, lines, contentH, gap };
}

function drawFigure(ctx, logical, records, caption, viewScale) {
  const scale = incScale(records);
  const plotCx = PAD_X + logical.plotBox / 2;
  const plotCy = PAD_TOP + logical.contentH / 2;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, logical.w, logical.h);

  ctx.lineJoin = "miter";
  ctx.lineCap = "butt";
  const rings = [];
  for (let inc = Math.ceil((scale.min + 1e-6) / scale.step) * scale.step; inc < scale.max - 0.001; inc += scale.step) {
    rings.push(inc);
  }
  rings.push(scale.max);
  rings.forEach((inc) => {
    const outer = Math.abs(inc - scale.max) < 0.001;
    ctx.beginPath();
    ctx.strokeStyle = outer ? "#8e8e8e" : "#d5d5d5";
    ctx.lineWidth = outer ? 1.15 : 0.8;
    ctx.arc(plotCx, plotCy, incRadius(inc, scale), 0, Math.PI * 2);
    ctx.stroke();
  });
  for (let az = 0; az < 360; az += 10) {
    const cardinal = az % 90 === 0;
    const rad = (az - 90) * Math.PI / 180;
    ctx.beginPath();
    ctx.strokeStyle = cardinal ? "#b5b5b5" : "#e1e1e1";
    ctx.lineWidth = cardinal ? 1 : 0.8;
    ctx.moveTo(plotCx, plotCy);
    ctx.lineTo(plotCx + PLOT_R * Math.cos(rad), plotCy + PLOT_R * Math.sin(rad));
    ctx.stroke();
  }

  const style = {
    arcMode: state.arcMode,
    strokeWidth: state.strokeWidth,
    fillOpacity: state.fillOpacity,
    viewScale: viewScale > 0 ? viewScale : 1
  };
  records.filter((rec) => rec.id !== state.hoverId).forEach((rec) => drawSector(ctx, plotCx, plotCy, scale, rec, style));
  const hovered = records.find((rec) => rec.id === state.hoverId);
  if (hovered) {
    drawSector(ctx, plotCx, plotCy, scale, hovered, {
      ...style,
      strokeWidth: style.strokeWidth + 1.4
    });
  }

  const labels = inclinationLabelValues(scale);
  ctx.font = INC_FONT;
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  ctx.lineWidth = 3;
  ctx.strokeStyle = "#ffffff";
  ctx.fillStyle = "#333333";
  labels.forEach((inc) => {
    const radius = incRadius(inc, scale);
    const y = radius < 8 ? plotCy : plotCy - radius;
    const label = formatNum(inc, state.decimalComma);
    ctx.strokeText(label, plotCx - 6, y);
    ctx.fillText(label, plotCx - 6, y);
  });

  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (let az = 0; az < 360; az += 10) {
    const rad = (az - 90) * Math.PI / 180;
    const r = PLOT_R + 18;
    const x = plotCx + r * Math.cos(rad);
    const y = plotCy + r * Math.sin(rad);
    ctx.font = az === 0 ? "bold 13px Arial, Helvetica, sans-serif" : AZ_FONT;
    ctx.strokeStyle = "#ffffff";
    ctx.fillStyle = "#222222";
    ctx.lineWidth = 3;
    ctx.strokeText(String(az), x, y);
    ctx.fillText(String(az), x, y);
  }

  if (logical.legend.items.length) {
    let y = PAD_TOP + (logical.contentH - logical.legend.h) / 2;
    const x = PAD_X + logical.plotBox + logical.gap;
    logical.legend.items.forEach((item) => {
      ctx.fillStyle = "#ffffff";
      ctx.strokeStyle = item.rec.color;
      ctx.lineWidth = 1.5;
      ctx.fillRect(x, y + 1, 13, 13);
      ctx.strokeRect(x + 0.5, y + 1.5, 13, 13);
      ctx.font = LEGEND_FONT;
      ctx.fillStyle = "#222222";
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      item.lines.forEach((line, lineIndex) => {
        ctx.fillText(line, x + 21, y + lineIndex * 17);
      });
      y += item.h;
    });
  }

  ctx.font = CAPTION_FONT;
  ctx.fillStyle = "#1a1a1a";
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  const captionTop = PAD_TOP + logical.contentH + 16;
  logical.lines.forEach((line, index) => {
    ctx.fillText(line, logical.w / 2, captionTop + index * 30);
  });
}

function visibleAzimuth(sweep, radius, viewScale) {
  const pxPerDeg = Math.max(radius, 8) * Math.PI / 180;
  if (sweep.sweep >= 359 || sweep.sweep * pxPerDeg * viewScale >= 8) return sweep;
  const padded = Math.min(Math.max(sweep.sweep, 8 / viewScale / pxPerDeg), sweep.sweep + 2.5);
  const extra = (padded - sweep.sweep) / 2;
  return { start: normAz(sweep.start - extra), sweep: padded };
}

function visibleInclination(low, high, scale, viewScale) {
  const span = high - low;
  const pxPerDeg = PLOT_R / Math.max(scale.max - scale.min, 0.001);
  if (span * pxPerDeg * viewScale >= 8) return { low, high };
  const padded = Math.min(Math.max(span, 8 / viewScale / pxPerDeg), span + 2);
  const mid = (low + high) / 2;
  return { low: mid - padded / 2, high: mid + padded / 2 };
}

function drawSector(ctx, cx, cy, scale, rec, style) {
  const viewScale = style.viewScale > 0 ? style.viewScale : 1;
  const rawSweep = sectorSweep(rec.azAwal, rec.azAkhir, style.arcMode);
  const rawLow = Math.min(rec.incAwal, rec.incAkhir);
  const rawHigh = Math.max(rec.incAwal, rec.incAkhir);
  const midRadius = (incRadius(rawLow, scale) + incRadius(rawHigh, scale)) / 2;
  const sweep = visibleAzimuth(rawSweep, midRadius, viewScale);
  const band = visibleInclination(rawLow, rawHigh, scale, viewScale);
  const low = band.low;
  const high = band.high;
  const r1 = incRadius(low, scale);
  const r2 = incRadius(high, scale);
  const a0 = (sweep.start - 90) * Math.PI / 180;
  const a1 = a0 + sweep.sweep * Math.PI / 180;
  const azPx = Math.max(midRadius, 8) * rawSweep.sweep * Math.PI / 180 * viewScale;
  const incPx = (rawHigh - rawLow) * PLOT_R / Math.max(scale.max - scale.min, 0.001) * viewScale;
  const small = azPx < 8 || incPx < 8;

  ctx.beginPath();
  ctx.strokeStyle = rec.color;
  ctx.lineWidth = small ? Math.max(style.strokeWidth, Math.min(4.2, 3.2 / viewScale)) : style.strokeWidth;
  ctx.lineJoin = small ? "round" : "miter";
  ctx.lineCap = small ? "round" : "butt";

  if (sweep.sweep < 0.25 && Math.abs(r2 - r1) < 1.2) {
    const r = (r1 + r2) / 2;
    const x = cx + r * Math.cos(a0);
    const y = cy + r * Math.sin(a0);
    const mark = Math.max(8, 9 / viewScale);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(x - mark / 2, y - mark / 2, mark, mark);
    ctx.strokeRect(x - mark / 2, y - mark / 2, mark, mark);
    return;
  }
  if (sweep.sweep < 0.25) {
    ctx.moveTo(cx + r1 * Math.cos(a0), cy + r1 * Math.sin(a0));
    ctx.lineTo(cx + r2 * Math.cos(a0), cy + r2 * Math.sin(a0));
    ctx.stroke();
    return;
  }
  if (Math.abs(r2 - r1) < 1.2) {
    ctx.arc(cx, cy, Math.max((r1 + r2) / 2, 1), a0, a1, false);
    ctx.stroke();
    return;
  }
  ctx.arc(cx, cy, r2, a0, a1, false);
  ctx.arc(cx, cy, Math.max(r1, 0), a1, a0, true);
  ctx.closePath();
  if (style.fillOpacity > 0) {
    ctx.fillStyle = hexToRgba(rec.color, style.fillOpacity);
    ctx.fill();
  }
  ctx.stroke();
}

function renderToCanvas(canvas, logical, records, caption, pixelScale, viewScale) {
  canvas.width = Math.max(1, Math.round(logical.w * pixelScale));
  canvas.height = Math.max(1, Math.round(logical.h * pixelScale));
  const ctx = canvas.getContext("2d");
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(pixelScale, 0, 0, pixelScale, 0, 0);
  drawFigure(ctx, logical, records, caption, viewScale);
  return canvas;
}

function requestDraw() {
  if (drawQueued) return;
  drawQueued = true;
  requestAnimationFrame(() => {
    drawQueued = false;
    draw();
  });
}

function updateZoomUi() {
  const label = document.getElementById("zoom-label");
  if (label) label.textContent = `${Math.round(state.viewZoom * 100)}%`;
  const zoomOut = document.getElementById("btn-zoom-out");
  const zoomIn = document.getElementById("btn-zoom-in");
  if (zoomOut) zoomOut.disabled = state.viewZoom <= ZOOM_MIN + 0.001;
  if (zoomIn) zoomIn.disabled = state.viewZoom >= ZOOM_MAX - 0.001;
}

function setViewZoom(next, event) {
  const zoom = clamp(Math.round(next / ZOOM_STEP) * ZOOM_STEP, ZOOM_MIN, ZOOM_MAX, 1);
  if (Math.abs(zoom - state.viewZoom) < 0.001) return;
  const sheet = document.getElementById("sheet");
  const canvas = document.getElementById("chart");
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
  state.viewZoom = zoom;
  updateZoomUi();
  requestDraw();
}

function zoomToArea(rect) {
  const sheet = document.getElementById("sheet");
  const canvas = document.getElementById("chart");
  if (!sheet || !canvas || !canvas.offsetWidth || rect.w < 8 || rect.h < 8) return;
  const scale = Math.min(sheet.clientWidth / rect.w, sheet.clientHeight / rect.h);
  zoomAnchor = {
    rx: (rect.x + rect.w / 2) / canvas.offsetWidth,
    ry: (rect.y + rect.h / 2) / canvas.offsetHeight,
    viewX: sheet.clientWidth / 2,
    viewY: sheet.clientHeight / 2
  };
  state.viewZoom = clamp(state.viewZoom * scale, ZOOM_MIN, ZOOM_MAX, state.viewZoom);
  updateZoomUi();
  requestDraw();
}

function draw() {
  const canvas = document.getElementById("chart");
  const sheet = document.getElementById("sheet");
  if (!canvas || !sheet) return;
  const records = visibleRecords();
  const caption = state.caption || defaultCaption(state.formation);
  const logical = layoutFor(records, caption);
  const avail = Math.max(280, sheet.clientWidth - 24);
  const fitWidth = Math.min(logical.w, avail);
  const cssWidth = fitWidth * state.viewZoom;
  const cssHeight = logical.h * (cssWidth / logical.w);
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const viewScale = cssWidth / logical.w;
  canvas.style.width = `${cssWidth}px`;
  canvas.style.height = `${cssHeight}px`;
  if (zoomAnchor) {
    sheet.scrollLeft = zoomAnchor.rx * cssWidth - zoomAnchor.viewX + canvas.offsetLeft;
    sheet.scrollTop = zoomAnchor.ry * cssHeight - zoomAnchor.viewY + canvas.offsetTop;
    zoomAnchor = null;
  }
  renderToCanvas(canvas, logical, records, caption, Math.min(viewScale * dpr, 4), viewScale);
  lastDraw = { logical, css: cssWidth / logical.w, records };
  updateZoomUi();
  updateMeta();
  updateZoomLabels();
}

function inclinationLabelValues(scale) {
  const span = scale.max - scale.min;
  const labelStep = (PLOT_R / span * scale.step) < 12 ? scale.step * 2 : scale.step;
  const labels = [];
  if (scale.min > 0.001) labels.push(scale.min);
  for (let inc = Math.ceil((scale.min + 1e-6) / labelStep) * labelStep; inc <= scale.max + 0.001; inc += labelStep) {
    if (!labels.some((value) => Math.abs(value - inc) < 0.001)) labels.push(inc);
  }
  if (!labels.some((value) => Math.abs(value - scale.max) < 0.001)) labels.push(scale.max);
  return labels;
}

function pointInRect(x, y, rect) {
  return x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h;
}

function clipSegment(x0, y0, x1, y1, rect) {
  let t0 = 0;
  let t1 = 1;
  const dx = x1 - x0;
  const dy = y1 - y0;
  const p = [-dx, dx, -dy, dy];
  const q = [x0 - rect.x, rect.x + rect.w - x0, y0 - rect.y, rect.y + rect.h - y0];
  for (let i = 0; i < 4; i += 1) {
    if (Math.abs(p[i]) < 1e-8) {
      if (q[i] < 0) return null;
    } else {
      const t = q[i] / p[i];
      if (p[i] < 0) {
        if (t > t1) return null;
        if (t > t0) t0 = t;
      } else {
        if (t < t0) return null;
        if (t < t1) t1 = t;
      }
    }
  }
  return {
    x0: x0 + t0 * dx,
    y0: y0 + t0 * dy,
    x1: x0 + t1 * dx,
    y1: y0 + t1 * dy
  };
}

function pointOnCircleInRect(cx, cy, radius, rect) {
  if (radius < 2) return pointInRect(cx, cy, rect) ? { x: cx, y: cy } : null;
  const hits = [];
  const push = (x, y) => {
    if (pointInRect(x, y, rect)) hits.push({ x, y });
  };
  [rect.y, rect.y + rect.h].forEach((y) => {
    const disc = radius * radius - (y - cy) * (y - cy);
    if (disc < 0) return;
    const root = Math.sqrt(disc);
    push(cx - root, y);
    push(cx + root, y);
  });
  [rect.x, rect.x + rect.w].forEach((x) => {
    const disc = radius * radius - (x - cx) * (x - cx);
    if (disc < 0) return;
    const root = Math.sqrt(disc);
    push(x, cy - root);
    push(x, cy + root);
  });
  for (let i = 0; i < 36; i += 1) {
    const angle = -Math.PI / 2 + i * Math.PI * 2 / 36;
    push(cx + radius * Math.cos(angle), cy + radius * Math.sin(angle));
  }
  if (!hits.length) return null;
  const midX = rect.x + rect.w / 2;
  hits.sort((a, b) => a.y - b.y || Math.abs(a.x - midX) - Math.abs(b.x - midX));
  return hits[0];
}

function updateZoomLabels() {
  const host = document.getElementById("zoom-labels");
  const canvas = document.getElementById("chart");
  const sheet = document.getElementById("sheet");
  if (!host || !canvas || !sheet || !lastDraw || !canvas.offsetWidth) return;
  host.replaceChildren();
  const { logical, css, records } = lastDraw;
  const scale = incScale(records);
  const cx = (PAD_X + logical.plotBox / 2) * css;
  const cy = (PAD_TOP + logical.contentH / 2) * css;
  const view = {
    x: sheet.scrollLeft - canvas.offsetLeft,
    y: sheet.scrollTop - canvas.offsetTop,
    w: sheet.clientWidth,
    h: sheet.clientHeight
  };
  const inset = {
    x: view.x + 18,
    y: view.y + 18,
    w: Math.max(0, view.w - 36),
    h: Math.max(0, view.h - 36)
  };
  const placed = [];
  const near = (x, y) => placed.some((item) => Math.hypot(item.x - x, item.y - y) < 16);
  const add = (x, y, text, kind) => {
    if (!pointInRect(x, y, inset) || near(x, y)) return;
    placed.push({ x, y });
    const tag = document.createElement("span");
    tag.className = kind === "az" ? "scale-tag az" : "scale-tag";
    tag.textContent = text;
    tag.style.left = `${canvas.offsetLeft + x}px`;
    tag.style.top = `${canvas.offsetTop + y}px`;
    host.appendChild(tag);
  };

  inclinationLabelValues(scale).forEach((inc) => {
    const radius = incRadius(inc, scale) * css;
    const fixedY = radius < 8 * css ? cy : cy - radius;
    if (pointInRect(cx - 6 * css, fixedY, view)) return;
    const point = pointOnCircleInRect(cx, cy, Math.max(radius, 0), inset);
    if (!point) return;
    add(point.x, point.y, formatNum(inc, state.decimalComma), "inc");
  });

  for (let az = 0; az < 360; az += 10) {
    const rad = (az - 90) * Math.PI / 180;
    const outer = (PLOT_R + 18) * css;
    if (pointInRect(cx + outer * Math.cos(rad), cy + outer * Math.sin(rad), view)) continue;
    const clip = clipSegment(
      cx,
      cy,
      cx + PLOT_R * css * Math.cos(rad),
      cy + PLOT_R * css * Math.sin(rad),
      inset
    );
    if (!clip) continue;
    const vx = clip.x0 - clip.x1;
    const vy = clip.y0 - clip.y1;
    const length = Math.hypot(vx, vy);
    if (length < 12) continue;
    const pull = Math.min(16, length / 2);
    add(clip.x1 + vx / length * pull, clip.y1 + vy / length * pull, String(az), "az");
  }
}

function updateMeta() {
  const all = currentFormationRecords();
  const shown = all.filter((rec) => rec.visible);
  const count = document.getElementById("visible-count");
  if (count) {
    const hiddenCount = all.length - shown.length;
    count.hidden = hiddenCount === 0;
    if (hiddenCount) count.textContent = `${shown.length} dari ${all.length} sumur ditampilkan`;
  }
  const forms = formationsOf(state.records);
  const pdfWrap = document.getElementById("pdf-all-wrap");
  if (pdfWrap) pdfWrap.hidden = forms.length < 2;
  const disabled = shown.length === 0;
  ["btn-png", "btn-jpg", "btn-pdf"].forEach((id) => {
    const button = document.getElementById(id);
    if (button) button.disabled = disabled;
  });
  const scaleNote = document.getElementById("scale-note");
  if (scaleNote) {
    const basis = shown.length ? shown : all;
    const scale = incScale(basis);
    const outside = basis.filter((rec) => (
      Math.min(rec.incAwal, rec.incAkhir) < scale.min - 0.01 ||
      Math.max(rec.incAwal, rec.incAkhir) > scale.max + 0.01
    )).length;
    let text = `Skala inklinasi pada gambar: ${formatNum(scale.min, state.decimalComma)}–${formatNum(scale.max, state.decimalComma)}°.`;
    if (scale.min > 0) text += ` Pusat chart = ${formatNum(scale.min, state.decimalComma)}°.`;
    if (outside) text += ` ${outside} sumur melewati batas dan dipotong pada skala.`;
    scaleNote.textContent = text;
  }
}

function setStatus(text) {
  const el = document.getElementById("status");
  if (el) el.textContent = text || "";
}

function fileStem() {
  const raw = (state.caption || "azimuth-inklinasi").trim();
  const slug = raw
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
  return slug || "azimuth-inklinasi";
}

function projectData() {
  return {
    records: state.records,
    formation: state.formation,
    caption: state.caption,
    captionTouched: state.captionTouched,
    arcMode: state.arcMode,
    strokeWidth: state.strokeWidth,
    fillOpacity: state.fillOpacity,
    incStep: state.incStep,
    incMin: state.incMin,
    incMax: state.incMax,
    decimalComma: state.decimalComma,
    legendTemplate: state.legendTemplate,
    pdfAll: state.pdfAll
  };
}

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(projectData()));
  } catch (err) {
    /* Penyimpanan lokal bisa penuh atau diblokir. Gambar tetap bisa dipakai. */
  }
}

function applyStored(data) {
  if (!data || !Array.isArray(data.records)) return false;
    const records = data.records.map((rec, index) => ({
      id: rec.id || uid(),
      formation: rec.formation || "Tanpa formasi",
      well: rec.well || "Tanpa nama",
      azAwal: Number(rec.azAwal),
      azAkhir: Number(rec.azAkhir),
      incAwal: Number(rec.incAwal),
      incAkhir: Number(rec.incAkhir),
      color: /^#[0-9a-fA-F]{6}$/.test(rec.color || "") ? rec.color : PALETTE[index % PALETTE.length],
      visible: rec.visible !== false,
      legendOverride: rec.legendOverride || null
    })).filter((rec) => [rec.azAwal, rec.azAkhir, rec.incAwal, rec.incAkhir].every(Number.isFinite));
    if (!records.length) return false;
    state.records = records;
    state.formation = data.formation && records.some((rec) => rec.formation === data.formation)
      ? data.formation
      : records[0].formation;
    state.caption = data.caption || defaultCaption(state.formation);
    state.captionTouched = !!data.captionTouched;
    state.arcMode = ["short", "cw", "ccw"].includes(data.arcMode) ? data.arcMode : "short";
    state.strokeWidth = clamp(data.strokeWidth, 0.5, 6, 1.8);
    state.fillOpacity = clamp(data.fillOpacity, 0, 0.75, 0);
    state.incStep = Number(data.incStep) === 10 ? 10 : 5;
    state.incMin = readBound(data.incMin);
    state.incMax = readBound(data.incMax);
    state.decimalComma = !!data.decimalComma;
    state.legendTemplate = data.legendTemplate || DEFAULT_TEMPLATE;
    state.pdfAll = data.pdfAll !== false;
    return true;
}

function loadStored() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return false;
    return applyStored(JSON.parse(raw));
  } catch (err) {
    return false;
  }
}

window.AzimuthChart = {
  snapshot: projectData,
  load(data) {
    if (!applyStored(data)) return false;
    applyStateToForm();
    refreshView();
    persist();
    return true;
  }
};

function applyStateToForm() {
  document.getElementById("caption").value = state.caption;
  document.getElementById("arc-mode").value = state.arcMode;
  document.getElementById("inc-min").value = state.incMin == null ? "" : state.incMin;
  document.getElementById("inc-max").value = state.incMax == null ? "" : state.incMax;
  document.getElementById("inc-step").value = String(state.incStep);
  document.getElementById("stroke-width").value = String(state.strokeWidth);
  document.getElementById("stroke-width-value").textContent = Number(state.strokeWidth).toFixed(1);
  document.getElementById("fill-opacity").value = String(state.fillOpacity);
  document.getElementById("fill-opacity-value").textContent = `${Math.round(state.fillOpacity * 100)}%`;
  document.getElementById("decimal-comma").value = state.decimalComma ? "comma" : "dot";
  document.getElementById("legend-template").value = state.legendTemplate;
  document.getElementById("pdf-all").checked = state.pdfAll;
}

function renderFormationControls() {
  const forms = formationsOf(state.records);
  if (!forms.includes(state.formation)) state.formation = forms[0] || "Tanpa formasi";
  const select = document.getElementById("formation-select");
  const wrap = document.getElementById("formation-select-wrap");
  wrap.hidden = forms.length < 2;
  const signature = forms.join("|");
  if (select.dataset.signature !== signature) {
    select.innerHTML = forms.map((name) => `<option value="${esc(name)}">${esc(name)}</option>`).join("");
    select.dataset.signature = signature;
  }
  select.value = state.formation;
  const name = document.getElementById("formation-name");
  if (document.activeElement !== name) name.value = state.formation;
}

function renderWellList() {
  const host = document.getElementById("wells");
  const rows = currentFormationRecords();
  host.innerHTML = "";
  if (!rows.length) {
    host.innerHTML = '<p class="empty">Belum ada sumur pada formasi ini.</p>';
    return;
  }
  const fragment = document.createDocumentFragment();
  rows.forEach((rec, index) => {
    const article = document.createElement("article");
    article.className = "well";
    article.dataset.id = rec.id;
    const customLegend = rec.legendOverride != null && String(rec.legendOverride).trim() !== "";
    article.innerHTML = `
      <div class="well-top">
        <input type="color" data-field="color" value="${esc(rec.color)}" aria-label="Warna ${esc(rec.well)}" />
        <label class="check"><input type="checkbox" data-field="visible" ${rec.visible ? "checked" : ""} /> Tampil</label>
        <input type="text" data-field="well" value="${esc(rec.well)}" aria-label="Nama sumur" spellcheck="false" />
        <div class="well-actions">
          <button type="button" data-action="up" aria-label="Naik" title="Naik" ${index === 0 ? "disabled" : ""}>↑</button>
          <button type="button" data-action="down" aria-label="Turun" title="Turun" ${index === rows.length - 1 ? "disabled" : ""}>↓</button>
          <button type="button" data-action="delete" aria-label="Hapus" title="Hapus">Hapus</button>
        </div>
      </div>
      <div class="well-grid">
        <label>Azimuth awal<input type="number" step="any" data-field="azAwal" value="${esc(rec.azAwal)}" /></label>
        <label>Azimuth akhir<input type="number" step="any" data-field="azAkhir" value="${esc(rec.azAkhir)}" /></label>
        <label>Inklinasi awal<input type="number" step="any" data-field="incAwal" value="${esc(rec.incAwal)}" /></label>
        <label>Inklinasi akhir<input type="number" step="any" data-field="incAkhir" value="${esc(rec.incAkhir)}" /></label>
      </div>
      <details class="well-legend"${customLegend ? " open" : ""}>
        <summary>${customLegend ? "Legenda khusus" : "Legenda"}</summary>
        <label class="legend-field">Teks legenda
          <input type="text" data-field="legend" value="${esc(legendText(rec))}" spellcheck="false" />
        </label>
      </details>`;
    fragment.appendChild(article);
  });
  host.appendChild(fragment);
}

function refreshView() {
  renderFormationControls();
  renderWellList();
  requestDraw();
}

function loadDataset(rawRecords, options = {}) {
  state.records = decorate(rawRecords);
  state.formation = options.formation && state.records.some((rec) => rec.formation === options.formation)
    ? options.formation
    : (formationsOf(state.records)[0] || "Tanpa formasi");
  if (options.resetStyle) {
    state.arcMode = "short";
    state.fillOpacity = 0;
    state.strokeWidth = 1.8;
    state.decimalComma = false;
    state.incStep = 5;
    state.incMin = null;
    state.legendTemplate = DEFAULT_TEMPLATE;
  }
  if (options.autoScale) {
    state.incMin = null;
    state.incMax = null;
  }
  if (Object.prototype.hasOwnProperty.call(options, "incMin")) state.incMin = options.incMin;
  if (Object.prototype.hasOwnProperty.call(options, "incMax")) state.incMax = options.incMax;
  state.caption = options.caption || defaultCaption(state.formation);
  state.captionTouched = !!options.captionTouched;
  state.hoverId = null;
  applyStateToForm();
  refreshView();
  persist();
  if (options.status) setStatus(options.status);
}

function describeImport(records, skipped) {
  const forms = formationsOf(records.map((rec) => ({ formation: rec.formation || "Tanpa formasi" })));
  const formText = forms.length > 1 ? `${forms.length} formasi` : `formasi ${forms[0] || "Tanpa formasi"}`;
  let text = `${records.length} sumur pada ${formText} berhasil dibaca.`;
  if (skipped) text += ` ${skipped} baris dilewati karena angkanya tidak lengkap.`;
  if (records.length >= 500) text += " Hanya 500 sumur pertama yang dimuat.";
  return text;
}

function readFile(file) {
  if (typeof XLSX === "undefined") {
    setStatus("Pustaka Excel belum termuat. Buka ulang halaman ini.");
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const workbook = XLSX.read(new Uint8Array(reader.result), { type: "array" });
      const parsed = parseWorkbook(workbook);
      state.sheets = parsed.sheets;
      if (!parsed.records.length) {
        showMapper(parsed.needsMapping
          ? "Kolom tidak dikenali. Pilih kolom sumur, azimuth, dan inklinasi."
          : "File terbaca, tetapi tidak ada baris data.");
        return;
      }
      document.getElementById("mapper").hidden = true;
      loadDataset(parsed.records, {
        autoScale: true,
        status: describeImport(parsed.records, parsed.skipped)
      });
    } catch (err) {
      setStatus("File tidak bisa dibaca. Gunakan Excel .xlsx, .xls, atau CSV.");
    }
  };
  reader.readAsArrayBuffer(file);
}

function headerCells(rows, headerRow) {
  const row = rows[headerRow] || [];
  return row.length ? row : ["", "", "", "", "", "", "", ""];
}

function columnOptions(row, includeBlank) {
  const options = [];
  if (includeBlank) options.push('<option value="">Tidak ada</option>');
  headerCells([row], 0).forEach((cell, index) => {
    const label = String(cell ?? "").trim() || "(kosong)";
    options.push(`<option value="${index}">${columnLetter(index)}: ${esc(label)}</option>`);
  });
  return options.join("");
}

function activeMapSheet() {
  const select = document.getElementById("map-sheet");
  return state.sheets[Number(select.value)] || state.sheets[0];
}

function fillMapperColumns() {
  const sheet = activeMapSheet();
  if (!sheet) return;
  const headerRow = Math.max(0, Number(document.getElementById("map-header-row").value) - 1);
  const row = headerCells(sheet.rows, headerRow);
  document.getElementById("map-well").innerHTML = columnOptions(row, false);
  document.getElementById("map-az-awal").innerHTML = columnOptions(row, false);
  document.getElementById("map-az-akhir").innerHTML = columnOptions(row, false);
  document.getElementById("map-inc-awal").innerHTML = columnOptions(row, false);
  document.getElementById("map-inc-akhir").innerHTML = columnOptions(row, false);
  document.getElementById("map-formation").innerHTML = columnOptions(row, true);
  const simple = detectSimple(row);
  if (simple) {
    document.getElementById("map-well").value = String(simple.cols.well);
    document.getElementById("map-az-awal").value = String(simple.cols.azAwal);
    document.getElementById("map-az-akhir").value = String(simple.cols.azAkhir);
    document.getElementById("map-inc-awal").value = String(simple.cols.incAwal);
    document.getElementById("map-inc-akhir").value = String(simple.cols.incAkhir);
    if (simple.cols.formation != null) document.getElementById("map-formation").value = String(simple.cols.formation);
  }
  renderMapPreview();
}

function renderMapPreview() {
  const sheet = activeMapSheet();
  const host = document.getElementById("map-preview");
  if (!sheet) {
    host.innerHTML = "";
    return;
  }
  const headerRow = Math.max(0, Number(document.getElementById("map-header-row").value) - 1);
  const rows = sheet.rows.slice(0, 8);
  const width = rows.reduce((max, row) => Math.max(max, (row || []).length), 0);
  let html = "<table><tbody>";
  rows.forEach((row, index) => {
    html += `<tr class="${index === headerRow ? "header-row" : ""}">`;
    for (let c = 0; c < width; c += 1) html += `<td>${esc(row[c] ?? "")}</td>`;
    html += "</tr>";
  });
  html += "</tbody></table>";
  host.innerHTML = html;
}

function showMapper(message) {
  const mapper = document.getElementById("mapper");
  mapper.hidden = false;
  const select = document.getElementById("map-sheet");
  select.innerHTML = state.sheets.map((sheet, index) => `<option value="${index}">${esc(sheet.name)}</option>`).join("");
  fillMapperColumns();
  if (message) setStatus(message);
}

function applyMapping() {
  const sheet = activeMapSheet();
  if (!sheet) {
    setStatus("Belum ada lembar Excel untuk dipetakan.");
    return;
  }
  const headerRow = Math.max(0, Number(document.getElementById("map-header-row").value) - 1);
  const formationValue = document.getElementById("map-formation").value;
  const block = {
    type: "simple",
    headerRow,
    dataStart: headerRow + 1,
    cols: {
      well: Number(document.getElementById("map-well").value),
      azAwal: Number(document.getElementById("map-az-awal").value),
      azAkhir: Number(document.getElementById("map-az-akhir").value),
      incAwal: Number(document.getElementById("map-inc-awal").value),
      incAkhir: Number(document.getElementById("map-inc-akhir").value),
      formation: formationValue === "" ? null : Number(formationValue)
    }
  };
  const collected = collectBlock(sheet.rows, block, sheet.rows.length, sheet.name);
  if (!collected.records.length) {
    setStatus("Tidak ada data pada kolom yang dipilih.");
    return;
  }
  const typedName = document.getElementById("map-formation-name").value.trim();
  if (typedName && block.cols.formation == null) {
    collected.records.forEach((rec) => {
      if (!rec.formation || rec.formation === fallbackSheet(sheet.name) || rec.formation === "Tanpa formasi") {
        rec.formation = typedName;
      }
    });
  }
  document.getElementById("mapper").hidden = true;
  loadDataset(collected.records, {
    autoScale: true,
    status: describeImport(collected.records, collected.skipped)
  });
}

function syncAutoLegends() {
  document.querySelectorAll("#wells .well").forEach((el) => {
    const rec = state.records.find((item) => item.id === el.dataset.id);
    if (!rec || rec.legendOverride) return;
    const input = el.querySelector('[data-field="legend"]');
    if (input && document.activeElement !== input) input.value = legendText(rec);
  });
}

function readNumber(input) {
  const raw = String(input.value).trim().replace(",", ".");
  if (raw === "" || raw === "-" || raw === "." || raw === "-.") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function findRecord(id) {
  return state.records.find((rec) => rec.id === id);
}

function onWellInput(event) {
  const row = event.target.closest(".well");
  if (!row) return;
  const rec = findRecord(row.dataset.id);
  if (!rec) return;
  const field = event.target.dataset.field;
  if (!field) return;
  if (field === "visible") {
    rec.visible = event.target.checked;
  } else if (field === "color") {
    rec.color = event.target.value;
  } else if (field === "well") {
    rec.well = event.target.value.trim() || "Tanpa nama";
  } else if (field === "legend") {
    const auto = makeLegend(rec, state.legendTemplate, state.decimalComma);
    rec.legendOverride = event.target.value === auto ? null : event.target.value;
  } else if (["azAwal", "azAkhir", "incAwal", "incAkhir"].includes(field)) {
    const value = readNumber(event.target);
    if (value == null) return;
    rec[field] = value;
  }
  if (field !== "legend" && !rec.legendOverride) {
    const legendInput = row.querySelector('[data-field="legend"]');
    if (legendInput) legendInput.value = legendText(rec);
  }
  persist();
  requestDraw();
}

function moveRecord(id, direction) {
  const rec = findRecord(id);
  if (!rec) return;
  const same = state.records.filter((item) => item.formation === rec.formation);
  const index = same.findIndex((item) => item.id === id);
  const target = same[index + direction];
  if (!target) return;
  const from = state.records.indexOf(rec);
  const to = state.records.indexOf(target);
  state.records[from] = target;
  state.records[to] = rec;
}

function onWellClick(event) {
  const button = event.target.closest("button");
  if (!button) return;
  const row = button.closest(".well");
  if (!row) return;
  const id = row.dataset.id;
  if (button.dataset.action === "delete") {
    state.records = state.records.filter((rec) => rec.id !== id);
    if (!formationsOf(state.records).includes(state.formation)) {
      state.formation = formationsOf(state.records)[0] || "Tanpa formasi";
      if (!state.captionTouched) state.caption = defaultCaption(state.formation);
    }
  } else if (button.dataset.action === "up") {
    moveRecord(id, -1);
  } else if (button.dataset.action === "down") {
    moveRecord(id, 1);
  } else return;
  persist();
  applyStateToForm();
  refreshView();
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

function figureCanvas(records, caption) {
  const logical = layoutFor(records, caption);
  const canvas = document.createElement("canvas");
  renderToCanvas(canvas, logical, records, caption, EXPORT_SCALE);
  return { canvas, logical };
}

async function exportImage(kind) {
  const records = visibleRecords();
  if (!records.length) return;
  const buttons = ["btn-png", "btn-jpg", "btn-pdf"].map((id) => document.getElementById(id));
  buttons.forEach((button) => { button.disabled = true; });
  try {
    if (kind === "pdf") {
      await exportPdf();
      return;
    }
    const caption = state.caption || defaultCaption(state.formation);
    const { canvas } = figureCanvas(records, caption);
    const type = kind === "jpg" ? "image/jpeg" : "image/png";
    const blob = await canvasBlob(canvas, type, 0.95);
    if (!blob) throw new Error("blob");
    downloadBlob(blob, `${fileStem()}.${kind === "jpg" ? "jpg" : "png"}`);
    setStatus(kind === "jpg" ? "JPG berhasil diunduh." : "PNG berhasil diunduh.");
  } catch (err) {
    setStatus("Gambar gagal dibuat. Coba lagi.");
  } finally {
    updateMeta();
  }
}

function captionsFor(formation, multi) {
  if (!multi) return [state.caption || defaultCaption(formation)];
  if (!state.captionTouched) return [defaultCaption(formation)];
  const base = state.caption || defaultCaption(formation);
  if (base.toLowerCase().includes(String(formation).toLowerCase())) return [base];
  return [base, formation];
}

async function exportPdf() {
  if (!window.jspdf || !window.jspdf.jsPDF) {
    setStatus("Pustaka PDF belum termuat. Buka ulang halaman ini.");
    return;
  }
  const forms = formationsOf(state.records);
  const multi = state.pdfAll && forms.length > 1;
  const pages = (multi ? forms : [state.formation]).map((formation) => {
    const records = state.records.filter((rec) => rec.formation === formation && rec.visible);
    const caption = captionsFor(formation, multi).join(" ");
    return { formation, records, caption };
  }).filter((page) => page.records.length);
  if (!pages.length) return;
  const prepared = pages.map((page) => ({ ...page, ...figureCanvas(page.records, page.caption) }));
  const { jsPDF } = window.jspdf;
  const firstOrientation = prepared[0].logical.h > prepared[0].logical.w ? "portrait" : "landscape";
  const pdf = new jsPDF({ orientation: firstOrientation, unit: "mm", format: "a4" });
  prepared.forEach((page, index) => {
    const { canvas, logical } = page;
    if (index > 0) {
      const orientation = logical.h > logical.w ? "portrait" : "landscape";
      pdf.addPage("a4", orientation);
    }
    const pageW = pdf.internal.pageSize.getWidth();
    const pageH = pdf.internal.pageSize.getHeight();
    const margin = 10;
    const maxW = pageW - margin * 2;
    const maxH = pageH - margin * 2;
    const ratio = logical.w / logical.h;
    let w = maxW;
    let h = w / ratio;
    if (h > maxH) {
      h = maxH;
      w = h * ratio;
    }
    const x = (pageW - w) / 2;
    const y = (pageH - h) / 2;
    pdf.addImage(canvas.toDataURL("image/png"), "PNG", x, y, w, h);
  });
  pdf.setProperties({ title: state.caption || "Azimuth dan inklinasi", subject: "Chart azimuth dan inklinasi" });
  pdf.save(`${fileStem()}.pdf`);
  setStatus(pages.length > 1 ? `PDF ${pages.length} halaman berhasil diunduh.` : "PDF berhasil diunduh.");
}

function downloadTemplate() {
  if (typeof XLSX === "undefined") {
    setStatus("Pustaka Excel belum termuat.");
    return;
  }
  const rows = [
    ["Formasi", "Sumur", "Azimuth Awal", "Azimuth Akhir", "Inklinasi Awal", "Inklinasi Akhir"],
    ["Parigi Top", "OOA-1", 236.16, 240.85, 28.75, 58.19],
    ["Parigi Top", "OOA-2ST2", 151.69, 152.39, 42.2, 57.69],
    ["Parigi Top", "OOA-3", 79.37, 283.01, 0.69, 16.42],
    ["Parigi Top", "OOA-4", 0.33, 359.33, 46.41, 72.63]
  ];
  const book = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  sheet["!cols"] = [{ wch: 16 }, { wch: 14 }, { wch: 16 }, { wch: 16 }, { wch: 18 }, { wch: 18 }];
  XLSX.utils.book_append_sheet(book, sheet, "Data");
  XLSX.writeFile(book, "template-azimuth-inklinasi.xlsx");
  setStatus("Template Excel berhasil diunduh.");
}

function createWell(partial = {}) {
  const used = new Set(state.records.map((rec) => String(rec.color || "").toLowerCase()));
  const color = PALETTE.find((item) => !used.has(item.toLowerCase())) || PALETTE[state.records.length % PALETTE.length];
  return {
    id: uid(),
    formation: state.formation || "Tanpa formasi",
    well: partial.well || `Sumur ${currentFormationRecords().length + 1}`,
    azAwal: partial.azAwal ?? 0,
    azAkhir: partial.azAkhir ?? 10,
    incAwal: partial.incAwal ?? 0,
    incAkhir: partial.incAkhir ?? 30,
    color: partial.color || color,
    visible: true,
    legendOverride: null
  };
}

function applyPaste() {
  const box = document.getElementById("paste-box");
  const pairs = parsePastedPairs(box.value);
  if (!pairs.length) {
    setStatus("Tidak ada pasangan angka. Salin dua kolom dari Excel (awal dan akhir), lalu tempel.");
    return;
  }
  const inclination = document.getElementById("paste-target").value === "inclination";
  const awalKey = inclination ? "incAwal" : "azAwal";
  const akhirKey = inclination ? "incAkhir" : "azAkhir";
  const wells = currentFormationRecords();
  let added = 0;
  pairs.forEach((pair, index) => {
    const rec = wells[index];
    if (!rec) {
      const created = createWell(inclination
        ? { incAwal: pair[0], incAkhir: pair[1] }
        : { azAwal: pair[0], azAkhir: pair[1] });
      state.records.push(created);
      wells.push(created);
      added += 1;
      return;
    }
    rec[awalKey] = pair[0];
    rec[akhirKey] = pair[1];
  });
  box.value = "";
  persist();
  renderWellList();
  requestDraw();
  const target = inclination ? "inklinasi" : "azimuth";
  const extra = added ? ` ${added} sumur baru ditambahkan.` : "";
  setStatus(`${pairs.length} baris ditempel ke ${target} sumur pada formasi ${state.formation}.${extra}`);
}

function bindWellList() {
  const host = document.getElementById("wells");
  host.addEventListener("input", onWellInput);
  host.addEventListener("change", onWellInput);
  host.addEventListener("click", onWellClick);
  host.addEventListener("mouseover", (event) => {
    const well = event.target.closest(".well");
    const id = well ? well.dataset.id : null;
    if (id === state.hoverId) return;
    state.hoverId = id;
    host.querySelectorAll(".well").forEach((el) => el.classList.toggle("hot", el.dataset.id === id));
    requestDraw();
  });
  host.addEventListener("mouseleave", () => {
    state.hoverId = null;
    host.querySelectorAll(".well").forEach((el) => el.classList.remove("hot"));
    requestDraw();
  });
}

function init() {
  const restored = loadStored();
  if (!restored) {
    loadDataset(PARIGI, {
      resetStyle: true,
      autoScale: true,
      caption: defaultCaption("Parigi Top"),
      status: "Contoh Parigi Top dimuat. Unggah Excel Anda untuk menggantinya."
    });
  } else {
    applyStateToForm();
    refreshView();
    setStatus("Data terakhir dibuka kembali.");
  }

  const dropzone = document.getElementById("dropzone");
  const fileInput = document.getElementById("file");
  fileInput.addEventListener("change", () => {
    const file = fileInput.files && fileInput.files[0];
    if (file) readFile(file);
    fileInput.value = "";
  });
  ["dragenter", "dragover"].forEach((name) => {
    dropzone.addEventListener(name, (event) => {
      event.preventDefault();
      dropzone.classList.add("hot");
    });
  });
  ["dragleave", "drop"].forEach((name) => {
    dropzone.addEventListener(name, (event) => {
      event.preventDefault();
      dropzone.classList.remove("hot");
    });
  });
  dropzone.addEventListener("drop", (event) => {
    const file = event.dataTransfer.files && event.dataTransfer.files[0];
    if (file) readFile(file);
  });

  document.getElementById("btn-template").addEventListener("click", downloadTemplate);
  document.getElementById("btn-manual").addEventListener("click", () => {
    if (!state.sheets.length) {
      setStatus("Unggah file Excel terlebih dahulu, lalu atur kolomnya jika perlu.");
      return;
    }
    showMapper("Pilih kolom yang sesuai dengan file Anda.");
  });
  document.getElementById("btn-sample-parigi").addEventListener("click", () => {
    loadDataset(PARIGI, {
      resetStyle: true,
      autoScale: true,
      caption: defaultCaption("Parigi Top"),
      status: "Contoh Parigi Top dimuat."
    });
  });
  document.getElementById("btn-sample-wpa").addEventListener("click", () => {
    loadDataset(WPA, {
      resetStyle: true,
      incMax: 95,
      caption: "Gambar 4.9. Inklinasi dan Azimuth di Lapangan WPA, UPA.",
      captionTouched: true,
      status: "Contoh laporan WPA dan UPA dimuat."
    });
  });
  document.getElementById("map-apply").addEventListener("click", applyMapping);
  document.getElementById("map-sheet").addEventListener("change", fillMapperColumns);
  document.getElementById("map-header-row").addEventListener("input", fillMapperColumns);

  document.getElementById("formation-select").addEventListener("change", (event) => {
    state.formation = event.target.value;
    if (!state.captionTouched) {
      state.caption = defaultCaption(state.formation);
      document.getElementById("caption").value = state.caption;
    }
    document.getElementById("formation-name").value = state.formation;
    persist();
    renderWellList();
    requestDraw();
  });
  document.getElementById("formation-name").addEventListener("change", (event) => {
    const next = event.target.value.trim() || "Tanpa formasi";
    const prev = state.formation;
    if (next === prev) return;
    state.records.forEach((rec) => {
      if (rec.formation === prev) rec.formation = next;
    });
    state.formation = next;
    if (!state.captionTouched) {
      state.caption = defaultCaption(next);
      document.getElementById("caption").value = state.caption;
    }
    persist();
    renderFormationControls();
    requestDraw();
  });
  document.getElementById("caption").addEventListener("input", (event) => {
    state.caption = event.target.value;
    state.captionTouched = true;
    persist();
    requestDraw();
  });
  document.getElementById("arc-mode").addEventListener("change", (event) => {
    state.arcMode = event.target.value;
    persist();
    requestDraw();
  });
  document.getElementById("inc-min").addEventListener("input", (event) => {
    const text = event.target.value.trim();
    state.incMin = text === "" ? null : Math.max(0, Number(text));
    persist();
    requestDraw();
  });
  document.getElementById("inc-max").addEventListener("input", (event) => {
    const text = event.target.value.trim();
    state.incMax = text === "" ? null : Number(text);
    persist();
    requestDraw();
  });
  document.getElementById("inc-step").addEventListener("change", (event) => {
    state.incStep = Number(event.target.value) === 10 ? 10 : 5;
    persist();
    requestDraw();
  });
  document.getElementById("stroke-width").addEventListener("input", (event) => {
    state.strokeWidth = Number(event.target.value);
    document.getElementById("stroke-width-value").textContent = state.strokeWidth.toFixed(1);
    persist();
    requestDraw();
  });
  document.getElementById("fill-opacity").addEventListener("input", (event) => {
    state.fillOpacity = Number(event.target.value);
    document.getElementById("fill-opacity-value").textContent = `${Math.round(state.fillOpacity * 100)}%`;
    persist();
    requestDraw();
  });
  document.getElementById("pdf-all").addEventListener("change", (event) => {
    state.pdfAll = event.target.checked;
    persist();
  });
  document.getElementById("legend-template").addEventListener("input", (event) => {
    state.legendTemplate = event.target.value || DEFAULT_TEMPLATE;
    syncAutoLegends();
    persist();
    requestDraw();
  });
  document.getElementById("decimal-comma").addEventListener("change", (event) => {
    state.decimalComma = event.target.value === "comma";
    syncAutoLegends();
    persist();
    requestDraw();
  });
  document.getElementById("btn-legend-reset").addEventListener("click", () => {
    state.records.forEach((rec) => { rec.legendOverride = null; });
    persist();
    renderWellList();
    requestDraw();
  });
  document.getElementById("btn-recolor").addEventListener("click", () => {
    state.records.forEach((rec, index) => { rec.color = PALETTE[index % PALETTE.length]; });
    persist();
    renderWellList();
    requestDraw();
  });
  document.getElementById("btn-paste").addEventListener("click", applyPaste);
  document.getElementById("btn-add-well").addEventListener("click", () => {
    state.records.push(createWell({ well: "Sumur baru", azAkhir: 20, incAwal: 10, incAkhir: 40 }));
    persist();
    renderWellList();
    requestDraw();
  });
  document.getElementById("btn-png").addEventListener("click", () => exportImage("png"));
  document.getElementById("btn-jpg").addEventListener("click", () => exportImage("jpg"));
  document.getElementById("btn-pdf").addEventListener("click", () => exportImage("pdf"));
  document.getElementById("btn-zoom-out").addEventListener("click", () => setViewZoom(state.viewZoom - ZOOM_STEP));
  document.getElementById("btn-zoom-in").addEventListener("click", () => setViewZoom(state.viewZoom + ZOOM_STEP));
  document.getElementById("btn-zoom-reset").addEventListener("click", () => setViewZoom(1));
  const areaButton = document.getElementById("btn-zoom-area");
  const canvas = document.getElementById("chart");
  const sheet = document.getElementById("sheet");
  const marquee = document.getElementById("marquee");
  areaButton.addEventListener("click", () => {
    const on = areaButton.getAttribute("aria-pressed") !== "true";
    areaButton.setAttribute("aria-pressed", on ? "true" : "false");
    sheet.classList.toggle("area-mode", on);
  });

  let gesture = null;

  function areaSelect(event) {
    return areaButton.getAttribute("aria-pressed") === "true" || event.shiftKey;
  }

  function hideMarquee() {
    marquee.hidden = true;
  }

  function showMarquee(x1, y1, x2, y2) {
    const originX = sheet.getBoundingClientRect().left + sheet.clientLeft;
    const originY = sheet.getBoundingClientRect().top + sheet.clientTop;
    marquee.hidden = false;
    marquee.style.left = `${Math.min(x1, x2) - originX + sheet.scrollLeft}px`;
    marquee.style.top = `${Math.min(y1, y2) - originY + sheet.scrollTop}px`;
    marquee.style.width = `${Math.abs(x2 - x1)}px`;
    marquee.style.height = `${Math.abs(y2 - y1)}px`;
  }

  function selectionOnCanvas(x1, y1, x2, y2) {
    const bounds = canvas.getBoundingClientRect();
    const left = Math.max(bounds.left, Math.min(x1, x2));
    const top = Math.max(bounds.top, Math.min(y1, y2));
    const right = Math.min(bounds.right, Math.max(x1, x2));
    const bottom = Math.min(bounds.bottom, Math.max(y1, y2));
    return {
      x: left - bounds.left,
      y: top - bounds.top,
      w: Math.max(0, right - left),
      h: Math.max(0, bottom - top)
    };
  }

  canvas.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    gesture = {
      id: event.pointerId,
      mode: areaSelect(event) ? "area" : "pan",
      x: event.clientX,
      y: event.clientY,
      left: sheet.scrollLeft,
      top: sheet.scrollTop
    };
    if (gesture.mode === "pan") canvas.classList.add("panning");
    try { canvas.setPointerCapture(event.pointerId); } catch (err) { /* Pointer sintetis tidak bisa ditangkap. */ }
  });
  canvas.addEventListener("pointermove", (event) => {
    if (!gesture || event.pointerId !== gesture.id) return;
    if (gesture.mode === "pan") {
      sheet.scrollLeft = gesture.left - (event.clientX - gesture.x);
      sheet.scrollTop = gesture.top - (event.clientY - gesture.y);
      return;
    }
    if (Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) < 4) return;
    showMarquee(gesture.x, gesture.y, event.clientX, event.clientY);
  });
  const endGesture = (event) => {
    if (!gesture || (event && event.pointerId !== gesture.id)) return;
    const active = gesture;
    gesture = null;
    canvas.classList.remove("panning");
    hideMarquee();
    if (active.mode !== "area" || !event) return;
    zoomToArea(selectionOnCanvas(active.x, active.y, event.clientX, event.clientY));
  };
  canvas.addEventListener("pointerup", endGesture);
  canvas.addEventListener("pointercancel", endGesture);
  window.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || areaButton.getAttribute("aria-pressed") !== "true") return;
    areaButton.setAttribute("aria-pressed", "false");
    sheet.classList.remove("area-mode");
    hideMarquee();
    gesture = null;
  });
  sheet.addEventListener("scroll", updateZoomLabels);
  sheet.addEventListener("wheel", (event) => {
    event.preventDefault();
    zoomWheel += -event.deltaY / 400;
    if (Math.abs(zoomWheel) < ZOOM_STEP) return;
    const steps = Math.trunc(zoomWheel / ZOOM_STEP);
    zoomWheel -= steps * ZOOM_STEP;
    setViewZoom(state.viewZoom + steps * ZOOM_STEP, event);
  }, { passive: false });

  bindWellList();
  window.addEventListener("resize", requestDraw);
  if (typeof ResizeObserver !== "undefined") {
    const observer = new ResizeObserver(() => requestDraw());
    observer.observe(sheet);
  }
}

if (typeof document !== "undefined") {
  document.addEventListener("DOMContentLoaded", init);
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    parseSheetRows,
    sectorSweep,
    makeLegend,
    formatNum,
    num,
    parsePastedPairs,
    incScale,
    PARIGI,
    WPA
  };
}
