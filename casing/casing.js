(function () {
  const STORAGE_KEY = "casing-setting-v1";
  const TAB_KEY = "gambar-sumur-tab";
  const FONT = "12px Arial, Helvetica, sans-serif";
  const FONT_BOLD = "700 12px Arial, Helvetica, sans-serif";
  const FONT_WELL = "700 15px Arial, Helvetica, sans-serif";
  const FONT_TITLE = '600 22px "Palatino Linotype", Palatino, "Times New Roman", serif';
  const LINE_H = 15;
  const SHOE = 15;
  const PIPE = 2.8;
  const HANG_H = 18;
  const HANG_LEFT = 1;
  const HANG_RIGHT = 11;
  const FM_COLORS = ["#7A3412", "#2E8B3C", "#3A3A3A", "#8FB56A", "#00B7CE", "#123C48", "#1B6FCB", "#E0A820"];

  const state = {
    title: "",
    unit: "ft",
    decimalComma: true,
    tvdMax: null,
    endLabel: "End of Well",
    formations: [],
    wells: []
  };

  const openWells = new Set();
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

  function uid() {
    return "c" + Math.random().toString(36).slice(2, 10);
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

  function parseNum(value) {
    let text = String(value ?? "").trim().toLowerCase();
    if (!text) return null;
    text = text.replace(/\s+/g, "").replace(/[a-z°'"]/g, "");
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

  function dataMax() {
    let max = 0;
    state.formations.forEach((fm) => {
      if (fm.baseTvd != null) max = Math.max(max, fm.baseTvd);
      if (fm.topTvd != null) max = Math.max(max, fm.topTvd);
    });
    state.wells.forEach((well) => {
      if (well.tdTvd != null) max = Math.max(max, well.tdTvd);
      well.casings.forEach((casing) => {
        if (casing.shoeTvd != null) max = Math.max(max, casing.shoeTvd);
        if (casing.topTvd != null) max = Math.max(max, casing.topTvd);
      });
    });
    return max;
  }

  function domainMax() {
    const data = dataMax();
    const auto = scaleMax(data);
    if (state.tvdMax != null && state.tvdMax > 0 && state.tvdMax >= data) return state.tvdMax;
    return auto;
  }

  function isLiner(casing) {
    return casing.kind === "liner";
  }

  function deepestCasingShoe(well, exceptId) {
    let best = null;
    (well.casings || []).forEach((casing) => {
      if (casing.id === exceptId || isLiner(casing) || casing.shoeTvd == null) return;
      if (best == null || casing.shoeTvd > best) best = casing.shoeTvd;
    });
    return best;
  }

  function autoOverlap(shoeTvd) {
    const tvdMax = Math.max(domainMax(), shoeTvd, 1);
    const plotH = Math.max(640, Math.min(980, Math.round(tvdMax * 0.12)));
    const span = Math.max(1, plotH - 16);
    const fromScale = (80 / span) * tvdMax;
    const capped = Math.min(fromScale, shoeTvd * 0.45);
    const floor = state.unit === "m" ? 30.48 : 100;
    return Math.max(floor, capped);
  }

  function linerTop(casing, well) {
    if (casing.topTvd != null) return casing.topTvd;
    const shoe = deepestCasingShoe(well, casing.id);
    const base = shoe == null ? casing.shoeTvd : shoe;
    if (base == null) return 0;
    let top = Math.max(0, base - autoOverlap(base));
    if (casing.shoeTvd != null && top >= casing.shoeTvd) {
      top = Math.max(0, casing.shoeTvd - autoOverlap(casing.shoeTvd));
    }
    return top;
  }

  function preparedCasing(casing, well) {
    if (casing.shoeMd == null || casing.shoeTvd == null) return null;
    const liner = isLiner(casing);
    const topTvd = liner ? linerTop(casing, well) : 0;
    if (liner && topTvd >= casing.shoeTvd) return null;
    return {
      name: (casing.name || "").trim() || (liner ? "Liner" : "Casing"),
      shoeMd: casing.shoeMd,
      shoeTvd: casing.shoeTvd,
      topTvd,
      topGiven: liner && casing.topTvd != null,
      liner,
      style: lineKind(casing.style)
    };
  }

  function lineKind(value) {
    if (value === "openhole" || value === "perforated") return value;
    return "solid";
  }

  function topLines(item) {
    const unit = state.unit;
    return [`TOL at ${fmt(item.topTvd)} TVD-${unit}`];
  }

  function casingLines(item) {
    const unit = state.unit;
    return [
      item.name,
      `at ${fmt(item.shoeMd)} MD-${unit} / ${fmt(item.shoeTvd)} TVD-${unit}`
    ];
  }

  function tdLines(well) {
    if (well.tdTvd == null) return null;
    const unit = state.unit;
    const head = (state.endLabel || "").trim() || "End of Well";
    if (well.tdMd != null) {
      return [head, `TD ${fmt(well.tdMd)} MD-${unit} / ${fmt(well.tdTvd)} TVD-${unit}`];
    }
    return [head, `TD ${fmt(well.tdTvd)} TVD-${unit}`];
  }

  function blockWidth(lines) {
    return Math.max(
      textWidth(FONT_BOLD, lines[0] || ""),
      textWidth(FONT, lines[1] || "")
    );
  }

  function describeCasing(casing, well) {
    if (casing.shoeMd == null || casing.shoeTvd == null) {
      return { text: "Isi MD dan TVD shoe.", warn: false };
    }
    if (!isLiner(casing)) return { text: "Casing, dari 0 TVD sampai shoe.", warn: false };
    const topTvd = linerTop(casing, well);
    if (topTvd >= casing.shoeTvd) {
      return { text: "TVD atas harus lebih dangkal dari TVD shoe.", warn: true };
    }
    if (casing.topTvd != null) return { text: `Top of liner di TVD ${fmt(topTvd)}.`, warn: false };
    const shoe = deepestCasingShoe(well, casing.id);
    if (shoe == null) {
      return { text: `Top of liner otomatis di TVD ${fmt(topTvd)}. Isi Top of liner jika ada data.`, warn: false };
    }
    return { text: `Top of liner otomatis di TVD ${fmt(topTvd)}, lebih tinggi dari shoe casing terdalam supaya sambungannya jelas. Isi Top of liner jika ada data.`, warn: false };
  }

  function fmHint(fm) {
    if (fm.topTvd == null || fm.baseTvd == null) return { text: "Isi TVD atas dan TVD bawah.", warn: false };
    if (fm.baseTvd <= fm.topTvd) return { text: "TVD bawah harus lebih dalam dari TVD atas.", warn: true };
    return { text: "", warn: false };
  }

  function tdHint(well) {
    if (well.tdTvd == null && well.tdMd == null) {
      return { text: "Opsional. Label akhir diletakkan pada TVD ini.", warn: false };
    }
    if (well.tdTvd == null) return { text: "Isi TVD agar akhir sumur tergambar.", warn: true };
    return { text: "Label akhir diletakkan pada TVD ini.", warn: false };
  }

  function wellSummary(well) {
    const name = (well.name || "").trim() || "Tanpa nama";
    const td = well.tdTvd != null ? `TD ${fmt(well.tdTvd)} ${state.unit}` : "TD belum diisi";
    const liners = well.casings.filter((casing) => isLiner(casing)).length;
    const casings = well.casings.length - liners;
    const count = liners ? `${casings} casing · ${liners} liner` : `${casings} casing`;
    return `${name} · ${count} · ${td}`;
  }

  function validFormations() {
    return state.formations.filter((fm) => fm.topTvd != null && fm.baseTvd != null && fm.baseTvd > fm.topTvd);
  }

  function crisp(value) {
    return Math.round(value) + 0.5;
  }

  function scene() {
    const formations = validFormations()
      .map((fm) => ({ name: (fm.name || "").trim(), color: fm.color || "#7A3412", top: fm.topTvd, base: fm.baseTvd }))
      .sort((a, b) => a.top - b.top || a.base - b.base);
    const wells = state.wells.map((well) => ({
      name: (well.name || "").trim() || "Sumur",
      tdTvd: well.tdTvd,
      items: well.casings.map((casing) => preparedCasing(casing, well)).filter(Boolean).sort((a, b) => a.shoeTvd - b.shoeTvd || a.shoeMd - b.shoeMd),
      tdText: tdLines(well)
    }));
    const drawable = formations.length || wells.some((well) => well.items.length || well.tdTvd != null);
    if (!drawable) {
      return { empty: true, w: 760, h: 420 };
    }

    const tvdMax = domainMax();
    const title = (state.title || "").trim();
    const marginL = 18;
    const marginR = 22;
    const marginT = 16;
    const titleH = title ? 34 : 0;
    const plotTop = marginT + titleH + 36;
    const plotH = Math.max(640, Math.min(980, Math.round(tvdMax * 0.12)));
    const plotBottom = plotTop + plotH;
    const yPad = 16;
    const yOf = (tvd) => plotTop + yPad + (Math.max(0, tvd) / tvdMax) * (plotH - yPad);

    const step = niceStep(tvdMax);
    const ticks = [];
    const count = Math.round(tvdMax / step);
    for (let i = 0; i <= count; i += 1) ticks.push(Math.round(i * step * 1000) / 1000);
    if (!ticks.length || Math.abs(ticks[ticks.length - 1] - tvdMax) > step * 0.2) ticks.push(tvdMax);

    let axisText = 0;
    ticks.forEach((tvd) => {
      axisText = Math.max(axisText, textWidth(FONT, `${fmt(tvd)} ${state.unit}`));
    });
    const axisW = Math.ceil(axisText) + 24;
    const axisRight = marginL + axisW;

    let colorX = 0;
    let nameX = 0;
    let nameW = 0;
    if (formations.length) {
      nameW = 88;
      formations.forEach((fm) => {
        nameW = Math.max(nameW, textWidth(FONT, fm.name) + 18);
      });
      nameW = Math.min(240, nameW);
      colorX = axisRight + 14;
      nameX = colorX + 38;
    }
    let cursorX = formations.length ? nameX + nameW + 30 : axisRight + 28;

    const pitch = 8;
    const builtWells = wells.map((well) => {
      const count = Math.max(well.items.length, 1);
      const stickLeft = cursorX + 8;
      const stickRight = stickLeft + (count - 1) * pitch;
      const ranked = well.items.slice().sort((a, b) => b.shoeTvd - a.shoeTvd || b.shoeMd - a.shoeMd);
      const placed = well.items.map((item) => {
        const index = Math.max(0, ranked.indexOf(item));
        const x = stickLeft + index * pitch;
        return {
          ...item,
          x,
          yTop: yOf(item.topTvd),
          yShoe: yOf(item.shoeTvd),
          anchorX: x + (item.style === "openhole" ? 6 : 22)
        };
      });
      const deepest = placed.reduce((best, item) => (best == null || item.shoeTvd > best.shoeTvd ? item : best), null);
      let openHole = null;
      if (deepest && well.tdTvd != null && well.tdTvd > deepest.shoeTvd + 0.5) {
        openHole = { x: deepest.x, y1: deepest.yShoe, y2: yOf(well.tdTvd) };
      } else if (!placed.length && well.tdTvd != null) {
        openHole = { x: stickLeft, y1: yOf(0), y2: yOf(well.tdTvd) };
      }

      const labelPacks = [];
      placed.forEach((item) => {
        if (item.topGiven) {
          labelPacks.push({ lines: topLines(item), y: item.yTop, rank: 0, anchorX: item.anchorX, tol: true });
        }
        labelPacks.push({ lines: casingLines(item), y: item.yShoe, rank: 1, anchorX: item.anchorX });
      });
      if (well.tdText) {
        const anchorX = openHole ? openHole.x + 6 : (deepest ? deepest.anchorX : stickLeft + 6);
        labelPacks.push({ lines: well.tdText, y: yOf(well.tdTvd), rank: 1, anchorX });
      }
      labelPacks.sort((a, b) => a.y - b.y || a.rank - b.rank);
      const labelGap = 8;
      const tolGap = 26;
      let labelCursor = plotTop + 2;
      labelPacks.forEach((pack) => {
        const height = pack.lines.length * LINE_H;
        let top = pack.y - height / 2;
        if (top < labelCursor) top = labelCursor;
        pack.top = top;
        pack.h = height;
        labelCursor = top + height + labelGap;
      });
      for (let i = 0; i < labelPacks.length - 1; i += 1) {
        const pack = labelPacks[i];
        if (!pack.tol) continue;
        const next = labelPacks[i + 1];
        const gap = next.top - (pack.top + pack.h);
        if (gap >= tolGap) continue;
        const need = tolGap - gap;
        const floor = i === 0 ? plotTop + 2 : labelPacks[i - 1].top + labelPacks[i - 1].h + labelGap;
        const lift = Math.min(need * 0.5, Math.max(0, pack.top - floor));
        pack.top -= lift;
        const push = need - lift;
        for (let j = i + 1; j < labelPacks.length; j += 1) labelPacks[j].top += push;
      }

      let textW = textWidth(FONT_WELL, well.name);
      labelPacks.forEach((pack) => {
        textW = Math.max(textW, blockWidth(pack.lines));
      });
      textW = Math.ceil(textW) + 4;
      const labelX = stickRight + 32;
      const width = Math.max(180, (labelX - cursorX) + textW + 18);
      const column = {
        name: well.name,
        x: cursorX,
        w: width,
        labelX,
        items: placed,
        labels: labelPacks.map((pack) => ({
          x: labelX,
          top: pack.top,
          y: pack.y,
          h: pack.h,
          lines: pack.lines,
          anchorX: pack.anchorX
        })),
        openHole
      };
      cursorX += width;
      return column;
    });

    let lowest = plotBottom;
    builtWells.forEach((well) => {
      well.labels.forEach((label) => {
        lowest = Math.max(lowest, label.top + label.h);
      });
    });
    const titleW = title ? textWidth(FONT_TITLE, title) + 48 : 0;
    const width = Math.max(cursorX + marginR, titleW, 640);
    const height = Math.ceil(lowest + 28);

    return {
      empty: false,
      w: width,
      h: height,
      title,
      tvdMax,
      plotTop,
      plotBottom,
      axisRight,
      ticks,
      yOf,
      formations: formations.map((fm) => ({
        name: fm.name,
        color: fm.color,
        y1: yOf(fm.top),
        y2: yOf(fm.base)
      })),
      formationHeader: formations.length ? { x: colorX + (38 + nameW) / 2 } : null,
      colorX,
      colorW: 30,
      nameX,
      wells: builtWells
    };
  }

  function paint(ctx, figure) {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, figure.w, figure.h);
    if (figure.empty) {
      ctx.fillStyle = "#655e54";
      ctx.font = "16px Arial, Helvetica, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("Isi formasi atau shoe casing untuk melihat gambar.", figure.w / 2, figure.h / 2);
      return;
    }

    if (figure.title) {
      ctx.fillStyle = "#1c1915";
      ctx.font = FONT_TITLE;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(figure.title, figure.w / 2, 16 + 12);
    }

    ctx.fillStyle = "#1c1915";
    ctx.font = FONT_WELL;
    ctx.textAlign = "right";
    ctx.textBaseline = "bottom";
    ctx.fillText("TVD", figure.axisRight - 2, figure.plotTop - 10);
    if (figure.formationHeader) {
      ctx.textAlign = "center";
      ctx.fillText("Formasi", figure.formationHeader.x, figure.plotTop - 10);
    }
    figure.wells.forEach((well) => {
      ctx.textAlign = "center";
      ctx.fillText(well.name, well.x + well.w / 2, figure.plotTop - 10);
    });

    ctx.strokeStyle = "#222222";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(crisp(figure.axisRight), figure.plotTop);
    ctx.lineTo(crisp(figure.axisRight), figure.plotBottom);
    ctx.stroke();
    ctx.font = FONT;
    ctx.fillStyle = "#222222";
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    figure.ticks.forEach((tvd) => {
      const y = figure.yOf(tvd);
      ctx.beginPath();
      ctx.moveTo(figure.axisRight - 7, crisp(y));
      ctx.lineTo(figure.axisRight, crisp(y));
      ctx.stroke();
      ctx.fillText(`${fmt(tvd)} ${state.unit}`, figure.axisRight - 12, y);
    });

    figure.formations.forEach((fm) => {
      const height = Math.max(1, fm.y2 - fm.y1);
      ctx.fillStyle = fm.color;
      ctx.fillRect(figure.colorX, fm.y1, figure.colorW, height);
      ctx.strokeStyle = "rgba(0,0,0,0.2)";
      ctx.strokeRect(figure.colorX + 0.5, fm.y1 + 0.5, figure.colorW - 1, Math.max(1, height - 1));
      if (fm.name && height >= 14) {
        ctx.fillStyle = "#1c1915";
        ctx.font = FONT;
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        ctx.fillText(fm.name, figure.nameX, (fm.y1 + fm.y2) / 2);
      }
    });

    figure.wells.forEach((well) => {
      const hosts = new Map();
      well.items.forEach((item) => {
        if (!item.liner) return;
        const host = well.items
          .filter((other) => other !== item && other.x > item.x + 0.5)
          .sort((a, b) => a.x - b.x)[0];
        if (host) hosts.set(item, host);
      });
      well.items.forEach((item) => drawString(ctx, item, hosts.get(item)));
      if (well.openHole) drawOpenHole(ctx, well.openHole);
      well.labels.forEach((label) => {
        const shift = Math.abs((label.top + label.h / 2) - label.y);
        if (shift > 22) {
          ctx.strokeStyle = "#b7b1a6";
          ctx.lineWidth = 1;
          ctx.setLineDash([2, 2]);
          ctx.beginPath();
          ctx.moveTo(label.anchorX, crisp(label.y));
          ctx.lineTo(label.x - 4, crisp(label.top + 7));
          ctx.stroke();
          ctx.setLineDash([]);
        }
        label.lines.forEach((line, index) => {
          ctx.fillStyle = "#1c1915";
          ctx.font = index === 0 ? FONT_BOLD : FONT;
          ctx.textAlign = "left";
          ctx.textBaseline = "top";
          ctx.fillText(line, label.x, label.top + index * LINE_H);
        });
      });
    });
  }

  function drawString(ctx, item, host) {
    ctx.save();
    ctx.strokeStyle = "#111111";
    ctx.fillStyle = "#111111";
    ctx.lineWidth = PIPE;
    ctx.lineCap = "butt";
    const x = Math.round(item.x);
    const y1 = Math.round(item.yTop);
    const y2 = Math.round(item.yShoe);
    const left = x - PIPE / 2;
    const pipeTop = item.liner ? y1 + HANG_H - 1 : y1;
    if (item.style === "openhole") {
      ctx.setLineDash(dashFor(item.style));
      ctx.beginPath();
      ctx.moveTo(x, pipeTop);
      ctx.lineTo(x, y2);
      ctx.stroke();
      ctx.setLineDash([]);
    } else if (item.style === "perforated") {
      ctx.setLineDash(dashFor(item.style));
      ctx.beginPath();
      ctx.moveTo(x, pipeTop);
      ctx.lineTo(x, y2 - SHOE + 2);
      ctx.stroke();
      ctx.setLineDash([]);
    } else if (y2 > pipeTop) {
      ctx.fillRect(left, pipeTop, PIPE, y2 - pipeTop);
    }
    if (item.liner) drawHanger(ctx, left, y1, host);
    if (item.style === "openhole") {
      ctx.beginPath();
      ctx.arc(x, y2, 2.4, 0, Math.PI * 2);
      ctx.fill();
    } else {
      drawShoe(ctx, left, y2 - SHOE, y2);
    }
    ctx.restore();
  }

  function drawHanger(ctx, left, top, host) {
    const x0 = left - HANG_LEFT;
    let right = left + PIPE + HANG_RIGHT;
    if (host) right = Math.round(host.x) + PIPE / 2;
    ctx.fillRect(x0, top, Math.max(PIPE + HANG_LEFT, right - x0), HANG_H);
  }

  function drawShoe(ctx, left, top, bottom) {
    const pipeRight = left + PIPE;
    ctx.beginPath();
    ctx.moveTo(left, top);
    ctx.lineTo(pipeRight, top);
    ctx.lineTo(pipeRight + SHOE, bottom);
    ctx.lineTo(left, bottom);
    ctx.closePath();
    ctx.fill();
  }

  function drawOpenHole(ctx, hole) {
    ctx.save();
    ctx.strokeStyle = "#111111";
    ctx.fillStyle = "#111111";
    ctx.lineWidth = 2.8;
    ctx.lineCap = "butt";
    ctx.setLineDash(dashFor("openhole"));
    const x = Math.round(hole.x);
    const yStart = Math.round(hole.y1);
    const yEnd = Math.round(hole.y2);
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

  function dashFor(style) {
    if (style === "openhole") return [14, 8];
    if (style === "perforated") return [7, 6];
    return [];
  }

  function renderCanvas(canvas, scale) {
    const figure = scene();
    canvas.width = Math.max(1, Math.round(figure.w * scale));
    canvas.height = Math.max(1, Math.round(figure.h * scale));
    const ctx = canvas.getContext("2d");
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, figure.w, figure.h);
    paint(ctx, figure);
    return figure;
  }

  function setStatus(text) {
    const el = document.getElementById("csg-status");
    if (el) el.textContent = text || "";
  }

  function updateScaleNote() {
    const el = document.getElementById("csg-max-hint");
    if (!el) return;
    const data = dataMax();
    if (state.tvdMax != null && state.tvdMax > 0 && data > state.tvdMax) {
      el.textContent = `Skala diperlebar agar ${fmt(data)} ${state.unit} tetap masuk.`;
      return;
    }
    el.textContent = "Skala kosong mengikuti data terdalam. Teks akhir muncul di kedalaman TD.";
  }

  function fittedWidth(sheet) {
    if (!sheet || !lastScene) return 0;
    const available = sheet.clientWidth - 24;
    if (available < 80) return 0;
    return Math.min(lastScene.w, available);
  }

  function updateZoomUi() {
    const label = document.getElementById("csg-zoom-label");
    if (label) label.textContent = `${Math.round(viewZoom * 100)}%`;
    const zoomOut = document.getElementById("csg-zoom-out");
    const zoomIn = document.getElementById("csg-zoom-in");
    if (zoomOut) zoomOut.disabled = viewZoom <= ZOOM_MIN + 0.001;
    if (zoomIn) zoomIn.disabled = viewZoom >= ZOOM_MAX - 0.001;
  }

  function applyZoom() {
    const canvas = document.getElementById("csg-chart");
    const sheet = document.getElementById("csg-sheet");
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
    const sheet = document.getElementById("csg-sheet");
    const canvas = document.getElementById("csg-chart");
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
    const canvas = document.getElementById("csg-chart");
    const sheet = document.getElementById("csg-sheet");
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
    const canvas = document.getElementById("csg-chart");
    if (!canvas) return;
    try {
      lastScene = renderCanvas(canvas, 2);
      applyZoom();
      updateScaleNote();
      const empty = !!lastScene.empty;
      ["csg-png", "csg-jpg", "csg-pdf"].forEach((id) => {
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
    const raw = (state.title || "casing-setting-depth").trim() || "casing-setting-depth";
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
    const buttons = ["csg-png", "csg-jpg", "csg-pdf"].map((id) => document.getElementById(id));
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
      title: state.title || "Casing Setting Depth",
      subject: "Casing setting depth"
    });
    pdf.save(`${fileStem()}.pdf`);
    setStatus("PDF berhasil diunduh.");
  }

  function numInput(field, value, placeholder) {
    return `<input data-field="${field}" type="text" inputmode="decimal" autocomplete="off" spellcheck="false" placeholder="${esc(placeholder || "")}" value="${esc(numToInput(value))}" />`;
  }

  function setHint(el, hint) {
    if (!el) return;
    el.textContent = hint.text || "";
    el.hidden = !hint.text;
    el.classList.toggle("warn", !!hint.warn);
  }

  function formationHtml(fm, index, total) {
    const hint = fmHint(fm);
    return `<div class="csg-fm" data-fm="${fm.id}">
      <div class="csg-item-top">
        <input data-field="name" type="text" spellcheck="false" autocomplete="off" placeholder="Nama formasi" value="${esc(fm.name)}" />
        <input data-field="color" type="color" value="${esc(fm.color || "#7A3412")}" aria-label="Warna formasi" />
        <div class="well-actions">
          <button type="button" data-action="fm-up" aria-label="Naik" ${index === 0 ? "disabled" : ""}>↑</button>
          <button type="button" data-action="fm-down" aria-label="Turun" ${index === total - 1 ? "disabled" : ""}>↓</button>
          <button type="button" data-action="fm-delete" aria-label="Hapus formasi">×</button>
        </div>
      </div>
      <div class="split">
        <label>TVD atas ${numInput("topTvd", fm.topTvd)}</label>
        <label>TVD bawah ${numInput("baseTvd", fm.baseTvd)}</label>
      </div>
      <p class="csg-hint${hint.warn ? " warn" : ""}" ${hint.text ? "" : "hidden"}>${esc(hint.text)}</p>
    </div>`;
  }

  function casingHtml(casing, index, total, well) {
    const hint = describeCasing(casing, well);
    const liner = isLiner(casing);
    return `<div class="csg-item" data-casing="${casing.id}">
      <div class="csg-item-top">
        <input data-field="name" type="text" spellcheck="false" autocomplete="off" placeholder="mis. 9-5/8 in Casing" value="${esc(casing.name)}" />
        <div class="well-actions">
          <button type="button" data-action="casing-up" aria-label="Naik" ${index === 0 ? "disabled" : ""}>↑</button>
          <button type="button" data-action="casing-down" aria-label="Turun" ${index === total - 1 ? "disabled" : ""}>↓</button>
          <button type="button" data-action="casing-delete" aria-label="Hapus rangkaian">×</button>
        </div>
      </div>
      <div class="csg-nums">
        <label>Shoe MD ${numInput("shoeMd", casing.shoeMd)}</label>
        <label>Shoe TVD ${numInput("shoeTvd", casing.shoeTvd)}</label>
      </div>
      <div class="csg-nums csg-choice">
        <label>Jenis
          <select data-field="kind">
            <option value="casing"${liner ? "" : " selected"}>Casing</option>
            <option value="liner"${liner ? " selected" : ""}>Liner</option>
          </select>
        </label>
        <label class="csg-style">Garis
          <select data-field="style">
            <option value="solid"${casing.style === "openhole" || casing.style === "perforated" ? "" : " selected"}>Biasa</option>
            <option value="openhole"${casing.style === "openhole" ? " selected" : ""}>Putus-putus, open hole</option>
            <option value="perforated"${casing.style === "perforated" ? " selected" : ""}>Putus-putus, liner perforated</option>
          </select>
        </label>
      </div>
      <label class="csg-top" ${liner ? "" : "hidden"}>Top of liner
        ${numInput("topTvd", casing.topTvd, "Otomatis, TVD")}
      </label>
      <p class="csg-hint${hint.warn ? " warn" : ""}">${esc(hint.text)}</p>
    </div>`;
  }

  function wellHtml(well, index, total) {
    const hint = tdHint(well);
    const casings = well.casings.length
      ? well.casings.map((casing, casingIndex) => casingHtml(casing, casingIndex, well.casings.length, well)).join("")
      : '<p class="micro">Belum ada rangkaian.</p>';
    return `<div class="csg-well-card" data-well="${well.id}">
      <details class="csg-well" data-well="${well.id}"${openWells.has(well.id) ? " open" : ""}>
      <summary><span data-summary>${esc(wellSummary(well))}</span></summary>
      <div class="csg-body">
        <label>Nama sumur
          <input data-field="wellName" type="text" spellcheck="false" autocomplete="off" value="${esc(well.name)}" />
        </label>
        <p class="micro csg-kicker">Kedalaman akhir (${esc(state.unit)})</p>
        <div class="split">
          <label>MD ${numInput("tdMd", well.tdMd)}</label>
          <label>TVD ${numInput("tdTvd", well.tdTvd)}</label>
        </div>
        <p class="csg-hint td-hint${hint.warn ? " warn" : ""}" ${hint.text ? "" : "hidden"}>${esc(hint.text)}</p>
        <p class="micro csg-kicker">Rangkaian</p>
        ${casings}
        <div class="row-actions csg-well-nav">
          <button type="button" class="btn ghost" data-action="well-up" ${index === 0 ? "disabled" : ""}>Naik</button>
          <button type="button" class="btn ghost" data-action="well-down" ${index === total - 1 ? "disabled" : ""}>Turun</button>
          <button type="button" class="btn ghost" data-action="well-delete">Hapus sumur</button>
        </div>
      </div>
      </details>
      <div class="csg-add">
        <button type="button" class="btn ghost" data-action="add-casing">Tambah casing</button>
        <button type="button" class="btn ghost" data-action="add-liner">Tambah liner</button>
      </div>
    </div>`;
  }

  function renderFormations() {
    const count = document.getElementById("csg-fm-count");
    const host = document.getElementById("csg-formations");
    if (count) {
      count.textContent = state.formations.length ? `· ${state.formations.length} lapisan` : "· tidak ada";
    }
    if (!host) return;
    host.innerHTML = state.formations.length
      ? state.formations.map((fm, index) => formationHtml(fm, index, state.formations.length)).join("")
      : '<p class="micro empty">Belum ada formasi. Kolom kiri disembunyikan.</p>';
  }

  function renderWells() {
    const host = document.getElementById("csg-wells");
    if (!host) return;
    host.innerHTML = state.wells.length
      ? state.wells.map((well, index) => wellHtml(well, index, state.wells.length)).join("")
      : '<p class="micro empty">Belum ada sumur.</p>';
  }

  function focusPending() {
    if (!focusAfter) return;
    const target = focusAfter;
    focusAfter = null;
    let root = null;
    if (target.fm) root = document.querySelector(`[data-fm="${target.fm}"]`);
    else if (target.casing) root = document.querySelector(`[data-casing="${target.casing}"]`);
    else if (target.well) root = document.querySelector(`[data-well="${target.well}"]`);
    const input = root && root.querySelector(`[data-field="${target.field}"]`);
    if (input) input.focus();
  }

  function panelScroll(top) {
    const panel = document.querySelector("#panel-casing .panel");
    if (!panel) return 0;
    if (top == null) return panel.scrollTop;
    panel.scrollTop = top;
    return top;
  }

  function refreshSummary(wellEl, well) {
    const el = wellEl.querySelector("[data-summary]");
    if (el) el.textContent = wellSummary(well);
  }

  function applyValue(obj, field, input) {
    if (field === "name" || field === "wellName" || field === "color" || field === "style" || field === "kind") {
      if (field === "style") obj.style = lineKind(input.value);
      else if (field === "kind") obj.kind = input.value === "liner" ? "liner" : "casing";
      else obj[field === "wellName" ? "name" : field] = input.value;
      input.classList.remove("bad");
      return;
    }
    const raw = input.value.trim();
    if (!raw) {
      obj[field] = null;
      input.classList.remove("bad");
      return;
    }
    const n = parseNum(raw);
    if (Number.isNaN(n)) {
      input.classList.add("bad");
      return;
    }
    obj[field] = n;
    input.classList.remove("bad");
  }

  function onField(event) {
    const input = event.target;
    const field = input.dataset ? input.dataset.field : "";
    if (!field) return;
    const fmEl = input.closest("[data-fm]");
    const wellEl = input.closest("[data-well]");
    if (fmEl) {
      const fm = state.formations.find((item) => item.id === fmEl.dataset.fm);
      if (!fm) return;
      applyValue(fm, field, input);
      setHint(fmEl.querySelector(".csg-hint"), fmHint(fm));
    } else if (wellEl) {
      const well = state.wells.find((item) => item.id === wellEl.dataset.well);
      if (!well) return;
      const casingEl = input.closest("[data-casing]");
      if (casingEl) {
        const casing = well.casings.find((item) => item.id === casingEl.dataset.casing);
        if (!casing) return;
        applyValue(casing, field, input);
        refreshCasingHints(wellEl, well);
      } else {
        applyValue(well, field, input);
        refreshSummary(wellEl, well);
        setHint(wellEl.querySelector(".td-hint"), tdHint(well));
      }
    }
    persist();
    requestDraw();
  }

  function swap(list, from, to) {
    const item = list[from];
    list[from] = list[to];
    list[to] = item;
  }

  function onClick(event) {
    const button = event.target.closest("button");
    if (!button || button.disabled) return;
    const action = button.dataset.action;
    if (!action) return;
    const fmEl = button.closest("[data-fm]");
    if (fmEl && action.indexOf("fm-") === 0) {
      const index = state.formations.findIndex((item) => item.id === fmEl.dataset.fm);
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
      return;
    }
    const wellEl = button.closest("[data-well]");
    if (!wellEl) return;
    const wellIndex = state.wells.findIndex((item) => item.id === wellEl.dataset.well);
    const well = state.wells[wellIndex];
    if (!well) return;
    const casingEl = button.closest("[data-casing]");
    if (action === "casing-delete" && casingEl) {
      well.casings = well.casings.filter((item) => item.id !== casingEl.dataset.casing);
    } else if ((action === "casing-up" || action === "casing-down") && casingEl) {
      const index = well.casings.findIndex((item) => item.id === casingEl.dataset.casing);
      const target = index + (action === "casing-up" ? -1 : 1);
      if (index < 0 || target < 0 || target >= well.casings.length) return;
      swap(well.casings, index, target);
    } else if (action === "add-casing" || action === "add-liner") {
      const created = blankCasing(action === "add-liner" ? "liner" : "casing");
      well.casings.push(created);
      openWells.add(well.id);
      focusAfter = { casing: created.id, field: "name" };
    } else if (action === "well-delete") {
      state.wells.splice(wellIndex, 1);
      openWells.delete(well.id);
    } else if (action === "well-up" || action === "well-down") {
      const target = wellIndex + (action === "well-up" ? -1 : 1);
      if (target < 0 || target >= state.wells.length) return;
      swap(state.wells, wellIndex, target);
    } else return;
    const top = panelScroll();
    persist();
    renderWells();
    panelScroll(top);
    focusPending();
    requestDraw();
  }

  function refreshCasingHints(wellEl, well) {
    well.casings.forEach((casing) => {
      const el = wellEl.querySelector(`[data-casing="${casing.id}"]`);
      if (!el) return;
      setHint(el.querySelector(".csg-hint"), describeCasing(casing, well));
      const top = el.querySelector(".csg-top");
      if (top) top.hidden = !isLiner(casing);
    });
  }

  function blankCasing(kind) {
    return {
      id: uid(),
      name: "",
      shoeMd: null,
      shoeTvd: null,
      kind: kind === "liner" ? "liner" : "casing",
      topTvd: null,
      style: "solid"
    };
  }

  function blankWell(index) {
    return { id: uid(), name: `Sumur ${index}`, tdMd: null, tdTvd: null, casings: [blankCasing()] };
  }

  function blankFormation() {
    return {
      id: uid(),
      name: "",
      topTvd: null,
      baseTvd: null,
      color: FM_COLORS[state.formations.length % FM_COLORS.length]
    };
  }

  function pipe(name, shoeMd, shoeTvd, kind) {
    return { id: uid(), name, shoeMd, shoeTvd, kind: kind === "liner" ? "liner" : "casing", topTvd: null, style: "solid" };
  }

  function makeWell(name, tdMd, tdTvd, casings) {
    return { id: uid(), name, tdMd, tdTvd, casings };
  }

  function layer(name, topTvd, baseTvd, color) {
    return { id: uid(), name, topTvd, baseTvd, color };
  }

  function sampleData() {
    return {
      title: "",
      unit: "ft",
      decimalComma: true,
      tvdMax: 7000,
      endLabel: "End of Well",
      formations: [
        layer("Pre Parigi", 0, 1450, "#7A3412"),
        layer("Parigi Top", 1450, 1850, "#2F9E3A"),
        layer("Main Fm", 1850, 2450, "#3F3F3F"),
        layer("Massive Fm", 2450, 3200, "#E4F5D6"),
        layer("Baturaja Stringers", 3200, 3900, "#00D0E6"),
        layer("Baturaja Massive Fm", 3900, 4700, "#0E3A48"),
        layer("BRF Base", 4700, 6100, "#1A73C9"),
        layer("NMTA Fm", 6100, 7000, "#F0B429")
      ],
      wells: [
        makeWell("OOA-1", 7739, 6953.25, [
          pipe('30" Conductor', 165.44, 165.44),
          pipe('18-5/8" Casing', 1719, 1712.88),
          pipe('13-3/8" Casing', 4209, 3846.28),
          pipe('9-5/8" Casing', 6281, 5661.63),
          pipe('7" Liner', 7729, 6944, "liner")
        ]),
        makeWell("OOA-2ST2", 11129, 6767.37, [
          pipe('30" Conductor', 444, 443.97),
          pipe('18-5/8" Casing', 1782, 1695.19),
          pipe('13-3/8" Casing', 3024, 2773.25),
          pipe('9-5/8" Casing', 6675, 4370.95),
          pipe('7" Liner', 8517, 5382.45, "liner")
        ]),
        makeWell("OOA-3", 10309, 6828.22, [
          pipe('30" Conductor', 444, 443.97),
          pipe('18-5/8" Casing', 1667, 1666.77),
          pipe('13-3/8" Casing', 4373, 3856.83),
          pipe('9-5/8" Casing', 8020, 5698.47)
        ]),
        makeWell("OOA-4", 3717, 3098.05, [
          pipe('30" Conductor', 444, 443.99),
          pipe('13-3/8" Casing', 1778, 1681.14),
          pipe('9-5/8" Casing', 4507, 2726.56)
        ]),
        makeWell("OOA-5", null, null, [])
      ]
    };
  }

  function applyData(data) {
    state.title = data.title || "";
    state.unit = data.unit === "m" ? "m" : "ft";
    state.decimalComma = data.decimalComma !== false;
    state.tvdMax = data.tvdMax == null ? null : Number(data.tvdMax);
    state.endLabel = data.endLabel || "End of Well";
    state.formations = data.formations || [];
    state.wells = data.wells || [];
  }

  function applyChrome() {
    const title = document.getElementById("csg-title");
    const unit = document.getElementById("csg-unit");
    const decimal = document.getElementById("csg-decimal");
    const max = document.getElementById("csg-max");
    const endLabel = document.getElementById("csg-end-label");
    if (title) title.value = state.title;
    if (unit) unit.value = state.unit;
    if (decimal) decimal.value = state.decimalComma ? "comma" : "dot";
    if (max) max.value = numToInput(state.tvdMax);
    if (endLabel) endLabel.value = state.endLabel;
  }

  function persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        title: state.title,
        unit: state.unit,
        decimalComma: state.decimalComma,
        tvdMax: state.tvdMax,
        endLabel: state.endLabel,
        formations: state.formations,
        wells: state.wells
      }));
    } catch (err) { /* storage unavailable */ }
  }

  function numberOrNull(value) {
    if (value == null || value === "") return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  function casingKind(raw) {
    if (raw.kind === "liner" || raw.kind === "casing") return raw.kind;
    const lengthMd = numberOrNull(raw.lengthMd);
    const shoeMd = numberOrNull(raw.shoeMd);
    if (lengthMd != null && shoeMd != null && lengthMd > 0 && lengthMd < shoeMd - 0.05) return "liner";
    return "casing";
  }

  function normalizeCasing(raw) {
    return {
      id: raw.id || uid(),
      name: raw.name || "",
      shoeMd: numberOrNull(raw.shoeMd),
      shoeTvd: numberOrNull(raw.shoeTvd),
      kind: casingKind(raw),
      topTvd: numberOrNull(raw.topTvd),
      style: lineKind(raw.style)
    };
  }

  function ingest(data) {
    if (!data || !Array.isArray(data.wells) || !Array.isArray(data.formations)) return false;
    applyData({
      title: data.title || "",
      unit: data.unit,
      decimalComma: data.decimalComma,
      tvdMax: data.tvdMax == null ? null : numberOrNull(data.tvdMax),
      endLabel: data.endLabel || "End of Well",
      formations: data.formations.map((fm) => ({
        id: fm.id || uid(),
        name: fm.name || "",
        topTvd: numberOrNull(fm.topTvd),
        baseTvd: numberOrNull(fm.baseTvd),
        color: fm.color || "#7A3412"
      })),
      wells: data.wells.map((well) => ({
        id: well.id || uid(),
        name: well.name || "",
        tdMd: numberOrNull(well.tdMd),
        tdTvd: numberOrNull(well.tdTvd),
        casings: Array.isArray(well.casings) ? well.casings.map(normalizeCasing) : []
      }))
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
      unit: state.unit,
      decimalComma: state.decimalComma,
      tvdMax: state.tvdMax,
      endLabel: state.endLabel,
      formations: state.formations,
      wells: state.wells
    };
  }

  function loadProject(data) {
    if (!ingest(data)) return false;
    applyChrome();
    renderFormations();
    renderWells();
    persist();
    requestDraw();
    return true;
  }

  function loadSample() {
    openWells.clear();
    applyData(sampleData());
    applyChrome();
    const fold = document.getElementById("csg-fm-fold");
    if (fold) fold.open = false;
    persist();
    renderFormations();
    renderWells();
    requestDraw();
    setStatus("Contoh dimuat. Batas formasi pada contoh hanya untuk tampilan, bukan data resmi.");
  }

  function clearAll() {
    state.formations = [];
    state.wells = [];
    openWells.clear();
    const fold = document.getElementById("csg-fm-fold");
    if (fold) fold.open = true;
    persist();
    renderFormations();
    renderWells();
    requestDraw();
    setStatus("Sumur dan formasi dikosongkan.");
  }

  function activate(tab) {
    const names = {
      azimuth: { panel: "panel-azimuth", actions: "actions-azimuth", tab: "tab-azimuth", title: "Chart Azimuth & Inklinasi" },
      casing: { panel: "panel-casing", actions: "actions-casing", tab: "tab-casing", title: "Casing Setting Depth" },
      drilling: { panel: "panel-drilling", actions: "actions-drilling", tab: "tab-drilling", title: "Drilling Summary" }
    };
    const active = names[tab] ? tab : "azimuth";
    Object.keys(names).forEach((key) => {
      const item = names[key];
      const on = key === active;
      const panel = document.getElementById(item.panel);
      const actions = document.getElementById(item.actions);
      const button = document.getElementById(item.tab);
      if (panel) panel.hidden = !on;
      if (actions) actions.hidden = !on;
      if (button) button.setAttribute("aria-selected", on ? "true" : "false");
    });
    const title = document.getElementById("app-title");
    if (title) title.textContent = names[active].title;
    try { localStorage.setItem(TAB_KEY, active); } catch (err) { /* storage unavailable */ }
    if (active === "casing") draw();
    else if (active === "drilling" && window.DrillingSummary) window.DrillingSummary.draw();
    else requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
  }

  function bind() {
    document.getElementById("tab-azimuth").addEventListener("click", () => activate("azimuth"));
    document.getElementById("tab-casing").addEventListener("click", () => activate("casing"));
    document.getElementById("tab-drilling").addEventListener("click", () => activate("drilling"));
    document.getElementById("csg-formations").addEventListener("input", onField);
    document.getElementById("csg-formations").addEventListener("click", onClick);
    document.getElementById("csg-wells").addEventListener("input", onField);
    document.getElementById("csg-wells").addEventListener("change", onField);
    document.getElementById("csg-wells").addEventListener("click", onClick);
    document.getElementById("csg-wells").addEventListener("toggle", (event) => {
      const el = event.target;
      if (!el.classList || !el.classList.contains("csg-well")) return;
      if (el.open) openWells.add(el.dataset.well);
      else openWells.delete(el.dataset.well);
    }, true);

    document.getElementById("csg-add-fm").addEventListener("click", () => {
      const created = blankFormation();
      state.formations.push(created);
      focusAfter = { fm: created.id, field: "name" };
      const fold = document.getElementById("csg-fm-fold");
      if (fold) fold.open = true;
      persist();
      renderFormations();
      focusPending();
      requestDraw();
    });
    document.getElementById("csg-add-well").addEventListener("click", () => {
      const created = blankWell(state.wells.length + 1);
      state.wells.push(created);
      openWells.add(created.id);
      focusAfter = { well: created.id, field: "wellName" };
      persist();
      renderWells();
      focusPending();
      requestDraw();
    });
    document.getElementById("csg-sample").addEventListener("click", loadSample);
    document.getElementById("csg-clear").addEventListener("click", clearAll);

    document.getElementById("csg-title").addEventListener("input", (event) => {
      state.title = event.target.value;
      persist();
      requestDraw();
    });
    document.getElementById("csg-unit").addEventListener("change", (event) => {
      state.unit = event.target.value === "m" ? "m" : "ft";
      const top = panelScroll();
      persist();
      renderWells();
      panelScroll(top);
      requestDraw();
    });
    document.getElementById("csg-decimal").addEventListener("change", (event) => {
      state.decimalComma = event.target.value === "comma";
      const top = panelScroll();
      applyChrome();
      persist();
      renderFormations();
      renderWells();
      panelScroll(top);
      requestDraw();
    });
    document.getElementById("csg-max").addEventListener("input", (event) => {
      const raw = event.target.value.trim();
      if (!raw) {
        state.tvdMax = null;
        event.target.classList.remove("bad");
      } else {
        const n = parseNum(raw);
        if (Number.isNaN(n) || n <= 0) event.target.classList.add("bad");
        else {
          state.tvdMax = n;
          event.target.classList.remove("bad");
        }
      }
      persist();
      requestDraw();
    });
    document.getElementById("csg-end-label").addEventListener("input", (event) => {
      state.endLabel = event.target.value;
      persist();
      requestDraw();
    });
    document.getElementById("csg-png").addEventListener("click", () => exportImage("png"));
    document.getElementById("csg-jpg").addEventListener("click", () => exportImage("jpg"));
    document.getElementById("csg-pdf").addEventListener("click", () => exportImage("pdf"));
    document.getElementById("csg-zoom-in").addEventListener("click", () => setViewZoom(viewZoom + ZOOM_STEP));
    document.getElementById("csg-zoom-out").addEventListener("click", () => setViewZoom(viewZoom - ZOOM_STEP));
    document.getElementById("csg-zoom-fit").addEventListener("click", () => setViewZoom(1));
    bindChartView();
    const sheet = document.getElementById("csg-sheet");
    if (typeof ResizeObserver !== "undefined" && sheet) {
      const observer = new ResizeObserver(() => {
        const panel = document.getElementById("panel-casing");
        if (panel && !panel.hidden) applyZoom();
      });
      observer.observe(sheet);
    }
  }

  function init() {
    const restored = loadStored();
    if (!restored) loadSample();
    else {
      applyChrome();
      renderFormations();
      renderWells();
      requestDraw();
      setStatus("Data casing terakhir dibuka kembali.");
    }
    bind();
    let tab = "azimuth";
    try {
      const stored = localStorage.getItem(TAB_KEY);
      if (stored === "casing" || stored === "drilling") tab = stored;
    } catch (err) { tab = "azimuth"; }
    activate(tab);
  }

  function publishedWells() {
    return state.wells.map((well) => ({
      id: well.id,
      name: well.name || "",
      tdMd: well.tdMd,
      tdTvd: well.tdTvd,
      casings: (well.casings || []).map((casing) => ({
        id: casing.id,
        name: casing.name || "",
        shoeMd: casing.shoeMd,
        shoeTvd: casing.shoeTvd,
        kind: casing.kind,
        topTvd: casing.topTvd,
        style: casing.style
      }))
    }));
  }

  window.CasingSetting = {
    draw,
    activate,
    snapshot,
    load: loadProject,
    wells: publishedWells,
    meta() {
      return { unit: state.unit === "m" ? "m" : "ft", endLabel: (state.endLabel || "").trim() || "End of Well" };
    }
  };

  document.addEventListener("DOMContentLoaded", init);
})();
