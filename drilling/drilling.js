(function () {
  const STORAGE_KEY = "drilling-summary-v1";
  const FONT = "12px Arial, Helvetica, sans-serif";
  const FONT_BOLD = "700 12px Arial, Helvetica, sans-serif";
  const TITLE_FONT = '700 22px "Segoe UI", Arial, Helvetica, sans-serif';
  const SUB_FONT = '13px "Segoe UI", Arial, Helvetica, sans-serif';
  const CASING_FONT = '700 13px "Segoe UI", Arial, Helvetica, sans-serif';
  const CAT_FONT = "700 11px Arial, Helvetica, sans-serif";
  const DEPTH_COLOR = "#2563eb";
  const TITLE_COLOR = "#1d4ed8";
  const AXIS = "#334155";
  const MUTED = "#64748b";
  const GRID = "#e5eaf0";
  const PALETTE = ["#ea580c", "#d946ef", "#9f1239", "#dc2626", "#0284c7", "#be123c", "#0f766e", "#7c3aed", "#ca8a04", "#1d4ed8"];
  const FM_COLORS = ["#7A3412", "#2E8B3C", "#3A3A3A", "#8FB56A", "#00B7CE", "#123C48", "#1B6FCB", "#E0A820"];
  const CATEGORIES = [
    { name: "Tight Spot/Overpull/Stall", color: "#d1a400" },
    { name: "Stuck Pipe", color: "#dc2626" },
    { name: "Loss", color: "#08bf26" },
    { name: "Pack Off", color: "#7c3aed" },
    { name: "Tool Failure", color: "#0f766e" }
  ];
  const PREVIOUS_CATEGORY_COLORS = {
    "tight spot/overpull/stall": ["#d946ef"],
    "loss": ["#ea580c"]
  };

  const state = {
    title: "Time vs Depth",
    well: "",
    subtitle: "",
    td: null,
    tdTvd: null,
    endDay: null,
    dayMode: "interval",
    dayStep: null,
    decimalComma: true,
    depthMode: "md",
    casingWellId: "",
    casingWellName: "",
    showCasing: true,
    showFormations: true,
    symbolSize: 9,
    colorRevision: 0,
    formations: [],
    progress: [],
    events: []
  };

  const selectedEvents = new Set();
  let selectAnchor = -1;
  let eventDrag = null;
  let focusAfter = null;
  let measureCtx = null;
  const ZOOM_MIN = 0.5;
  const ZOOM_MAX = 8;
  const ZOOM_STEP = 0.25;
  let viewZoom = 1;
  let zoomAnchor = null;
  let zoomWheel = 0;
  let panGesture = null;
  let lastScene = null;
  let drawQueued = false;
  let hadStored = false;

  function uid() {
    return "d" + Math.random().toString(36).slice(2, 10);
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

  function measurer() {
    if (!measureCtx) measureCtx = document.createElement("canvas").getContext("2d");
    return measureCtx;
  }

  function textWidth(font, text) {
    const ctx = measurer();
    ctx.font = font;
    return ctx.measureText(String(text || "")).width;
  }

  function wrapText(text, font, maxWidth) {
    const ctx = measurer();
    ctx.font = font;
    const lines = [];
    String(text || "").split(/\n/).forEach((block) => {
      const words = block.trim().split(/\s+/).filter(Boolean);
      if (!words.length) return;
      let line = words[0];
      for (let i = 1; i < words.length; i += 1) {
        const next = `${line} ${words[i]}`;
        if (ctx.measureText(next).width <= maxWidth) line = next;
        else {
          lines.push(line);
          line = words[i];
        }
      }
      lines.push(line);
    });
    return lines;
  }

  function parseNum(value) {
    let text = String(value ?? "").trim().toLowerCase();
    if (!text) return null;
    text = text.replace(/\s+/g, "").replace(/[a-z°'"”]/g, "");
    if (!text || text === "-" || text === "." || text === ",") return NaN;
    const comma = text.lastIndexOf(",");
    const dot = text.lastIndexOf(".");
    if (comma >= 0 && dot >= 0) {
      if (comma > dot) text = text.replace(/\./g, "").replace(",", ".");
      else text = text.replace(/,/g, "");
    } else if (comma >= 0) {
      text = text.replace(",", ".");
    }
    const n = Number(text);
    if (!Number.isFinite(n) || n < 0) return NaN;
    return n;
  }

  function fmt(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return "–";
    const neg = n < 0;
    const rounded = Math.round(Math.abs(n) * 100) / 100;
    let [intPart, frac] = rounded.toFixed(2).split(".");
    if (frac === "00") frac = "";
    else if (frac[1] === "0") frac = frac[0];
    const thou = state.decimalComma ? "." : ",";
    const dec = state.decimalComma ? "," : ".";
    intPart = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, thou);
    const body = frac ? intPart + dec + frac : intPart;
    return neg ? "-" + body : body;
  }

  function numToInput(value) {
    if (value == null || Number.isNaN(value)) return "";
    const text = String(value);
    return state.decimalComma ? text.replace(".", ",") : text;
  }

  function numberOrNull(value) {
    if (value == null || value === "") return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  function positiveOrNull(value) {
    const n = numberOrNull(value);
    return n != null && n > 0 ? n : null;
  }

  function dayOrNull(value) {
    const n = numberOrNull(value);
    return n != null && n >= 1 ? n : null;
  }

  function nptOrNull(value) {
    const n = numberOrNull(value);
    return n != null && n >= 0 ? n : null;
  }

  function niceStep(max) {
    const raw = max / 8;
    if (!(raw > 0)) return 1;
    const pow = Math.pow(10, Math.floor(Math.log10(raw)));
    const fraction = raw / pow;
    const nice = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 2.5 ? 2.5 : fraction <= 5 ? 5 : 10;
    return nice * pow;
  }

  function scaleMax(value) {
    if (!Number.isFinite(value) || value <= 0) return 1000;
    const step = niceStep(value);
    return Math.ceil((value - 1e-9) / step) * step;
  }

  function crisp(value) {
    return Math.round(value) + 0.5;
  }

  function normalizeColor(value) {
    const text = String(value || "").trim();
    return /^#[0-9a-fA-F]{6}$/.test(text) ? text.toLowerCase() : "#ea580c";
  }

  function textOn(hex) {
    const c = String(hex || "").replace("#", "");
    if (c.length !== 6) return "#ffffff";
    const r = parseInt(c.slice(0, 2), 16);
    const g = parseInt(c.slice(2, 4), 16);
    const b = parseInt(c.slice(4, 6), 16);
    return (r * 299 + g * 587 + b * 114) / 1000 > 170 ? "#1c1915" : "#ffffff";
  }

  function normCat(value) {
    return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
  }

  function roundRect(ctx, x, y, w, h, r) {
    const radius = Math.max(0, Math.min(r, w / 2, h / 2));
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.arcTo(x + w, y, x + w, y + h, radius);
    ctx.arcTo(x + w, y + h, x, y + h, radius);
    ctx.arcTo(x, y + h, x, y, radius);
    ctx.arcTo(x, y, x + w, y, radius);
    ctx.closePath();
  }

  function figureTitle() {
    const title = (state.title || "").trim() || "Time vs Depth";
    const well = (state.well || "").trim();
    if (!well || title.toLowerCase().includes(well.toLowerCase())) return title;
    return `${title} — ${well}`;
  }

  function depthMode() {
    return state.depthMode === "tvd" ? "tvd" : "md";
  }

  function depthUnitLabel() {
    return depthMode() === "tvd" ? "ft-TVD" : "ft-MD";
  }

  function chartDepth(item) {
    return depthMode() === "tvd" ? item.depthTvd : item.depth;
  }

  function subtitleText() {
    const parts = [];
    const custom = (state.subtitle || "").trim();
    if (custom) parts.push(custom);
    const td = depthMode() === "tvd" ? state.tdTvd : state.td;
    if (td != null) parts.push(`TD: ${fmt(td)} ${depthUnitLabel()}`);
    return parts.join(" | ");
  }

  function curveSource() {
    const progress = state.progress
      .filter((item) => item.day != null && chartDepth(item) != null)
      .map((item) => ({ day: item.day, depth: chartDepth(item) }));
    if (progress.length) return { fromEvents: false, points: progress };
    const points = state.events
      .filter((item) => item.day != null && chartDepth(item) != null)
      .map((item) => ({ day: item.day, depth: chartDepth(item) }));
    return { fromEvents: true, points };
  }

  function depthAt(day, points) {
    if (!points.length || day == null) return null;
    const sorted = points.slice().sort((a, b) => a.day - b.day || a.depth - b.depth);
    if (day <= sorted[0].day) return sorted[0].depth;
    const last = sorted[sorted.length - 1];
    if (day >= last.day) return last.depth;
    for (let i = 1; i < sorted.length; i += 1) {
      const left = sorted[i - 1];
      const right = sorted[i];
      if (day <= right.day) {
        const span = right.day - left.day;
        const t = span === 0 ? 0 : (day - left.day) / span;
        return left.depth + (right.depth - left.depth) * t;
      }
    }
    return last.depth;
  }

  function domainDay() {
    if (state.endDay != null && state.endDay >= 1) return state.endDay;
    let max = 1;
    const consider = (day) => {
      if (day != null && day >= 1) max = Math.max(max, day);
    };
    state.progress.forEach((item) => consider(item.day));
    state.events.forEach((item) => consider(item.day));
    return Math.max(max, 2);
  }

  function dayAxisValues(dayMax) {
    const end = Math.max(dayMax, 1);
    if (state.dayMode === "all") {
      const values = [];
      const whole = Math.floor(end + 1e-9);
      for (let day = 1; day <= whole; day += 1) values.push(day);
      if (end - whole > 0.01) values.push(Math.round(end * 1000) / 1000);
      return values.length ? values : [1];
    }
    const step = state.dayStep != null && state.dayStep >= 1 ? state.dayStep : niceStep(Math.max(end - 1, 1));
    const values = [1];
    if (end > 1) {
      for (let day = 1 + step; day < end - step * 0.35; day += step) {
        values.push(Math.round(day * 1000) / 1000);
      }
      const last = values[values.length - 1];
      if (Math.abs(last - end) > 0.01) values.push(Math.round(end * 1000) / 1000);
    }
    return values;
  }

  function casingApi() {
    return window.CasingSetting || null;
  }

  function casingWells() {
    const api = casingApi();
    if (!api || typeof api.wells !== "function") return [];
    try {
      const wells = api.wells();
      return Array.isArray(wells) ? wells : [];
    } catch (err) {
      return [];
    }
  }

  function casingMeta() {
    const api = casingApi();
    if (!api || typeof api.meta !== "function") return { unit: "ft", endLabel: "End of Well" };
    try {
      return api.meta() || { unit: "ft", endLabel: "End of Well" };
    } catch (err) {
      return { unit: "ft", endLabel: "End of Well" };
    }
  }

  function resolveCasingWell() {
    const wells = casingWells();
    if (state.casingWellId && wells.some((well) => well.id === state.casingWellId)) {
      const found = wells.find((well) => well.id === state.casingWellId);
      state.casingWellName = (found.name || "").trim();
      return;
    }
    const wanted = (state.casingWellName || "").trim().toLowerCase();
    if (!wanted) return;
    const match = wells.find((well) => (well.name || "").trim().toLowerCase() === wanted);
    if (!match) return;
    state.casingWellId = match.id;
    state.casingWellName = (match.name || "").trim();
  }

  function selectedCasing() {
    resolveCasingWell();
    if (!state.casingWellId) return null;
    return casingWells().find((well) => well.id === state.casingWellId) || null;
  }

  function toChartFt(value, unit) {
    if (value == null || Number.isNaN(Number(value))) return null;
    const n = Number(value);
    return unit === "m" ? n * 3.280839895 : n;
  }

  function mdFromTvd(well, tvd, unit) {
    if (tvd == null) return null;
    const pairs = [[0, 0]];
    (well.casings || []).forEach((casing) => {
      if (casing.shoeTvd != null && casing.shoeMd != null) pairs.push([casing.shoeTvd, casing.shoeMd]);
    });
    if (well.tdTvd != null && well.tdMd != null) pairs.push([well.tdTvd, well.tdMd]);
    pairs.sort((a, b) => a[0] - b[0]);
    const clean = [];
    pairs.forEach((pair) => {
      const prev = clean[clean.length - 1];
      if (!prev || pair[0] > prev[0] + 0.01) clean.push(pair);
    });
    let raw = clean[clean.length - 1][1];
    if (tvd <= clean[0][0]) raw = clean[0][1];
    else {
      for (let i = 1; i < clean.length; i += 1) {
        const left = clean[i - 1];
        const right = clean[i];
        if (tvd <= right[0]) {
          const span = right[0] - left[0];
          const t = span === 0 ? 0 : (tvd - left[0]) / span;
          raw = left[1] + (right[1] - left[1]) * t;
          break;
        }
      }
    }
    return toChartFt(raw, unit);
  }

  function deepestCasingMd(well, exceptId, unit) {
    let best = null;
    (well.casings || []).forEach((casing) => {
      if (casing.id === exceptId || casing.kind === "liner" || casing.shoeMd == null) return;
      const md = toChartFt(casing.shoeMd, unit);
      if (md == null) return;
      if (best == null || md > best) best = md;
    });
    return best;
  }

  function deepestCasingTvd(well, exceptId, unit) {
    let best = null;
    (well.casings || []).forEach((casing) => {
      if (casing.id === exceptId || casing.kind === "liner" || casing.shoeTvd == null) return;
      const tvd = toChartFt(casing.shoeTvd, unit);
      if (tvd == null) return;
      if (best == null || tvd > best) best = tvd;
    });
    return best;
  }

  function linerTopTvdFt(casing, well, unit) {
    const shoe = toChartFt(casing.shoeTvd, unit);
    if (casing.topTvd != null) {
      const top = toChartFt(casing.topTvd, unit);
      if (top != null && shoe != null && top < shoe) return top;
    }
    const host = deepestCasingTvd(well, casing.id, unit);
    const base = host == null ? shoe : host;
    if (base == null) return 0;
    const overlap = Math.max(100, Math.min(base * 0.12, base * 0.45));
    let top = Math.max(0, base - overlap);
    if (shoe != null && top >= shoe) top = Math.max(0, shoe * 0.85);
    return top;
  }

  function linerTopFt(casing, well, unit) {
    const shoe = toChartFt(casing.shoeMd, unit);
    if (casing.topTvd != null) {
      const top = mdFromTvd(well, casing.topTvd, unit);
      if (top != null && shoe != null && top < shoe) return top;
    }
    const host = deepestCasingMd(well, casing.id, unit);
    const base = host == null ? shoe : host;
    if (base == null) return 0;
    const overlap = Math.max(unit === "m" ? 100 : 100, Math.min(base * 0.12, base * 0.45));
    let top = Math.max(0, base - overlap);
    if (shoe != null && top >= shoe) top = Math.max(0, shoe * 0.85);
    return top;
  }

  function casingStrings(well, unit) {
    const tvdMode = depthMode() === "tvd";
    const tag = tvdMode ? "TVD" : "MD";
    return (well.casings || []).map((casing) => {
      const shoeRaw = tvdMode ? casing.shoeTvd : casing.shoeMd;
      if (shoeRaw == null) return null;
      const liner = casing.kind === "liner";
      const shoeMd = toChartFt(shoeRaw, unit);
      const topMd = liner ? (tvdMode ? linerTopTvdFt(casing, well, unit) : linerTopFt(casing, well, unit)) : 0;
      if (shoeMd == null || (liner && topMd >= shoeMd)) return null;
      return {
        name: (casing.name || "").trim() || (liner ? "Liner" : "Casing"),
        shoeMd,
        shoeLabel: shoeRaw,
        caption: `at ${fmt(shoeRaw)} ${tag}-${unit}`,
        topMd,
        liner,
        style: casing.style === "openhole" || casing.style === "perforated" ? casing.style : "solid"
      };
    }).filter(Boolean).sort((a, b) => a.shoeMd - b.shoeMd);
  }

  function formationSpan(item) {
    const tvdMode = depthMode() === "tvd";
    const topRaw = tvdMode ? item.topTvd : item.topMd;
    const base = tvdMode ? item.baseTvd : item.baseMd;
    const top = topRaw == null ? 0 : topRaw;
    if (base == null || base <= top) return null;
    return { top, base };
  }

  function validFormations() {
    return state.formations
      .map((item) => {
        const span = formationSpan(item);
        if (!span) return null;
        return {
          name: (item.name || "").trim(),
          color: normalizeColor(item.color),
          top: span.top,
          base: span.base
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.top - b.top || a.base - b.base);
  }

  function sideSpec() {
    const formations = validFormations();
    const well = selectedCasing();
    const meta = casingMeta();
    const unit = meta.unit;
    let x = 0;
    let fm = null;
    if (state.showFormations && formations.length) {
      let nameW = 88;
      formations.forEach((item) => {
        nameW = Math.max(nameW, textWidth(FONT, item.name || "Formasi") + 16);
      });
      nameW = Math.min(200, nameW);
      fm = { colorX: 16, colorW: 28, nameX: 52, nameW, items: formations };
      x = 52 + nameW + 24;
    }
    let casing = null;
    if (state.showCasing && well) {
      const items = casingStrings(well, unit);
      const name = (well.name || "").trim() || "Sumur";
      let textW = textWidth(FONT_BOLD, name);
      items.forEach((item) => {
        textW = Math.max(textW, textWidth(FONT_BOLD, item.name), textWidth(FONT, item.caption));
      });
      const tdRaw = depthMode() === "tvd" ? well.tdTvd : well.tdMd;
      const tdLine = depthMode() === "tvd"
        ? (well.tdTvd != null ? `TD ${fmt(well.tdTvd)} TVD-${unit}` : "")
        : (well.tdMd == null
          ? ""
          : (well.tdTvd != null
            ? `TD ${fmt(well.tdMd)} MD-${unit} / ${fmt(well.tdTvd)} TVD-${unit}`
            : `TD ${fmt(well.tdMd)} MD-${unit}`));
      if (tdLine) textW = Math.max(textW, textWidth(FONT, tdLine), textWidth(FONT_BOLD, meta.endLabel));
      textW = Math.ceil(textW) + 8;
      const stick = 12 + Math.max(items.length - 1, 0) * 14;
      const left = Math.max(x, 16);
      casing = {
        left,
        name,
        items,
        textW,
        stick,
        labelX: left + stick + 28,
        right: left + stick + 28 + textW + 16,
        unit,
        endLabel: meta.endLabel,
        tdMd: toChartFt(tdRaw, unit),
        tdLine,
      };
      x = casing.right;
    }
    return { fm, casing, right: x };
  }

  function placeCasing(casing, yOf, plotTop) {
    const pitch = 14;
    const ranked = casing.items.slice().sort((a, b) => b.shoeMd - a.shoeMd);
    const stickLeft = casing.left + 8;
    casing.placed = casing.items.map((item) => {
      const index = Math.max(0, ranked.indexOf(item));
      const x = stickLeft + index * pitch;
      return {
        ...item,
        x,
        yTop: yOf(item.topMd),
        yShoe: yOf(item.shoeMd),
        anchorX: x + (item.style === "openhole" ? 6 : 20)
      };
    });
    const deepest = casing.placed.reduce((best, item) => (best == null || item.shoeMd > best.shoeMd ? item : best), null);
    casing.openHole = null;
    if (deepest && casing.tdMd != null && casing.tdMd > deepest.shoeMd + 0.5) {
      casing.openHole = { x: deepest.x, y1: deepest.yShoe, y2: yOf(casing.tdMd) };
    } else if (!casing.placed.length && casing.tdMd != null) {
      casing.openHole = { x: stickLeft, y1: yOf(0), y2: yOf(casing.tdMd) };
    }
    const packs = [];
    casing.placed.forEach((item) => {
      packs.push({
        lines: [item.name, item.caption],
        y: item.yShoe,
        anchorX: item.anchorX
      });
    });
    if (casing.tdMd != null && casing.tdLine) {
      const anchorX = casing.openHole ? casing.openHole.x + 6 : (deepest ? deepest.anchorX : stickLeft + 6);
      packs.push({ lines: [casing.endLabel, casing.tdLine], y: yOf(casing.tdMd), anchorX });
    }
    packs.sort((a, b) => a.y - b.y);
    let cursor = plotTop + 2;
    packs.forEach((pack) => {
      const height = pack.lines.length * 15;
      let top = pack.y - height / 2;
      if (top < cursor) top = cursor;
      pack.top = top;
      pack.h = height;
      cursor = top + height + 8;
    });
    casing.labels = packs;
  }

  function domainDepth() {
    let max = 0;
    const manualTd = depthMode() === "tvd" ? state.tdTvd : state.td;
    if (manualTd != null) max = Math.max(max, manualTd);
    state.progress.forEach((item) => {
      const depth = chartDepth(item);
      if (depth != null) max = Math.max(max, depth);
    });
    state.events.forEach((item) => {
      const depth = chartDepth(item);
      if (depth != null) max = Math.max(max, depth);
    });
    if (state.showFormations) {
      state.formations.forEach((item) => {
        const span = formationSpan(item);
        if (span) max = Math.max(max, span.top, span.base);
      });
    }
    const well = state.showCasing ? selectedCasing() : null;
    if (well) {
      const unit = casingMeta().unit;
      const tvdMode = depthMode() === "tvd";
      const td = toChartFt(tvdMode ? well.tdTvd : well.tdMd, unit);
      if (td != null) max = Math.max(max, td);
      (well.casings || []).forEach((casing) => {
        const shoe = toChartFt(tvdMode ? casing.shoeTvd : casing.shoeMd, unit);
        if (shoe != null) max = Math.max(max, shoe);
      });
    }
    return scaleMax(max);
  }

  function plottedEvents() {
    return state.events
      .filter((item) => item.day != null && chartDepth(item) != null)
      .map((item) => ({ ...item, depth: chartDepth(item) }))
      .sort((a, b) => a.day - b.day || a.depth - b.depth);
  }

  function dayLabel(day) {
    if (day == null) return "—";
    return Number.isInteger(day) ? String(day) : fmt(day);
  }

  function categoryIcon(name) {
    const key = normCat(name);
    if (!key) return "";
    if (key.includes("stuck")) return "stuck";
    if (key.includes("pack")) return "pack";
    if (key.includes("loss") || key.includes("lost")) return "loss";
    if (key.includes("tight") || key.includes("overpull") || key.includes("stall")) return "overpull";
    if (key.includes("tool")) return "tool";
    return "";
  }

  function paintProblemIcon(ctx, x, y, radius, color, icon) {
    ctx.save();
    ctx.fillStyle = color;
    ctx.strokeStyle = "#ffffff";
    ctx.lineJoin = "round";
    ctx.lineWidth = Math.max(1.5, radius * 0.18);
    if (icon === "stuck") {
      const arm = radius * 0.95;
      ctx.strokeStyle = color;
      ctx.lineCap = "round";
      ctx.lineWidth = Math.max(2.4, radius * 0.5);
      ctx.beginPath();
      ctx.moveTo(x - arm, y - arm);
      ctx.lineTo(x + arm, y + arm);
      ctx.moveTo(x + arm, y - arm);
      ctx.lineTo(x - arm, y + arm);
      ctx.stroke();
      ctx.restore();
      return;
    }
    if (icon === "tool") {
      const outer = radius * 1.2;
      const inner = outer * 0.46;
      ctx.beginPath();
      for (let i = 0; i < 10; i += 1) {
        const angle = -Math.PI / 2 + (i * Math.PI) / 5;
        const r = i % 2 ? inner : outer;
        const px = x + Math.cos(angle) * r;
        const py = y + Math.sin(angle) * r;
        if (i) ctx.lineTo(px, py);
        else ctx.moveTo(px, py);
      }
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.restore();
      return;
    }
    ctx.beginPath();
    if (icon === "loss") {
      const h = radius * 2.05;
      ctx.moveTo(x, y - h * 0.62);
      ctx.lineTo(x + h * 0.55, y + h * 0.38);
      ctx.lineTo(x - h * 0.55, y + h * 0.38);
      ctx.closePath();
    } else if (icon === "pack") {
      const s = radius * 0.9;
      ctx.rect(x - s, y - s, s * 2, s * 2);
    } else {
      ctx.arc(x, y, radius, 0, Math.PI * 2);
    }
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  function clampSymbolSize(value) {
    const n = numberOrNull(value);
    if (n == null) return 9;
    return Math.min(28, Math.max(4, Math.round(n)));
  }

  function symbolRadius() {
    const n = Number(state.symbolSize);
    if (!Number.isFinite(n)) return 9;
    return Math.min(28, Math.max(4, Math.round(n)));
  }

  function legendMetrics() {
    const radius = Math.max(6, Math.round(symbolRadius() * 0.78));
    const swatch = Math.max(28, Math.ceil(radius * 2.3) + 6);
    const pitch = Math.max(22, Math.ceil(radius * 2.4) + 8);
    return { radius, swatch, pitch };
  }

  function placeMarkers(markers) {
    const pad = Math.max(22, symbolRadius() * 2.2);
    const step = Math.max(16, Math.round(symbolRadius() * 1.6));
    const placed = markers.slice().sort((a, b) => a.x - b.x || a.y - b.y);
    const taken = [];
    placed.forEach((marker) => {
      let shift = 0;
      for (let guard = 0; guard < 8; guard += 1) {
        const x = marker.x + shift;
        const hit = taken.some((point) => Math.hypot(point.x - x, point.y - marker.y) < pad);
        if (!hit) {
          marker.x = x;
          break;
        }
        shift = shift === 0 ? step : shift > 0 ? -shift : -shift + step;
      }
      taken.push({ x: marker.x, y: marker.y });
    });
    return placed;
  }

  function legendLayout(items, left, width) {
    const gap = 18;
    const metrics = legendMetrics();
    const rows = [[]];
    let used = 0;
    items.forEach((item) => {
      const w = metrics.swatch + 4 + textWidth(FONT, item.label);
      const row = rows[rows.length - 1];
      if (row.length && used + gap + w > width) {
        rows.push([]);
        used = 0;
      }
      const current = rows[rows.length - 1];
      const x = left + used + (current.length ? gap : 0);
      current.push({ ...item, x, w });
      used = x - left + w;
    });
    if (!items.length) return { rows: [], height: 0, pitch: metrics.pitch, swatch: metrics.swatch, radius: metrics.radius };
    return { rows, height: rows.length * metrics.pitch, pitch: metrics.pitch, swatch: metrics.swatch, radius: metrics.radius };
  }

  function scene() {
    const curveInfo = curveSource();
    const markersIn = plottedEvents();
    const side = sideSpec();
    const drawable = curveInfo.points.length || markersIn.length || side.right > 0;
    if (!drawable) return { empty: true, w: 920, h: 480 };

    const dayMax = domainDay();
    const depthMax = domainDepth();
    const depthStep = niceStep(depthMax);
    const depthValues = [];
    const depthCount = Math.round(depthMax / depthStep);
    for (let i = 0; i <= depthCount; i += 1) depthValues.push(Math.round(i * depthStep * 1000) / 1000);

    const plotW = 980;

    let axisText = 0;
    depthValues.forEach((depth) => {
      axisText = Math.max(axisText, textWidth(FONT, fmt(depth)));
    });
    const plotLeft = side.right + 36 + Math.ceil(axisText) + 12;
    const marginR = 36;
    const width = plotLeft + plotW + marginR;
    const center = width / 2;
    const span = Math.max(dayMax - 1, 1);
    const xOf = (day) => plotLeft + ((day - 1) / span) * plotW;
    const dayValues = dayAxisValues(dayMax);
    const dayGaps = [];
    for (let i = 1; i < dayValues.length; i += 1) dayGaps.push(xOf(dayValues[i]) - xOf(dayValues[i - 1]));
    const widestDay = dayValues.reduce((max, day) => Math.max(max, textWidth(FONT, dayLabel(day))), 12);
    const rotateDays = dayGaps.length > 0 && Math.min(...dayGaps) < widestDay + 8;
    const dayTicks = [];
    dayValues.forEach((day, index) => {
      const x = xOf(day);
      const label = dayLabel(day);
      const textW = textWidth(FONT, label);
      const last = index === dayValues.length - 1;
      if (!rotateDays) {
        if (!last && dayTicks.length && x - dayTicks[dayTicks.length - 1].x < textW + 10) return;
        if (last && dayTicks.length > 1 && x - dayTicks[dayTicks.length - 1].x < textW * 0.65) dayTicks.pop();
      }
      const labelX = rotateDays ? x : Math.min(plotLeft + plotW - textW / 2, Math.max(plotLeft + textW / 2, x));
      dayTicks.push({ day, x, label, labelX, rotate: rotateDays });
    });
    const dayNumberExtent = rotateDays
      ? dayTicks.reduce((max, tick) => Math.max(max, textWidth(FONT, tick.label)), 12)
      : 16;
    const dayLabelDrop = 8 + dayNumberExtent + 22;

    const titleLines = wrapText(figureTitle(), TITLE_FONT, width - 48);
    const subLines = wrapText(subtitleText(), SUB_FONT, width - 48);
    let cursor = 16 + titleLines.length * 28;
    if (subLines.length) cursor += subLines.length * 18 + 8;
    else cursor += 4;
    const plotTop = cursor + 18;
    const plotH = 520;
    const plotBottom = plotTop + plotH;
    const yOf = (depth) => plotTop + (Math.max(0, depth) / depthMax) * plotH;
    if (side.fm) {
      side.fm.bands = side.fm.items.map((item) => ({
        name: item.name,
        color: item.color,
        y1: yOf(item.top),
        y2: yOf(item.base)
      }));
    }
    if (side.casing) placeCasing(side.casing, yOf, plotTop);

    const curve = curveInfo.points
      .slice()
      .sort((a, b) => a.day - b.day || a.depth - b.depth)
      .map((item) => ({ x: xOf(item.day), y: yOf(item.depth) }));
    const markers = placeMarkers(markersIn.map((item) => ({
      x: xOf(item.day),
      y: yOf(item.depth),
      color: normalizeColor(item.color),
      icon: categoryIcon(item.category)
    })));

    const categories = [];
    const seen = new Set();
    markersIn.forEach((item) => {
      const key = normCat(item.category) || item.id;
      if (seen.has(key)) return;
      seen.add(key);
      categories.push({
        label: (item.category || "").trim() || "Masalah",
        color: normalizeColor(item.color),
        icon: categoryIcon(item.category)
      });
    });
    const legendItems = [];
    if (curve.length) {
      const well = (state.well || "").trim();
      legendItems.push({
        type: "depth",
        label: curveInfo.fromEvents ? "Kedalaman masalah" : (well ? `Depth ${well}` : "Kedalaman sumur")
      });
    }
    categories.forEach((item) => legendItems.push({
      type: "event",
      label: item.label,
      color: item.color,
      icon: item.icon
    }));

    const legend = legendLayout(legendItems, plotLeft, plotW);
    let legendTop = plotBottom + dayLabelDrop + 8;
    let y = legendTop + legend.height + 20;
    if (side.casing) {
      side.casing.labels.forEach((label) => {
        y = Math.max(y, label.top + label.h + 20);
      });
    }

    return {
      empty: false,
      w: width,
      h: Math.ceil(y),
      center,
      titleLines,
      subLines,
      side,
      depthLabelX: side.right + 16,
      plotLeft,
      plotTop,
      plotW,
      plotH,
      plotBottom,
      depthTicks: depthValues.map((depth) => ({ depth, y: yOf(depth), label: fmt(depth) })),
      dayTicks,
      dayNumberExtent,
      curve,
      markers,
      legend,
      legendTop
    };
  }

  function paintLegend(ctx, figure) {
    const pitch = figure.legend.pitch || 22;
    const swatch = figure.legend.swatch || 28;
    const radius = figure.legend.radius || 7;
    figure.legend.rows.forEach((row, rowIndex) => {
      const y = figure.legendTop + rowIndex * pitch + pitch / 2;
      row.forEach((item) => {
        ctx.save();
        if (item.type === "depth") {
          ctx.strokeStyle = DEPTH_COLOR;
          ctx.lineWidth = 2.4;
          ctx.setLineDash([7, 4]);
          ctx.beginPath();
          ctx.moveTo(item.x, y);
          ctx.lineTo(item.x + Math.min(22, swatch - 6), y);
          ctx.stroke();
        } else {
          paintProblemIcon(ctx, item.x + swatch / 2, y, radius, item.color, item.icon);
        }
        ctx.restore();
        ctx.fillStyle = AXIS;
        ctx.font = FONT;
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        ctx.fillText(item.label, item.x + swatch + 4, y);
      });
    });
  }

  function casingHosts(placed) {
    const hosts = new Map();
    placed.forEach((item) => {
      if (!item.liner) return;
      const host = placed
        .filter((other) => other !== item && other.x > item.x + 0.5)
        .sort((a, b) => a.x - b.x)[0];
      if (host) hosts.set(item, host);
    });
    return hosts;
  }

  function shoeTipX(item, host) {
    const pipeW = 3.2;
    const x = Math.round(item.x);
    const left = x - pipeW / 2;
    if (item.style === "openhole") return x + 2.6;
    const hostLeft = host ? Math.round(host.x) - pipeW / 2 : left + pipeW + 12;
    return Math.max(left + pipeW + 6, Math.min(left + pipeW + 10, hostLeft - 1));
  }

  function paintPipe(ctx, item, host) {
    ctx.save();
    ctx.strokeStyle = "#111111";
    ctx.fillStyle = "#111111";
    ctx.lineWidth = 3.2;
    ctx.lineCap = "butt";
    const x = Math.round(item.x);
    const y1 = Math.round(item.yTop);
    const y2 = Math.round(item.yShoe);
    const pipeW = 3.2;
    const left = x - pipeW / 2;
    const hangH = 12;
    const shoeH = 13;
    const pipeTop = item.liner ? y1 + hangH : y1;
    if (item.style === "openhole" || item.style === "perforated") {
      ctx.setLineDash(item.style === "openhole" ? [10, 6] : [6, 5]);
      ctx.beginPath();
      ctx.moveTo(x, pipeTop);
      ctx.lineTo(x, item.style === "perforated" ? y2 - shoeH : y2);
      ctx.stroke();
      ctx.setLineDash([]);
    } else if (y2 > pipeTop) {
      ctx.fillRect(left, pipeTop, pipeW, y2 - pipeTop);
    }
    if (item.liner) {
      const hostRight = host ? Math.round(host.x) + pipeW / 2 : left + pipeW + 10;
      ctx.fillRect(left, y1, Math.max(pipeW, hostRight - left), hangH);
    }
    if (item.style === "openhole") {
      ctx.beginPath();
      ctx.arc(x, y2, 2.6, 0, Math.PI * 2);
      ctx.fill();
    } else {
      const tip = shoeTipX(item, host);
      ctx.beginPath();
      ctx.moveTo(left, y2 - shoeH);
      ctx.lineTo(left + pipeW, y2 - shoeH);
      ctx.lineTo(tip, y2);
      ctx.lineTo(left, y2);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }

  function curveXAtY(curve, y) {
    if (!curve || !curve.length) return null;
    if (curve[0].y >= y - 0.01) return curve[0].x;
    if (curve.length === 1) return null;
    for (let i = 1; i < curve.length; i += 1) {
      const a = curve[i - 1];
      const b = curve[i];
      const lo = Math.min(a.y, b.y);
      const hi = Math.max(a.y, b.y);
      if (y < lo - 0.01 || y > hi + 0.01) continue;
      if (Math.abs(b.y - a.y) < 0.01) return Math.min(a.x, b.x);
      const t = (y - a.y) / (b.y - a.y);
      return a.x + Math.min(1, Math.max(0, t)) * (b.x - a.x);
    }
    return null;
  }

  function paintShoeGuides(ctx, figure) {
    const side = figure.side;
    const placed = side && side.casing && side.casing.placed;
    if (!placed || !placed.length) return;
    const formationLeft = side.fm ? side.fm.colorX + side.fm.colorW : null;
    const hosts = casingHosts(placed);
    const plotRight = figure.plotLeft + figure.plotW;
    ctx.save();
    ctx.strokeStyle = "#000000";
    ctx.lineWidth = 1;
    ctx.setLineDash([6, 4]);
    const rows = new Map();
    placed.forEach((item) => {
      const y = crisp(item.yShoe);
      if (y < figure.plotTop - 1 || y > figure.plotBottom + 1) return;
      const left = formationLeft == null ? shoeTipX(item, hosts.get(item)) : formationLeft;
      const prev = rows.get(y);
      if (prev == null || left > prev) rows.set(y, left);
    });
    rows.forEach((left, y) => {
      const hit = curveXAtY(figure.curve, y);
      const right = Math.min(plotRight, hit == null ? plotRight : hit + 1.2);
      if (right <= left + 4) return;
      ctx.beginPath();
      ctx.moveTo(left, y);
      ctx.lineTo(right, y);
      ctx.stroke();
    });
    ctx.restore();
  }

  function paintSide(ctx, figure) {
    const side = figure.side;
    if (!side || side.right <= 0) return;
    ctx.save();
    ctx.fillStyle = "#1c1915";
    ctx.font = FONT_BOLD;
    ctx.textBaseline = "bottom";
    if (side.fm) {
      ctx.textAlign = "center";
      ctx.fillText("Formasi", side.fm.colorX + (side.fm.nameX + side.fm.nameW - side.fm.colorX) / 2, figure.plotTop - 8);
      side.fm.bands.forEach((band) => {
        const height = Math.max(1, band.y2 - band.y1);
        ctx.fillStyle = band.color;
        ctx.fillRect(side.fm.colorX, band.y1, side.fm.colorW, height);
        ctx.strokeStyle = "rgba(0,0,0,0.18)";
        ctx.strokeRect(side.fm.colorX + 0.5, band.y1 + 0.5, side.fm.colorW - 1, Math.max(1, height - 1));
      });
    }
    paintShoeGuides(ctx, figure);
    if (side.fm) {
      side.fm.bands.forEach((band) => {
        const height = Math.max(1, band.y2 - band.y1);
        if (band.name && height >= 14) {
          ctx.fillStyle = "#1c1915";
          ctx.font = FONT;
          ctx.textAlign = "left";
          ctx.textBaseline = "middle";
          ctx.fillText(band.name, side.fm.nameX, (band.y1 + band.y2) / 2);
        }
      });
    }
    if (side.casing) {
      const casing = side.casing;
      ctx.fillStyle = "#1c1915";
      ctx.font = FONT_BOLD;
      ctx.textAlign = "center";
      ctx.textBaseline = "bottom";
      ctx.fillText(casing.name, (casing.left + casing.right) / 2, figure.plotTop - 8);
      const hosts = casingHosts(casing.placed);
      casing.placed.forEach((item) => paintPipe(ctx, item, hosts.get(item)));
      if (casing.openHole) {
        ctx.save();
        ctx.strokeStyle = "#111111";
        ctx.fillStyle = "#111111";
        ctx.lineWidth = 2.8;
        ctx.setLineDash([14, 8]);
        const x = Math.round(casing.openHole.x);
        const yStart = Math.round(casing.openHole.y1);
        const yEnd = Math.round(casing.openHole.y2);
        if (yEnd > yStart + 1) {
          ctx.beginPath();
          ctx.moveTo(x, yStart);
          ctx.lineTo(x, yEnd);
          ctx.stroke();
        }
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.arc(x, yEnd, 2.4, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
      casing.labels.forEach((label) => {
        const shift = Math.abs((label.top + label.h / 2) - label.y);
        if (shift > 22) {
          ctx.strokeStyle = "#b7b1a6";
          ctx.lineWidth = 1;
          ctx.setLineDash([2, 2]);
          ctx.beginPath();
          ctx.moveTo(label.anchorX, crisp(label.y));
          ctx.lineTo(casing.labelX - 4, crisp(label.top + 7));
          ctx.stroke();
          ctx.setLineDash([]);
        }
        label.lines.forEach((line, index) => {
          ctx.fillStyle = "#1c1915";
          ctx.font = index === 0 ? FONT_BOLD : FONT;
          ctx.textAlign = "left";
          ctx.textBaseline = "top";
          ctx.fillText(line, casing.labelX, label.top + index * 15);
        });
      });
    }
    ctx.restore();
  }

  function paint(ctx, figure) {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, figure.w, figure.h);
    if (figure.empty) {
      ctx.fillStyle = MUTED;
      ctx.font = "16px Arial, Helvetica, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("Isi hari dan kedalaman untuk melihat drilling summary.", figure.w / 2, figure.h / 2);
      return;
    }

    ctx.fillStyle = TITLE_COLOR;
    ctx.font = TITLE_FONT;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    figure.titleLines.forEach((line, index) => ctx.fillText(line, figure.center, 14 + index * 28));
    ctx.fillStyle = MUTED;
    ctx.font = SUB_FONT;
    const subTop = 14 + figure.titleLines.length * 28;
    figure.subLines.forEach((line, index) => ctx.fillText(line, figure.center, subTop + index * 18));

    paintSide(ctx, figure);

    ctx.save();
    ctx.beginPath();
    ctx.rect(figure.plotLeft, figure.plotTop, figure.plotW, figure.plotH);
    ctx.clip();
    ctx.strokeStyle = GRID;
    ctx.lineWidth = 1;
    figure.depthTicks.forEach((tick) => {
      ctx.beginPath();
      ctx.moveTo(figure.plotLeft, crisp(tick.y));
      ctx.lineTo(figure.plotLeft + figure.plotW, crisp(tick.y));
      ctx.stroke();
    });
    figure.dayTicks.forEach((tick) => {
      if (tick.x <= figure.plotLeft + 1 || tick.x >= figure.plotLeft + figure.plotW - 1) return;
      ctx.beginPath();
      ctx.moveTo(crisp(tick.x), figure.plotTop);
      ctx.lineTo(crisp(tick.x), figure.plotTop + figure.plotH);
      ctx.stroke();
    });
    paintShoeGuides(ctx, figure);
    if (figure.curve.length >= 2) {
      ctx.beginPath();
      figure.curve.forEach((point, index) => (index ? ctx.lineTo(point.x, point.y) : ctx.moveTo(point.x, point.y)));
      ctx.setLineDash([8, 5]);
      ctx.lineWidth = 2.4;
      ctx.strokeStyle = DEPTH_COLOR;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.stroke();
    } else if (figure.curve.length === 1) {
      const point = figure.curve[0];
      ctx.setLineDash([8, 5]);
      ctx.lineWidth = 2.4;
      ctx.strokeStyle = DEPTH_COLOR;
      ctx.beginPath();
      ctx.moveTo(point.x - 10, point.y);
      ctx.lineTo(point.x + 10, point.y);
      ctx.stroke();
    }
    ctx.restore();

    ctx.strokeStyle = "#cbd5e1";
    ctx.lineWidth = 1;
    ctx.setLineDash([]);
    ctx.strokeRect(crisp(figure.plotLeft), crisp(figure.plotTop), figure.plotW, figure.plotH);

    figure.markers.forEach((marker) => {
      if (marker.x < figure.plotLeft - 8 || marker.x > figure.plotLeft + figure.plotW + 8) return;
      paintProblemIcon(ctx, marker.x, marker.y, symbolRadius(), marker.color, marker.icon);
    });

    ctx.save();
    ctx.translate(figure.depthLabelX || 16, (figure.plotTop + figure.plotBottom) / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillStyle = AXIS;
    ctx.font = FONT_BOLD;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(`Depth (${depthUnitLabel()})`, 0, 0);
    ctx.restore();

    ctx.fillStyle = AXIS;
    ctx.font = FONT;
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    figure.depthTicks.forEach((tick) => ctx.fillText(tick.label, figure.plotLeft - 8, tick.y));

    ctx.fillStyle = AXIS;
    ctx.font = FONT;
    figure.dayTicks.forEach((tick) => {
      if (tick.rotate) {
        ctx.save();
        ctx.translate(tick.x, figure.plotBottom + 8);
        ctx.rotate(-Math.PI / 2);
        ctx.textAlign = "right";
        ctx.textBaseline = "middle";
        ctx.fillText(tick.label, 0, 0);
        ctx.restore();
        return;
      }
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      ctx.fillText(tick.label, tick.labelX, figure.plotBottom + 8);
    });
    ctx.font = FONT_BOLD;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillText("Day", figure.plotLeft + figure.plotW / 2, figure.plotBottom + 8 + (figure.dayNumberExtent || 16) + 6);

    paintLegend(ctx, figure);
  }

  function renderCanvas(canvas, scale) {
    const figure = scene();
    canvas.width = Math.max(1, Math.round(figure.w * scale));
    canvas.height = Math.max(1, Math.round(figure.h * scale));
    const ctx = canvas.getContext("2d");
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    paint(ctx, figure);
    return figure;
  }

  function setStatus(text) {
    const el = document.getElementById("ds-status");
    if (el) el.textContent = text || "";
  }

  function fittedWidth(sheet) {
    if (!sheet || !lastScene) return 0;
    const available = sheet.clientWidth - 24;
    if (available < 80) return 0;
    return Math.min(lastScene.w, available);
  }

  function updateZoomUi() {
    const label = document.getElementById("ds-zoom-label");
    if (label) label.textContent = `${Math.round(viewZoom * 100)}%`;
    const zoomOut = document.getElementById("ds-zoom-out");
    const zoomIn = document.getElementById("ds-zoom-in");
    if (zoomOut) zoomOut.disabled = viewZoom <= ZOOM_MIN + 0.001;
    if (zoomIn) zoomIn.disabled = viewZoom >= ZOOM_MAX - 0.001;
  }

  function applyZoom() {
    const canvas = document.getElementById("ds-chart");
    const sheet = document.getElementById("ds-sheet");
    const base = fittedWidth(sheet);
    if (!canvas || !base) return;
    const cssW = base * viewZoom;
    const cssH = lastScene.h * (cssW / lastScene.w);
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;
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
    const sheet = document.getElementById("ds-sheet");
    const canvas = document.getElementById("ds-chart");
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

  function bindChartView() {
    const canvas = document.getElementById("ds-chart");
    const sheet = document.getElementById("ds-sheet");
    if (!canvas || !sheet) return;
    canvas.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      panGesture = {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        left: sheet.scrollLeft,
        top: sheet.scrollTop
      };
      canvas.classList.add("panning");
      try { canvas.setPointerCapture(event.pointerId); } catch (err) { /* Pointer sudah lepas. */ }
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

  function draw() {
    const canvas = document.getElementById("ds-chart");
    if (!canvas) return;
    fillCasingSelect();
    try {
      lastScene = renderCanvas(canvas, 2);
      applyZoom();
      const empty = !!lastScene.empty;
      ["ds-png", "ds-jpg", "ds-pdf"].forEach((id) => {
        const button = document.getElementById(id);
        if (button) button.disabled = empty;
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

  function fileStem() {
    const raw = figureTitle() || "drilling-summary";
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
    const buttons = ["ds-png", "ds-jpg", "ds-pdf"].map((id) => document.getElementById(id));
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
      downloadBlob(blob, `${fileStem()}.${kind === "jpg" ? "jpg" : "png"}`);
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
    const x = (pageW - w) / 2;
    const y = (pageH - h) / 2;
    pdf.addImage(canvas.toDataURL("image/png"), "PNG", x, y, w, h);
    pdf.setProperties({
      title: figureTitle() || "Drilling Summary",
      subject: "Drilling summary"
    });
    pdf.save(`${fileStem()}.pdf`);
    setStatus("PDF berhasil diunduh.");
  }

  function numInput(field, value, placeholder) {
    return `<input data-field="${field}" type="text" inputmode="decimal" autocomplete="off" spellcheck="false" placeholder="${esc(placeholder || "")}" value="${esc(numToInput(value))}" />`;
  }

  function pointHtml(item, index, total) {
    return `<div class="ds-point" data-progress="${item.id}">
      <label>Day${numInput("day", item.day, "1")}</label>
      <label>ft-MD${numInput("depth", item.depth, "0")}</label>
      <label>ft-TVD${numInput("depthTvd", item.depthTvd, "0")}</label>
      <div class="well-actions">
        <button type="button" data-action="progress-up" aria-label="Naik" ${index === 0 ? "disabled" : ""}>↑</button>
        <button type="button" data-action="progress-down" aria-label="Turun" ${index === total - 1 ? "disabled" : ""}>↓</button>
        <button type="button" data-action="progress-delete" aria-label="Hapus">×</button>
      </div>
    </div>`;
  }

  function categoryOptions(value) {
    const current = (value || "").trim();
    const known = CATEGORIES.some((entry) => entry.name === current);
    const mark = (name) => name === current ? " selected" : "";
    const extra = current && !known ? `<option value="${esc(current)}" selected>${esc(current)}</option>` : "";
    const options = CATEGORIES.map((entry) => `<option value="${esc(entry.name)}"${mark(entry.name)}>${esc(entry.name)}</option>`).join("");
    return `<option value=""${current ? "" : " selected"}>Pilih kategori</option>${extra}${options}`;
  }

  function eventHtml(item, index, total) {
    const color = normalizeColor(item.color);
    return `<tr data-event="${item.id}">
      <td class="ds-pick"><input data-pick="1" type="checkbox" aria-label="Pilih masalah" /></td>
      <td>${numInput("day", item.day, "1")}</td>
      <td>${numInput("depth", item.depth, "0")}</td>
      <td>${numInput("depthTvd", item.depthTvd, "0")}</td>
      <td><select data-field="category" aria-label="Kategori">${categoryOptions(item.category)}</select></td>
      <td><input data-field="color" type="color" value="${color}" aria-label="Warna kategori" /></td>
      <td><input data-field="description" type="text" spellcheck="true" value="${esc(item.description)}" /></td>
      <td>
        <div class="well-actions">
          <button type="button" data-action="event-up" aria-label="Naik" ${index === 0 ? "disabled" : ""}>↑</button>
          <button type="button" data-action="event-down" aria-label="Turun" ${index === total - 1 ? "disabled" : ""}>↓</button>
          <button type="button" data-action="event-delete" aria-label="Hapus masalah">×</button>
        </div>
      </td>
    </tr>`;
  }

  function listHost(kind) {
    if (kind === "progress") return { host: "ds-progress", count: "ds-progress-count", items: state.progress, noun: "titik", empty: "Belum ada titik kedalaman." };
    return { host: "ds-events", count: "ds-event-count", items: state.events, noun: "masalah", empty: "Belum ada masalah." };
  }

  function renderList(kind) {
    const meta = listHost(kind);
    const count = document.getElementById(meta.count);
    const host = document.getElementById(meta.host);
    if (count) count.textContent = meta.items.length ? `· ${meta.items.length} ${meta.noun}` : "· kosong";
    if (!host) return;
    if (kind === "event") {
      const body = meta.items.length
        ? meta.items.map((item, index) => eventHtml(item, index, meta.items.length)).join("")
        : `<tr><td class="empty-cell" colspan="8">${meta.empty}</td></tr>`;
      host.innerHTML = `<table class="ds-problems">
        <thead><tr><th class="ds-pick"><input data-pick-all="1" type="checkbox" aria-label="Pilih semua masalah" /></th><th>Day</th><th>Depth (ft-MD)</th><th>Depth (ft-TVD)</th><th>Kategori</th><th>Warna</th><th>Deskripsi</th><th></th></tr></thead>
        <tbody>${body}</tbody>
      </table>`;
      pruneSelection();
      paintSelection();
      return;
    }
    host.innerHTML = meta.items.length
      ? meta.items.map((item, index) => pointHtml(item, index, meta.items.length)).join("")
      : `<p class="micro empty">${meta.empty}</p>`;
  }

  function pruneSelection() {
    const ids = new Set(state.events.map((item) => item.id));
    selectedEvents.forEach((id) => {
      if (!ids.has(id)) selectedEvents.delete(id);
    });
    if (selectAnchor >= state.events.length) selectAnchor = state.events.length - 1;
  }

  function paintSelection() {
    const rows = document.querySelectorAll("#ds-events [data-event]");
    rows.forEach((row) => {
      const on = selectedEvents.has(row.dataset.event);
      row.classList.toggle("is-selected", on);
      const box = row.querySelector("[data-pick]");
      if (box) box.checked = on;
    });
    const all = document.querySelector("#ds-events [data-pick-all]");
    if (all) {
      all.checked = state.events.length > 0 && selectedEvents.size === state.events.length;
      all.indeterminate = selectedEvents.size > 0 && selectedEvents.size < state.events.length;
    }
    const count = document.getElementById("ds-bulk-count");
    const apply = document.getElementById("ds-bulk-apply");
    const category = document.getElementById("ds-bulk-category");
    if (count) {
      count.textContent = selectedEvents.size
        ? `${selectedEvents.size} masalah dipilih.`
        : "Belum ada masalah dipilih.";
    }
    if (apply) apply.disabled = !selectedEvents.size || !category || !category.value;
  }

  function eventIdsBetween(from, to) {
    const start = Math.min(from, to);
    const end = Math.max(from, to);
    const ids = [];
    for (let i = start; i <= end; i += 1) ids.push(state.events[i].id);
    return ids;
  }

  function replaceSelection(from, to, base) {
    selectedEvents.clear();
    if (base) base.forEach((id) => selectedEvents.add(id));
    eventIdsBetween(from, to).forEach((id) => selectedEvents.add(id));
  }

  function eventIndexFromPoint(x, y) {
    const el = document.elementFromPoint(x, y);
    const row = el && el.closest ? el.closest("[data-event]") : null;
    if (!row) return -1;
    return state.events.findIndex((item) => item.id === row.dataset.event);
  }

  function onEventPointerDown(event) {
    if (event.button != null && event.button !== 0) return;
    if (event.target.closest("thead .ds-pick")) {
      event.preventDefault();
      if (state.events.length && selectedEvents.size === state.events.length) selectedEvents.clear();
      else state.events.forEach((item) => selectedEvents.add(item.id));
      selectAnchor = 0;
      paintSelection();
      return;
    }
    const cell = event.target.closest("tbody .ds-pick");
    if (!cell) return;
    const row = cell.closest("[data-event]");
    if (!row) return;
    const index = state.events.findIndex((item) => item.id === row.dataset.event);
    if (index < 0) return;
    event.preventDefault();
    eventDrag = {
      start: index,
      pointerId: event.pointerId,
      moved: false,
      shift: event.shiftKey,
      base: new Set(selectedEvents),
      x: event.clientX,
      y: event.clientY
    };
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch (err) { /* Pointer sudah lepas. */ }
  }

  function onEventPointerMove(event) {
    if (!eventDrag || event.pointerId !== eventDrag.pointerId) return;
    if (Math.hypot(event.clientX - eventDrag.x, event.clientY - eventDrag.y) > 4) eventDrag.moved = true;
    const panel = document.querySelector("#panel-drilling .panel");
    if (panel) {
      const rect = panel.getBoundingClientRect();
      if (event.clientY < rect.top + 36) panel.scrollTop -= 16;
      else if (event.clientY > rect.bottom - 36) panel.scrollTop += 16;
    }
    if (!eventDrag.moved) return;
    const index = eventIndexFromPoint(event.clientX, event.clientY);
    if (index < 0) return;
    replaceSelection(eventDrag.start, index, eventDrag.shift ? eventDrag.base : null);
    paintSelection();
  }

  function onEventPointerUp(event) {
    if (!eventDrag || event.pointerId !== eventDrag.pointerId) return;
    const drag = eventDrag;
    eventDrag = null;
    if (!drag.moved) {
      const id = state.events[drag.start].id;
      if (drag.shift && selectAnchor >= 0) replaceSelection(selectAnchor, drag.start, drag.base);
      else if (selectedEvents.has(id)) selectedEvents.delete(id);
      else selectedEvents.add(id);
      paintSelection();
    }
    selectAnchor = drag.start;
  }

  function onPickChange(event) {
    const input = event.target;
    if (!input.dataset) return;
    if (input.dataset.pickAll != null) {
      if (input.checked) state.events.forEach((item) => selectedEvents.add(item.id));
      else selectedEvents.clear();
      paintSelection();
      return;
    }
    if (input.dataset.pick == null) return;
    const row = input.closest("[data-event]");
    if (!row) return;
    if (input.checked) selectedEvents.add(row.dataset.event);
    else selectedEvents.delete(row.dataset.event);
    const index = state.events.findIndex((item) => item.id === row.dataset.event);
    if (index >= 0) selectAnchor = index;
    paintSelection();
  }

  function applyBulkCategory() {
    const select = document.getElementById("ds-bulk-category");
    const name = select ? select.value : "";
    if (!name || !selectedEvents.size) return;
    const color = colorForCategory(name);
    let count = 0;
    state.events.forEach((item) => {
      if (!selectedEvents.has(item.id)) return;
      item.category = name;
      if (color) item.color = color;
      count += 1;
    });
    persist();
    renderList("event");
    requestDraw();
    setStatus(count === 1 ? `1 masalah diubah ke ${name}.` : `${count} masalah diubah ke ${name}.`);
  }

  function formationHtml(item, index, total) {
    return `<div class="ds-fm" data-fm="${item.id}">
      <div class="ds-fm-top">
        <input data-field="name" type="text" spellcheck="false" autocomplete="off" placeholder="Nama formasi" value="${esc(item.name)}" />
        <input data-field="color" type="color" value="${normalizeColor(item.color)}" aria-label="Warna formasi" />
        <div class="well-actions">
          <button type="button" data-action="fm-up" aria-label="Naik" ${index === 0 ? "disabled" : ""}>↑</button>
          <button type="button" data-action="fm-down" aria-label="Turun" ${index === total - 1 ? "disabled" : ""}>↓</button>
          <button type="button" data-action="fm-delete" aria-label="Hapus formasi">×</button>
        </div>
      </div>
      <div class="ds-fm-depths">
        <label>MD atas (ft-MD)${numInput("topMd", item.topMd == null ? 0 : item.topMd, "0")}</label>
        <label>MD bawah (ft-MD)${numInput("baseMd", item.baseMd, "0")}</label>
        <label>TVD atas (ft-TVD)${numInput("topTvd", item.topTvd == null ? 0 : item.topTvd, "0")}</label>
        <label>TVD bawah (ft-TVD)${numInput("baseTvd", item.baseTvd, "0")}</label>
      </div>
    </div>`;
  }

  function renderFormations() {
    const count = document.getElementById("ds-fm-count");
    const host = document.getElementById("ds-formations");
    if (count) count.textContent = state.formations.length ? `· ${state.formations.length} lapisan` : "· kosong";
    if (!host) return;
    host.innerHTML = state.formations.length
      ? state.formations.map((item, index) => formationHtml(item, index, state.formations.length)).join("")
      : `<p class="micro empty">Belum ada formasi.</p>`;
  }

  function fillCasingSelect() {
    const select = document.getElementById("ds-casing-well");
    if (!select) return;
    resolveCasingWell();
    const wells = casingWells();
    const options = [`<option value="">Tidak ditampilkan</option>`];
    wells.forEach((well) => {
      const name = (well.name || "").trim() || "Tanpa nama";
      options.push(`<option value="${esc(well.id)}">${esc(name)}</option>`);
    });
    if (state.casingWellId && !wells.some((well) => well.id === state.casingWellId)) {
      options.push(`<option value="${esc(state.casingWellId)}">${esc(state.casingWellName || "Sumur tidak ada")}</option>`);
    }
    select.innerHTML = options.join("");
    select.value = state.casingWellId || "";
  }

  function renderAll() {
    renderList("progress");
    renderList("event");
    renderFormations();
    fillCasingSelect();
  }

  function focusPending() {
    if (!focusAfter) return;
    const target = focusAfter;
    focusAfter = null;
    const root = document.querySelector(`[data-${target.kind}="${target.id}"]`);
    const input = root && root.querySelector(`[data-field="${target.field}"]`);
    if (input) input.focus();
  }

  function panelScroll(top) {
    const panel = document.querySelector("#panel-drilling .panel");
    if (!panel) return 0;
    if (top == null) return panel.scrollTop;
    panel.scrollTop = top;
    return top;
  }

  function readMeasured(input, minimum) {
    const raw = input.value.trim();
    if (!raw) {
      input.classList.remove("bad");
      return { ok: true, value: null };
    }
    const n = parseNum(raw);
    if (Number.isNaN(n) || n < minimum) {
      input.classList.add("bad");
      return { ok: false, value: null };
    }
    input.classList.remove("bad");
    return { ok: true, value: Math.round(n * 100) / 100 };
  }

  function officialColor(name) {
    const preset = CATEGORIES.find((entry) => normCat(entry.name) === normCat(name));
    return preset ? preset.color : "";
  }

  function colorForCategory(name) {
    const key = normCat(name);
    if (!key) return "";
    const official = officialColor(name);
    const previous = PREVIOUS_CATEGORY_COLORS[key] || [];
    const match = state.events.find((other) => {
      if (normCat(other.category) !== key) return false;
      const current = normalizeColor(other.color);
      return !previous.includes(current);
    });
    if (official && (!match || normalizeColor(match.color) === official)) return official;
    if (match) return match.color;
    return official;
  }

  function applyEventField(item, field, input, root) {
    if (field === "category") {
      const color = colorForCategory(input.value);
      item.category = input.value;
      if (!color) return;
      const key = normCat(item.category);
      const previous = PREVIOUS_CATEGORY_COLORS[key] || [];
      state.events.forEach((other) => {
        if (other !== item && normCat(other.category) !== key) return;
        const current = normalizeColor(other.color);
        if (other !== item && !previous.includes(current) && current !== color) return;
        other.color = color;
        const otherRoot = other === item ? root : document.querySelector(`[data-event="${other.id}"]`);
        const colorInput = otherRoot && otherRoot.querySelector('[data-field="color"]');
        if (colorInput) colorInput.value = color;
      });
      return;
    }
    if (field === "description") {
      item.description = input.value;
      return;
    }
    if (field === "color") {
      item.color = normalizeColor(input.value);
      const key = normCat(item.category);
      if (!key) return;
      state.events.forEach((other) => {
        if (other.id === item.id || normCat(other.category) !== key) return;
        other.color = item.color;
        const otherRoot = document.querySelector(`[data-event="${other.id}"]`);
        if (!otherRoot) return;
        const colorInput = otherRoot.querySelector('[data-field="color"]');
        if (colorInput) colorInput.value = item.color;
      });
      return;
    }
    const minimum = field === "day" ? 1 : 0;
    const read = readMeasured(input, minimum);
    if (!read.ok) return;
    item[field] = read.value;
  }

  function onField(event) {
    const input = event.target;
    const field = input.dataset ? input.dataset.field : "";
    if (!field) return;
    const progressEl = input.closest("[data-progress]");
    const eventEl = input.closest("[data-event]");
    if (progressEl) {
      const item = state.progress.find((entry) => entry.id === progressEl.dataset.progress);
      if (!item) return;
      if (field === "day" || field === "depth" || field === "depthTvd") {
        const read = readMeasured(input, field === "day" ? 1 : 0);
        if (read.ok) item[field] = read.value;
      }
    } else if (eventEl) {
      const item = state.events.find((entry) => entry.id === eventEl.dataset.event);
      if (!item) return;
      applyEventField(item, field, input, eventEl);
    } else {
      const fmEl = input.closest("[data-fm]");
      if (!fmEl) return;
      const item = state.formations.find((entry) => entry.id === fmEl.dataset.fm);
      if (!item) return;
      if (field === "name") item.name = input.value;
      else if (field === "color") item.color = normalizeColor(input.value);
      else if (field === "topMd" || field === "baseMd" || field === "topTvd" || field === "baseTvd") {
        const read = readMeasured(input, 0);
        if (!read.ok) return;
        const topField = field === "topMd" || field === "topTvd";
        item[field] = topField && read.value == null ? 0 : read.value;
      } else return;
    }
    persist();
    requestDraw();
  }

  function swap(list, from, to) {
    const item = list[from];
    list[from] = list[to];
    list[to] = item;
  }

  function listByKind(kind) {
    return kind === "progress" ? state.progress : state.events;
  }

  function onClick(event) {
    const button = event.target.closest("button");
    if (!button || button.disabled) return;
    const action = button.dataset.action || "";
    const match = /^(progress|event)-(up|down|delete)$/.exec(action);
    if (!match) return;
    const kind = match[1];
    const list = listByKind(kind);
    const root = button.closest(`[data-${kind}]`);
    if (!root) return;
    const index = list.findIndex((item) => item.id === root.dataset[kind]);
    if (index < 0) return;
    if (match[2] === "delete") list.splice(index, 1);
    else if (match[2] === "up" && index > 0) swap(list, index, index - 1);
    else if (match[2] === "down" && index < list.length - 1) swap(list, index, index + 1);
    else return;
    const top = panelScroll();
    persist();
    renderList(kind);
    panelScroll(top);
    requestDraw();
  }

  function addItem(kind) {
    const list = listByKind(kind);
    let created;
    let field = "day";
    if (kind === "progress") created = { id: uid(), day: null, depth: null, depthTvd: null };
    else created = { id: uid(), day: null, depth: null, depthTvd: null, category: "", color: nextColor(), description: "" };
    list.push(created);
    focusAfter = { kind, id: created.id, field };
    const top = panelScroll();
    persist();
    renderList(kind);
    panelScroll(top);
    focusPending();
    requestDraw();
  }

  function nextColor() {
    const used = new Set(state.events.map((item) => normalizeColor(item.color)));
    return PALETTE.find((color) => !used.has(color)) || PALETTE[state.events.length % PALETTE.length];
  }

  function point(day, depth) {
    return { id: uid(), day, depth };
  }

  function problem(day, depth, category, color, description) {
    return { id: uid(), day, depth, category, color, description };
  }

  function layer(name, topMd, baseMd, color) {
    return { id: uid(), name, topMd, baseMd, color };
  }

  function sampleData() {
    const data = {
      title: "Time vs Depth",
      well: "OOA-3",
      subtitle: "PERTAMINA PHE ONWJ | Rig PVD 3",
      td: 10303,
      tdTvd: 6824,
      endDay: 163,
      decimalComma: true,
      depthMode: "md",
      casingWellId: "",
      casingWellName: "OOA-3",
      formations: [
        layer("Pre Parigi", 0, 1500, "#7A3412"),
        layer("Parigi", 1500, 1900, "#2F9E3A"),
        layer("Main", 1900, 4373, "#3F3F3F"),
        layer("Baturaja", 4373, 8020, "#1A73C9"),
        layer("Lower", 8020, 10303, "#F0B429")
      ],
      progress: [
        point(1, 280),
        point(8, 900),
        point(16, 1500),
        point(20, 1900),
        point(34, 1900),
        point(46, 4373),
        point(70, 4373),
        point(72, 4711),
        point(75, 6300),
        point(88, 8020),
        point(108, 8020),
        point(114, 10303),
        point(163, 10303)
      ],
      events: [
        problem(18, 1789, "Loss", "#08bf26", 'Dynamic losses saat enlarge 26" pilot hole. Combat loss berulang sebelum POOH.'),
        problem(51, 4330, "Tight Spot/Overpull/Stall", "#d1a400", 'Overpull 20 klbs saat POOH 17-1/2" BHA @2328 ft. Work string & jarring – berhasil.'),
        problem(70, 4330, "BOP / Equipment", "#9f1239", "BOP test plug bocor (drop 50 psi/min). Ganti plug seal, re-test hingga pass."),
        problem(72, 4711, "Stuck Pipe", "#dc2626", 'Stuck pipe mekanis di Upper 11-1/2" String Stab BHA. Jar down 30 klbs – string free.'),
        problem(74, 6300, "Stuck Pipe", "#dc2626", "Stuck pipe @5876 ft; string stall; high torque 25 klbs.ft; overpull 20–25 klbs. Jar down 3×; backream OOH."),
        problem(75, 6300, "Stuck Pipe", "#dc2626", "Stuck pipe berlanjut; overpull 20–25 klbs; string stall beberapa kali saat backream POOH."),
        problem(122, 7739, "Influx / Kick Indicator", "#0284c7", "Gain influx 2 bph saat POOH @7739 ft; overpull 20 klbs @6542 ft. Flow check – well static."),
        problem(125, 7739, "Cementing Issue", "#be123c", "Liner running tool bocor saat break circulation (110–125 psi). Replace running tool & re-test.")
      ]
    };
    const scale = (value) => value == null ? null : Math.round(value * 0.662);
    data.formations.forEach((item) => {
      item.topTvd = scale(item.topMd);
      item.baseTvd = scale(item.baseMd);
    });
    data.progress.forEach((item) => { item.depthTvd = scale(item.depth); });
    data.events.forEach((item) => { item.depthTvd = scale(item.depth); });
    return data;
  }

  function applyData(data) {
    state.title = data.title || "Time vs Depth";
    state.well = data.well || "";
    state.subtitle = data.subtitle || "";
    state.td = positiveOrNull(data.td);
    state.tdTvd = positiveOrNull(data.tdTvd);
    state.endDay = dayOrNull(data.endDay);
    state.dayMode = data.dayMode === "all" ? "all" : "interval";
    state.dayStep = dayOrNull(data.dayStep);
    state.decimalComma = data.decimalComma !== false;
    state.depthMode = data.depthMode === "tvd" ? "tvd" : "md";
    state.casingWellId = data.casingWellId || "";
    state.casingWellName = data.casingWellName || "";
    state.showCasing = data.showCasing !== false;
    state.showFormations = data.showFormations !== false;
    state.symbolSize = clampSymbolSize(data.symbolSize);
    state.colorRevision = Number(data.colorRevision) || 0;
    state.formations = data.formations || [];
    state.progress = data.progress || [];
    state.events = data.events || [];
  }

  function syncDepthMode() {
    const md = document.getElementById("ds-mode-md");
    const tvd = document.getElementById("ds-mode-tvd");
    const onTvd = depthMode() === "tvd";
    if (md) md.setAttribute("aria-pressed", onTvd ? "false" : "true");
    if (tvd) tvd.setAttribute("aria-pressed", onTvd ? "true" : "false");
  }

  function setDepthMode(mode) {
    state.depthMode = mode === "tvd" ? "tvd" : "md";
    syncDepthMode();
    persist();
    requestDraw();
  }

  function applyChrome() {
    const title = document.getElementById("ds-title");
    const well = document.getElementById("ds-well");
    const subtitle = document.getElementById("ds-subtitle");
    const td = document.getElementById("ds-td");
    const tdTvd = document.getElementById("ds-td-tvd");
    const endDay = document.getElementById("ds-end");
    const dayMode = document.getElementById("ds-day-mode");
    const dayStep = document.getElementById("ds-day-step");
    const dayStepWrap = document.getElementById("ds-day-step-wrap");
    const decimal = document.getElementById("ds-decimal");
    const showCasing = document.getElementById("ds-show-casing");
    const showFormations = document.getElementById("ds-show-fm");
    const symbolSize = document.getElementById("ds-symbol");
    if (title) title.value = state.title;
    if (well) well.value = state.well;
    if (subtitle) subtitle.value = state.subtitle;
    if (td) td.value = numToInput(state.td);
    if (tdTvd) tdTvd.value = numToInput(state.tdTvd);
    if (endDay) endDay.value = numToInput(state.endDay);
    if (dayMode) dayMode.value = state.dayMode === "all" ? "all" : "interval";
    if (dayStep) dayStep.value = numToInput(state.dayStep);
    if (dayStepWrap) dayStepWrap.hidden = state.dayMode === "all";
    if (decimal) decimal.value = state.decimalComma ? "comma" : "dot";
    if (showCasing) showCasing.checked = state.showCasing !== false;
    if (showFormations) showFormations.checked = state.showFormations !== false;
    if (symbolSize) symbolSize.value = numToInput(state.symbolSize);
    syncDepthMode();
    fillCasingSelect();
  }

  function persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        title: state.title,
        well: state.well,
        subtitle: state.subtitle,
        td: state.td,
        tdTvd: state.tdTvd,
        endDay: state.endDay,
        dayMode: state.dayMode,
        dayStep: state.dayStep,
        decimalComma: state.decimalComma,
        depthMode: state.depthMode,
        casingWellId: state.casingWellId,
        casingWellName: state.casingWellName,
        showCasing: state.showCasing,
        showFormations: state.showFormations,
        symbolSize: state.symbolSize,
        colorRevision: state.colorRevision,
        formations: state.formations,
        progress: state.progress,
        events: state.events
      }));
    } catch (err) { /* storage unavailable */ }
  }

  function depthOrNull(value) {
    const n = numberOrNull(value);
    return n != null && n >= 0 ? n : null;
  }

  function normalizeProgress(raw) {
    return {
      id: raw.id || uid(),
      day: dayOrNull(raw.day),
      depth: depthOrNull(raw.depth),
      depthTvd: depthOrNull(raw.depthTvd)
    };
  }

  function canonicalCategory(value) {
    const name = String(value || "").trim();
    if (normCat(name) === "tight spot/overpull") return "Tight Spot/Overpull/Stall";
    return name;
  }

  function categoryColor(name, current) {
    const official = officialColor(name);
    if (!official) return current;
    const previous = PREVIOUS_CATEGORY_COLORS[normCat(name)] || [];
    if (previous.includes(current)) return official;
    return current;
  }

  function useOfficialCategoryColors(force) {
    state.events.forEach((item) => {
      const official = officialColor(item.category);
      if (!official) return;
      const current = normalizeColor(item.color);
      const previous = PREVIOUS_CATEGORY_COLORS[normCat(item.category)] || [];
      if (force || previous.includes(current)) item.color = official;
    });
  }

  function normalizeEvent(raw) {
    const category = canonicalCategory(raw.category);
    return {
      id: raw.id || uid(),
      day: dayOrNull(raw.day),
      depth: depthOrNull(raw.depth),
      depthTvd: depthOrNull(raw.depthTvd),
      category,
      color: categoryColor(category, normalizeColor(raw.color)),
      description: raw.description || ""
    };
  }

  function normalizeFormation(raw) {
    const top = numberOrNull(raw.topMd);
    const base = numberOrNull(raw.baseMd);
    const topTvd = numberOrNull(raw.topTvd);
    const baseTvd = numberOrNull(raw.baseTvd);
    return {
      id: raw.id || uid(),
      name: raw.name || "",
      color: normalizeColor(raw.color || FM_COLORS[0]),
      topMd: top == null ? 0 : (top >= 0 ? top : null),
      baseMd: base != null && base >= 0 ? base : null,
      topTvd: topTvd == null ? 0 : (topTvd >= 0 ? topTvd : null),
      baseTvd: baseTvd != null && baseTvd >= 0 ? baseTvd : null
    };
  }

  function ingest(data) {
    if (!data || !Array.isArray(data.progress) || !Array.isArray(data.events)) return false;
    applyData({
      title: data.title || "Time vs Depth",
      well: data.well || "",
      subtitle: data.subtitle || "",
      td: positiveOrNull(data.td),
      tdTvd: positiveOrNull(data.tdTvd),
      endDay: dayOrNull(data.endDay),
      dayMode: data.dayMode,
      dayStep: data.dayStep,
      decimalComma: data.decimalComma !== false,
      depthMode: data.depthMode,
      casingWellId: data.casingWellId || "",
      casingWellName: data.casingWellName || "",
      showCasing: data.showCasing,
      showFormations: data.showFormations,
      symbolSize: data.symbolSize,
      colorRevision: data.colorRevision,
      formations: Array.isArray(data.formations) ? data.formations.map(normalizeFormation) : [],
      progress: data.progress.map(normalizeProgress),
      events: data.events.map(normalizeEvent)
    });
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
      well: state.well,
      subtitle: state.subtitle,
      td: state.td,
      tdTvd: state.tdTvd,
      endDay: state.endDay,
      dayMode: state.dayMode,
      dayStep: state.dayStep,
      decimalComma: state.decimalComma,
      depthMode: state.depthMode,
      casingWellId: state.casingWellId,
      casingWellName: state.casingWellName,
      showCasing: state.showCasing,
      showFormations: state.showFormations,
      symbolSize: state.symbolSize,
      colorRevision: state.colorRevision,
      formations: state.formations,
      progress: state.progress,
      events: state.events
    };
  }

  function loadProject(data) {
    if (!ingest(data)) return false;
    applyChrome();
    persist();
    renderAll();
    requestDraw();
    return true;
  }

  function pad2(value) {
    return String(value).padStart(2, "0");
  }

  function projectStatus(text) {
    ["status", "csg-status", "ds-status"].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.textContent = text;
    });
  }

  function activeTab() {
    const selected = document.querySelector('.tab[aria-selected="true"]');
    if (!selected) return "azimuth";
    if (selected.id === "tab-casing") return "casing";
    if (selected.id === "tab-drilling") return "drilling";
    return "azimuth";
  }

  function saveProjectFile() {
    const now = new Date();
    const stamp = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
    const payload = {
      kind: "gambar-sumur",
      version: 1,
      savedAt: now.toISOString(),
      tab: activeTab(),
      azimuth: window.AzimuthChart.snapshot(),
      casing: window.CasingSetting.snapshot(),
      drilling: snapshot()
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `gambar-sumur-${stamp}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 1500);
    projectStatus("Berkas disimpan. Buka berkas itu lagi setelah program ditutup.");
  }

  async function openProjectFile(file) {
    let data;
    try {
      data = JSON.parse(await file.text());
    } catch (err) {
      projectStatus("Berkas tidak bisa dibaca.");
      return;
    }
    if (!data || data.kind !== "gambar-sumur" || data.version !== 1) {
      projectStatus("Berkas ini bukan simpanan Gambar Sumur.");
      return;
    }
    const azimuthOk = data.azimuth ? window.AzimuthChart.load(data.azimuth) : false;
    const casingOk = data.casing ? window.CasingSetting.load(data.casing) : false;
    const drillingOk = data.drilling ? loadProject(data.drilling) : false;
    if (!azimuthOk && !casingOk && !drillingOk) {
      projectStatus("Berkas tidak berisi data yang bisa dibuka.");
      return;
    }
    window.CasingSetting.activate(data.tab || activeTab());
    projectStatus("Data dibuka kembali dari berkas.");
  }

  function loadSample() {
    applyData(sampleData());
    applyChrome();
    persist();
    renderAll();
    requestDraw();
    setStatus("Contoh OOA-3 dimuat. Formasi contoh hanya untuk tampilan. Casing mengikuti sumur OOA-3 bila sudah ada di Casing Setting Depth.");
  }

  function clearAll() {
    state.progress = [];
    state.events = [];
    state.formations = [];
    state.casingWellId = "";
    state.casingWellName = "";
    persist();
    renderAll();
    requestDraw();
    setStatus("Kedalaman, formasi, dan masalah dikosongkan.");
  }

  function pasteRow(line) {
    if (line.includes("\t")) return line.split("\t").map((cell) => cell.trim());
    if (line.includes(";")) return line.split(";").map((cell) => cell.trim());
    const trimmed = line.trim();
    const key = trimmed.split(/\s+/)[0].toLowerCase();
    if (key === "top" || key === "bottom" || key === "atas" || key === "bawah" || /^\d/.test(trimmed)) {
      return trimmed.split(/\s+/);
    }
    return [trimmed];
  }

  function cellNum(cell) {
    if (cell == null || String(cell).trim() === "") return null;
    const n = parseNum(cell);
    if (n == null || Number.isNaN(n)) return null;
    return Math.round(n * 100) / 100;
  }

  function parseDepthPaste(text) {
    const lines = String(text || "").split(/\r?\n/).map((line) => line.replace(/\s+$/g, "")).filter((line) => line.trim());
    const rows = lines.map(pasteRow).filter((cells) => cells.some((cell) => cell !== ""));
    const body = rows.length && rows[0].some((cell) => /[a-z]/i.test(cell)) ? rows.slice(1) : rows;
    const numericRows = body.map((cells) => cells.map(cellNum));
    const wide = numericRows.filter((values) => values.filter((value) => value != null).length > 2);
    if ((body.length === 2 || body.length === 3)
      && wide.length === body.length
      && wide[0].length > body.length
      && wide.every((row) => row.length === wide[0].length)) {
      return wide[0].map((day, index) => ({
        day,
        depth: wide[1][index],
        depthTvd: wide[2] ? wide[2][index] : null
      })).filter((item) => item.day != null);
    }
    const points = [];
    body.forEach((cells) => {
      const day = cellNum(cells[0]);
      if (day == null) return;
      points.push({
        day,
        depth: cells.length > 1 ? cellNum(cells[1]) : null,
        depthTvd: cells.length > 2 ? cellNum(cells[2]) : null
      });
    });
    return points;
  }

  function applyDepthPaste(text) {
    const source = text == null ? document.getElementById("ds-paste").value : text;
    const points = parseDepthPaste(source).filter((item) => {
      const dayOk = item.day != null && item.day >= 1;
      const mdOk = item.depth != null && item.depth >= 0;
      const tvdOk = item.depthTvd != null && item.depthTvd >= 0;
      return dayOk && (mdOk || tvdOk);
    });
    if (!points.length) {
      setStatus("Tidak ada baris Day, ft-MD, dan ft-TVD. Salin tiga kolom dari Excel.");
      return;
    }
    state.progress = points.map((item) => ({
      id: uid(),
      day: item.day,
      depth: item.depth != null && item.depth >= 0 ? item.depth : null,
      depthTvd: item.depthTvd != null && item.depthTvd >= 0 ? item.depthTvd : null
    }));
    const box = document.getElementById("ds-paste");
    if (box) box.value = "";
    persist();
    renderList("progress");
    requestDraw();
    setStatus(`${points.length} titik kedalaman ditempel.`);
  }

  function depthLabelKey(text) {
    return String(text || "").trim().toLowerCase().replace(/\s+/g, " ");
  }

  function parseFormationPaste(text) {
    const lines = String(text || "").split(/\r?\n/).map((line) => line.replace(/\s+$/g, "")).filter((line) => line.trim());
    const rows = lines.map(pasteRow).filter((cells) => cells.some((cell) => cell !== ""));
    let start = 0;
    if (rows.length && rows[0].some((cell) => /formasi|ft-md|ft-tvd|tvd|md/i.test(cell)) && !/^(top|bottom|atas|bawah)$/i.test(rows[0][0] || "")) start = 1;
    const layers = [];
    let current = null;
    const push = () => {
      if (!current) return;
      if ((current.name || "").trim() || current.baseMd != null || current.baseTvd != null) layers.push(current);
      current = null;
    };
    for (let i = start; i < rows.length; i += 1) {
      const cells = rows[i];
      const key = depthLabelKey(cells[0]);
      if (key === "top" || key === "atas") {
        if (!current) current = { name: "", topMd: 0, baseMd: null, topTvd: 0, baseTvd: null };
        const topMd = cellNum(cells[1]);
        const topTvd = cellNum(cells[2]);
        current.topMd = topMd == null ? 0 : topMd;
        current.topTvd = topTvd == null ? 0 : topTvd;
        continue;
      }
      if (key === "bottom" || key === "bawah") {
        if (!current) current = { name: "", topMd: 0, baseMd: null, topTvd: 0, baseTvd: null };
        current.baseMd = cellNum(cells[1]);
        current.baseTvd = cellNum(cells[2]);
        continue;
      }
      push();
      current = {
        name: (cells[0] || "").trim(),
        topMd: 0,
        baseMd: null,
        topTvd: 0,
        baseTvd: null
      };
    }
    push();
    return layers.filter((item) => depthLabelKey(item.name) !== "formasi");
  }

  function applyFormationPaste(text) {
    const source = text == null ? document.getElementById("ds-fm-paste").value : text;
    const layers = parseFormationPaste(source);
    if (!layers.length) {
      setStatus("Formasi tidak terbaca. Salin nama formasi, lalu baris Top dan Bottom dengan ft-MD dan ft-TVD.");
      return;
    }
    state.formations = layers.map((item, index) => ({
      id: uid(),
      name: item.name,
      color: FM_COLORS[index % FM_COLORS.length],
      topMd: item.topMd == null ? 0 : item.topMd,
      baseMd: item.baseMd,
      topTvd: item.topTvd == null ? 0 : item.topTvd,
      baseTvd: item.baseTvd
    }));
    const box = document.getElementById("ds-fm-paste");
    if (box) box.value = "";
    const top = panelScroll();
    persist();
    renderFormations();
    panelScroll(top);
    requestDraw();
    setStatus(`${layers.length} formasi ditempel.`);
  }

  function onFormationClick(event) {
    const button = event.target.closest("button");
    if (!button || button.disabled) return;
    const action = button.dataset.action || "";
    const root = button.closest("[data-fm]");
    if (!root) return;
    const index = state.formations.findIndex((item) => item.id === root.dataset.fm);
    if (index < 0) return;
    if (action === "fm-delete") state.formations.splice(index, 1);
    else if (action === "fm-up" && index > 0) swap(state.formations, index, index - 1);
    else if (action === "fm-down" && index < state.formations.length - 1) swap(state.formations, index, index + 1);
    else return;
    const top = panelScroll();
    persist();
    renderFormations();
    panelScroll(top);
    requestDraw();
  }

  function addFormation() {
    const created = {
      id: uid(),
      name: "",
      color: FM_COLORS[state.formations.length % FM_COLORS.length],
      topMd: 0,
      baseMd: null,
      topTvd: 0,
      baseTvd: null
    };
    state.formations.push(created);
    focusAfter = { kind: "fm", id: created.id, field: "name" };
    const top = panelScroll();
    persist();
    renderFormations();
    panelScroll(top);
    focusPending();
    requestDraw();
  }

  const EVENT_PASTE_FIELDS = ["day", "depth", "depthTvd"];

  function eventPasteRows(text) {
    const lines = String(text || "").split(/\r?\n/).map((line) => line.replace(/\s+$/g, "")).filter((line) => line.trim());
    const rows = lines.map(pasteRow).filter((cells) => cells.some((cell) => cell !== ""));
    if (!rows.length) return [];
    if (rows[0].some((cell) => /[a-z]/i.test(cell))) return rows.slice(1);
    return rows;
  }

  function writeEventDepths(item, cells) {
    EVENT_PASTE_FIELDS.forEach((name, index) => {
      if (index >= cells.length) return;
      const value = cellNum(cells[index]);
      const minimum = name === "day" ? 1 : 0;
      item[name] = value == null || value < minimum ? null : value;
    });
  }

  function onEventPaste(event) {
    const input = event.target;
    const field = input && input.dataset ? input.dataset.field : "";
    if (EVENT_PASTE_FIELDS.indexOf(field) < 0) return;
    const text = event.clipboardData && event.clipboardData.getData("text");
    if (!text) return;
    const rows = eventPasteRows(text);
    const filled = rows.reduce((count, cells) => count + cells.filter((cell) => cell !== "").length, 0);
    if (!rows.length || (rows.length < 2 && filled < 2 && !/[\t\n;]/.test(text))) return;
    const row = input.closest("[data-event]");
    if (!row) return;
    const index = state.events.findIndex((entry) => entry.id === row.dataset.event);
    if (index < 0) return;
    event.preventDefault();
    rows.forEach((cells, offset) => {
      let item = state.events[index + offset];
      if (!item) {
        item = {
          id: uid(),
          day: null,
          depth: null,
          depthTvd: null,
          category: "",
          color: nextColor(),
          description: ""
        };
        state.events.push(item);
      }
      writeEventDepths(item, cells);
    });
    persist();
    renderList("event");
    requestDraw();
    setStatus(rows.length === 1 ? "1 masalah ditempel." : `${rows.length} masalah ditempel.`);
  }

  function bind() {
    ["ds-progress", "ds-events", "ds-formations"].forEach((id) => {
      const host = document.getElementById(id);
      host.addEventListener("input", onField);
      host.addEventListener("change", onField);
      host.addEventListener("click", id === "ds-formations" ? onFormationClick : onClick);
      if (id === "ds-events") {
        host.addEventListener("paste", onEventPaste);
        host.addEventListener("pointerdown", onEventPointerDown);
        host.addEventListener("pointermove", onEventPointerMove);
        host.addEventListener("pointerup", onEventPointerUp);
        host.addEventListener("pointercancel", onEventPointerUp);
        host.addEventListener("change", onPickChange);
      }
    });
    document.getElementById("ds-add-progress").addEventListener("click", () => addItem("progress"));
    document.getElementById("ds-paste-apply").addEventListener("click", () => applyDepthPaste());
    document.getElementById("ds-paste").addEventListener("paste", (event) => {
      const text = event.clipboardData && event.clipboardData.getData("text");
      if (!text) return;
      event.preventDefault();
      applyDepthPaste(text);
    });
    document.getElementById("ds-fm-paste-apply").addEventListener("click", () => applyFormationPaste());
    document.getElementById("ds-fm-paste").addEventListener("paste", (event) => {
      const text = event.clipboardData && event.clipboardData.getData("text");
      if (!text) return;
      event.preventDefault();
      applyFormationPaste(text);
    });
    document.getElementById("ds-mode-md").addEventListener("click", () => setDepthMode("md"));
    document.getElementById("ds-mode-tvd").addEventListener("click", () => setDepthMode("tvd"));
    document.getElementById("ds-add-event").addEventListener("click", () => addItem("event"));
    const bulkCategory = document.getElementById("ds-bulk-category");
    if (bulkCategory) {
      bulkCategory.innerHTML = `<option value="">Pilih kategori</option>${CATEGORIES.map((entry) => `<option value="${esc(entry.name)}">${esc(entry.name)}</option>`).join("")}`;
      bulkCategory.addEventListener("change", paintSelection);
    }
    const bulkApply = document.getElementById("ds-bulk-apply");
    if (bulkApply) bulkApply.addEventListener("click", applyBulkCategory);
    document.getElementById("ds-add-fm").addEventListener("click", addFormation);
    document.getElementById("ds-casing-well").addEventListener("change", (event) => {
      const well = casingWells().find((item) => item.id === event.target.value);
      state.casingWellId = event.target.value;
      state.casingWellName = well ? (well.name || "").trim() : "";
      persist();
      requestDraw();
    });
    document.getElementById("ds-show-casing").addEventListener("change", (event) => {
      state.showCasing = event.target.checked;
      persist();
      requestDraw();
    });
    document.getElementById("ds-show-fm").addEventListener("change", (event) => {
      state.showFormations = event.target.checked;
      persist();
      requestDraw();
    });
    document.getElementById("ds-sample").addEventListener("click", loadSample);
    document.getElementById("ds-clear").addEventListener("click", clearAll);
    document.getElementById("ds-title").addEventListener("input", (event) => {
      state.title = event.target.value;
      persist();
      requestDraw();
    });
    document.getElementById("ds-well").addEventListener("input", (event) => {
      state.well = event.target.value;
      persist();
      requestDraw();
    });
    document.getElementById("ds-subtitle").addEventListener("input", (event) => {
      state.subtitle = event.target.value;
      persist();
      requestDraw();
    });
    document.getElementById("ds-td").addEventListener("input", (event) => {
      const raw = event.target.value.trim();
      if (!raw) {
        state.td = null;
        event.target.classList.remove("bad");
      } else {
        const n = parseNum(raw);
        if (Number.isNaN(n) || n <= 0) event.target.classList.add("bad");
        else {
          state.td = n;
          event.target.classList.remove("bad");
        }
      }
      persist();
      requestDraw();
    });
    document.getElementById("ds-td-tvd").addEventListener("input", (event) => {
      const raw = event.target.value.trim();
      if (!raw) {
        state.tdTvd = null;
        event.target.classList.remove("bad");
      } else {
        const n = parseNum(raw);
        if (Number.isNaN(n) || n <= 0) event.target.classList.add("bad");
        else {
          state.tdTvd = n;
          event.target.classList.remove("bad");
        }
      }
      persist();
      requestDraw();
    });
    document.getElementById("ds-symbol").addEventListener("input", (event) => {
      const raw = event.target.value.trim();
      if (!raw) {
        state.symbolSize = 9;
        event.target.classList.remove("bad");
      } else {
        const n = parseNum(raw);
        if (Number.isNaN(n) || n < 4 || n > 28) event.target.classList.add("bad");
        else {
          state.symbolSize = Math.round(n);
          event.target.classList.remove("bad");
        }
      }
      persist();
      requestDraw();
    });
    document.getElementById("ds-end").addEventListener("input", (event) => {
      const raw = event.target.value.trim();
      if (!raw) {
        state.endDay = null;
        event.target.classList.remove("bad");
      } else {
        const n = parseNum(raw);
        if (Number.isNaN(n) || n < 1) event.target.classList.add("bad");
        else {
          state.endDay = n;
          event.target.classList.remove("bad");
        }
      }
      persist();
      requestDraw();
    });
    document.getElementById("ds-day-mode").addEventListener("change", (event) => {
      state.dayMode = event.target.value === "all" ? "all" : "interval";
      const wrap = document.getElementById("ds-day-step-wrap");
      if (wrap) wrap.hidden = state.dayMode === "all";
      persist();
      requestDraw();
    });
    document.getElementById("ds-day-step").addEventListener("input", (event) => {
      const raw = event.target.value.trim();
      if (!raw) {
        state.dayStep = null;
        event.target.classList.remove("bad");
      } else {
        const n = parseNum(raw);
        if (Number.isNaN(n) || n < 1) event.target.classList.add("bad");
        else {
          state.dayStep = n;
          event.target.classList.remove("bad");
        }
      }
      persist();
      requestDraw();
    });
    document.getElementById("ds-decimal").addEventListener("change", (event) => {
      state.decimalComma = event.target.value === "comma";
      const top = panelScroll();
      applyChrome();
      persist();
      renderAll();
      panelScroll(top);
      requestDraw();
    });
    document.getElementById("ds-png").addEventListener("click", () => exportImage("png"));
    document.getElementById("ds-jpg").addEventListener("click", () => exportImage("jpg"));
    document.getElementById("ds-pdf").addEventListener("click", () => exportImage("pdf"));
    document.getElementById("btn-save-project").addEventListener("click", saveProjectFile);
    document.getElementById("btn-open-project").addEventListener("click", () => {
      document.getElementById("project-file").click();
    });
    document.getElementById("project-file").addEventListener("change", (event) => {
      const file = event.target.files && event.target.files[0];
      event.target.value = "";
      if (file) openProjectFile(file);
    });
    document.getElementById("ds-zoom-in").addEventListener("click", () => setViewZoom(viewZoom + ZOOM_STEP));
    document.getElementById("ds-zoom-out").addEventListener("click", () => setViewZoom(viewZoom - ZOOM_STEP));
    document.getElementById("ds-zoom-fit").addEventListener("click", () => setViewZoom(1));
    bindChartView();
    const sheet = document.getElementById("ds-sheet");
    if (typeof ResizeObserver !== "undefined" && sheet) {
      const observer = new ResizeObserver(() => {
        const panel = document.getElementById("panel-drilling");
        if (panel && !panel.hidden) applyZoom();
      });
      observer.observe(sheet);
    }
  }

  function init() {
    applyChrome();
    renderAll();
    bind();
    const panel = document.getElementById("panel-drilling");
    if (panel && !panel.hidden) draw();
    setStatus(hadStored ? "Data drilling terakhir dibuka kembali." : "Contoh OOA-3 dimuat. Formasi contoh hanya untuk tampilan. Casing mengikuti sumur OOA-3 bila sudah ada di Casing Setting Depth.");
  }

  function bootState() {
    hadStored = loadStored();
    if (!hadStored) applyData(sampleData());
    const forceOfficial = (Number(state.colorRevision) || 0) < 2;
    useOfficialCategoryColors(forceOfficial);
    state.colorRevision = 2;
    persist();
  }

  bootState();
  window.DrillingSummary = { draw, snapshot, load: loadProject };
  document.addEventListener("DOMContentLoaded", init);
})();
