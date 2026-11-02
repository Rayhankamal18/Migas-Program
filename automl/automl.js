(function () {
  const state = {
    step: 1,
    uploadId: null,
    sourceName: null,
    columns: [],
    rows: 0,
    cols: 0,
    head: [],
    tail: [],
    target: "",
    features: [],
    task: "regression",
    taskReason: "",
    taskManual: false, // user overrode auto suggestion
    forceClassification: false,
    testSize: 0.2,
    randomState: 42,
    splitMode: "auto", // auto = acak dari langkah 1 | files = CSV train & test terpisah
    trainUploadId: null,
    testUploadId: null,
    trainFileName: null,
    testFileName: null,
    trainMeta: null, // {rows, cols}
    testMeta: null,
    timeout: 300,
    // Stable defaults for tabular AutoML (tree models work for clf + reg)
    models: ["LightGBM", "CatBoost", "RandomForest"],
    jobId: null,
    result: null,
    pollTimer: null,
    uploadList: [],
    pendingFile: null,
    // predict
    predRows: [], // array of objects
    predResults: null,
    predIncludeProba: false,
  };

  function apiBase() {
    const stored = (localStorage.getItem("migas-api-base") || "").trim().replace(/\/$/, "");
    if (stored) return stored;
    if (typeof location !== "undefined" && location.protocol && location.protocol !== "file:") {
      return location.origin;
    }
    // Local portable default when opened as file:// after Start_Migas.bat
    return "http://127.0.0.1:5055";
  }
  function headers(json) {
    const h = {};
    if (json) h["Content-Type"] = "application/json";
    const t = localStorage.getItem("migas-api-token") || "";
    if (t) h["X-Migas-Token"] = t;
    return h;
  }
  function setStatus(t) {
    const el = document.getElementById("automl-status");
    if (el) el.textContent = t || "";
  }
  function summary() {
    const el = document.getElementById("automl-summary-text");
    if (!el) return;
    if (state.result && state.result.model_file && !state.uploadId) {
      el.innerHTML =
        "Mode: <b>model tersimpan</b><br/>" +
        "Model: <b>" + state.result.model_file + "</b><br/>" +
        "Target (Y): <b>" + (state.result.target || state.target || "—") + "</b><br/>" +
        "Inputs (X): <b>" + ((state.result.features && state.result.features.length) || state.features.length || 0) + "</b><br/>" +
        "Task: <b>" + (state.result.task || state.task || "—") + "</b>";
      return;
    }
    if (!state.uploadId) {
      el.textContent = "Belum ada CSV. Punya model? Lompat ke langkah 7.";
      return;
    }
    const splitInfo =
      state.splitMode === "files"
        ? "Split: <b>CSV train/test</b><br/>" +
          "Train: <b>" +
          (state.trainFileName || state.trainUploadId || state.sourceName || "—") +
          "</b>" +
          (state.trainMeta ? " (" + state.trainMeta.rows + " baris)" : "") +
          "<br/>Test: <b>" +
          (state.testFileName || state.testUploadId || "—") +
          "</b>" +
          (state.testMeta ? " (" + state.testMeta.rows + " baris)" : "") +
          "<br/>"
        : "Split: <b>acak " + Math.round((state.testSize || 0.2) * 100) + "% test</b><br/>";
    el.innerHTML =
      "File: <b>" + (state.sourceName || state.uploadId) + "</b><br/>" +
      "Rows: <b>" + state.rows + "</b><br/>" +
      "Columns: <b>" + state.cols + "</b><br/>" +
      "Target (Y): <b>" + (state.target || "—") + "</b><br/>" +
      "Inputs (X): <b>" + (state.features.length || 0) + "</b><br/>" +
      "Task: <b>" + state.task + "</b><br/>" +
      splitInfo +
      "Timeout: <b>" + state.timeout + "s</b>" +
      (state.result && state.result.model_file
        ? "<br/>Model: <b>" + state.result.model_file + "</b>"
        : "");
  }

  function setStep(n) {
    state.step = Math.max(1, Math.min(8, n));
    document.querySelectorAll("#automl-step-list li").forEach((li) => {
      const s = Number(li.getAttribute("data-step"));
      li.classList.toggle("on", s === state.step);
      li.classList.toggle("done", s < state.step);
      // Langkah 7–8 selalu bisa diklik (model tersimpan / prediksi)
      const jumpable = s === 7 || s === 8 || s <= state.step || (state.result && state.result.model_file && s >= 7);
      li.classList.toggle("jumpable", !!jumpable);
      li.setAttribute("tabindex", jumpable ? "0" : "-1");
      li.setAttribute("role", "button");
    });
    const prog = document.getElementById("automl-progress");
    if (prog) prog.textContent = "Langkah " + state.step + " dari 8";
    render();
    summary();
  }

  async function loadModelForPredict(modelFile) {
    const base = apiBase();
    if (!base) throw new Error("API not available");
    const name = encodeURIComponent(modelFile);
    const res = await fetch(base + "/api/models/" + name, { headers: headers(false) });
    const data = await res.json();
    if (!data.ok && !data.model_file) throw new Error(data.error || "Could not load model");
    state.result = {
      model_file: data.model_file || modelFile,
      features: data.features || [],
      target: data.target || "",
      task: data.task || "regression",
      class_names: data.class_names || null,
      best_model_name: data.best_model_name || null,
      metric: data.metric || null,
      scores: data.scores || null,
      feature_schema: data.feature_schema || {},
      training_curve: data.training_curve || null,
    };
    state.target = state.result.target;
    state.features = (state.result.features || []).filter((f) => f !== state.target);
    state.task = state.result.task;
    // Mirror schema into columns so older UI helpers work without re-upload
    state.columns = (state.result.features || []).map(function (fname) {
      const sch = (state.result.feature_schema || {})[fname] || {};
      return {
        name: fname,
        type: sch.type === "categorical" ? "text" : "numeric",
        n_unique: sch.n_unique,
        samples: sch.categories || [],
        categories: sch.categories || [],
      };
    });
    state.predRows = [];
    state.predResults = null;
    setStatus("Model dimuat: " + state.result.model_file + " — lanjut prediksi tanpa latih ulang.");
    summary();
    return state.result;
  }

  /** Heuristic + schema lookup for predict/optimize inputs. */
  function featureInfo(name) {
    const schema = (state.result && state.result.feature_schema) || {};
    const sch = schema[name] || {};
    const col = (state.columns || []).find(function (c) { return c.name === name; }) || {};
    const nameL = String(name || "").toLowerCase().replace(/\s+/g, "_");
    const nameHint = /(^|_)(gender|sex|jenis.?kelamin|kategori|category|status|tipe|type|class|grade|zone|litho|formation|fluid|fase|phase|flag|code|kode|label|group|grup|basin|method|metode)(_|$)/i.test(nameL);

    let cats = Array.isArray(sch.categories) ? sch.categories.slice() : [];
    if (!cats.length && Array.isArray(col.categories)) cats = col.categories.slice();
    if (!cats.length && Array.isArray(col.samples)) {
      const seen = {};
      (col.samples || []).forEach(function (v) {
        if (v == null || v === "") return;
        const k = String(v);
        if (!seen[k]) {
          seen[k] = true;
          cats.push(v);
        }
      });
    }

    let kind = sch.type;
    if (!kind) {
      if (col.type && col.type !== "numeric") kind = "categorical";
      else if (nameHint) kind = "categorical";
      else if (col.n_unique != null && col.n_unique <= 12 && col.type === "numeric") kind = "categorical";
      else kind = "numeric";
    }
    if (kind === "categorical" && !cats.length && nameHint) {
      // Common Gender defaults when schema empty (old model)
      if (/gender|sex|jenis.?kelamin/i.test(nameL)) cats = ["male", "female"];
    }

    const min =
      sch.min_suggest != null ? Number(sch.min_suggest)
        : sch.min != null ? Number(sch.min)
          : 0;
    const max =
      sch.max_suggest != null ? Number(sch.max_suggest)
        : sch.max != null ? Number(sch.max)
          : 100;
    const def =
      sch.default != null ? sch.default
        : kind === "categorical" ? (cats[0] != null ? cats[0] : "")
          : (min + max) / 2;

    return {
      name: name,
      kind: kind,
      categories: cats,
      min: min,
      max: max,
      default: def,
      reason: sch.reason || "",
    };
  }

  function escapeAttr(v) {
    return String(v == null ? "" : v)
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/</g, "&lt;");
  }

  function inputFeatures() {
    // X only — never the target Y
    const y = (state.result && state.result.target) || state.target || "";
    let feats = [];
    if (state.result && Array.isArray(state.result.features)) feats = state.result.features.slice();
    else if (state.features && state.features.length) feats = state.features.slice();
    return feats.filter((f) => f && f !== y);
  }

  function isIntegerLike(values) {
    const nums = values.filter((v) => v != null && v !== "" && Number.isFinite(Number(v))).map(Number);
    if (!nums.length) return false;
    return nums.every((n) => Math.abs(n - Math.round(n)) < 1e-8);
  }

  /** AutoGluon-style problem-type inference from column meta (+ optional value samples). */
  function inferTaskFromColumn(col, sampleValues) {
    if (!col) return { task: "regression", reason: "Target belum dipilih." };
    if (state.forceClassification) {
      return { task: "classification", reason: "Anda memaksa klasifikasi." };
    }
    if (state.taskManual && (state.task === "classification" || state.task === "regression")) {
      return { task: state.task, reason: "Dipilih manual." };
    }

    // Prefer server-side suggestion when available
    if (col.suggested_task === "classification" || col.suggested_task === "regression") {
      return {
        task: col.suggested_task,
        reason: col.suggested_reason || "Saran otomatis dari profil kolom.",
      };
    }

    const nUnique = col.n_unique != null ? Number(col.n_unique) : null;
    const uniqRatio = col.unique_ratio != null ? Number(col.unique_ratio) : null;
    const values = Array.isArray(sampleValues) ? sampleValues : col.samples || [];

    if (col.type !== "numeric") {
      return { task: "classification", reason: "Target teks/kategori → klasifikasi." };
    }
    if (nUnique === 2) {
      return { task: "classification", reason: "Tepat 2 nilai unik → klasifikasi biner (standar AutoML)." };
    }
    if (nUnique != null && nUnique > 1000) {
      return { task: "regression", reason: nUnique + " nilai unik → regresi." };
    }
    const nRows = state.rows || 0;
    const thresh = nRows >= 1000 ? 0.05 : 0.1;
    const intLike = isIntegerLike(values);
    if (nUnique != null && uniqRatio != null) {
      if (intLike && nUnique <= Math.max(10, Math.floor(nRows * thresh))) {
        return {
          task: "classification",
          reason: nUnique + " kelas bilangan bulat → klasifikasi.",
        };
      }
      if (uniqRatio >= thresh && !intLike) {
        return { task: "regression", reason: "Banyak nilai numerik unik → regresi." };
      }
      if (uniqRatio < thresh) {
        return { task: "classification", reason: "Sedikit nilai unik → klasifikasi." };
      }
    }
    // Fallback: old behaviour only when meta is thin
    return {
      task: col.type === "numeric" ? "regression" : "classification",
      reason: col.type === "numeric" ? "Kolom numerik (fallback) → regresi." : "Kolom teks → klasifikasi.",
    };
  }

  function detectTask() {
    const col = state.columns.find((c) => c.name === state.target);
    const inferred = inferTaskFromColumn(col);
    state.task = inferred.task;
    state.taskReason = inferred.reason;
    state.forceClassification = state.task === "classification" && state.forceClassification;
  }

  // ---------- canvas plot helpers ----------
  function makeCanvas(w, h) {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    c.style.maxWidth = "100%";
    c.style.height = "auto";
    c.style.border = "1px solid #e2e8f0";
    c.style.borderRadius = "8px";
    c.style.background = "#fff";
    return c;
  }
  function downloadCanvas(canvas, name, type) {
    const a = document.createElement("a");
    a.download = name + (type === "jpeg" ? ".jpg" : ".png");
    a.href = canvas.toDataURL(type === "jpeg" ? "image/jpeg" : "image/png", 0.95);
    a.click();
  }
  function plotBox(title, caption, canvas) {
    const wrap = document.createElement("div");
    wrap.className = "am-plot-card";
    wrap.innerHTML = "<h3>" + title + "</h3><p class='micro'>" + caption + "</p>";
    wrap.appendChild(canvas);
    const row = document.createElement("div");
    row.className = "row-actions";
    const b1 = document.createElement("button");
    b1.type = "button";
    b1.className = "btn ghost";
    b1.textContent = "Download PNG";
    b1.onclick = () => downloadCanvas(canvas, title.replace(/\s+/g, "_"), "png");
    const b2 = document.createElement("button");
    b2.type = "button";
    b2.className = "btn ghost";
    b2.textContent = "Download JPG";
    b2.onclick = () => downloadCanvas(canvas, title.replace(/\s+/g, "_"), "jpeg");
    row.appendChild(b1);
    row.appendChild(b2);
    wrap.appendChild(row);
    return wrap;
  }

  function drawAxisLabels(ctx, W, H, pad, xLabel, yLabel) {
    ctx.fillStyle = "#475569";
    ctx.font = "11px sans-serif";
    if (xLabel) {
      ctx.textAlign = "center";
      ctx.fillText(xLabel, pad.l + (W - pad.l - pad.r) / 2, H - 6);
    }
    if (yLabel) {
      ctx.save();
      ctx.translate(12, pad.t + (H - pad.t - pad.b) / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.textAlign = "center";
      ctx.fillText(yLabel, 0, 0);
      ctx.restore();
    }
  }

  function drawBarChart(canvas, labels, values, opts) {
    opts = opts || {};
    const ctx = canvas.getContext("2d");
    const W = canvas.width, H = canvas.height;
    const pad = { l: opts.yLabel ? 58 : 48, r: 16, t: 28, b: opts.xLabel ? 56 : 48 };
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, W, H);
    const nums = values.map(Number);
    const maxV = Math.max(...nums.map((v) => Math.abs(v)), 1e-9);
    const minV = Math.min(0, ...nums);
    const span = maxV - minV || 1;
    const n = labels.length;
    const gap = 8;
    const barW = Math.max(8, (W - pad.l - pad.r - gap * n) / n);
    const y0 = H - pad.b - ((0 - minV) / span) * (H - pad.t - pad.b);
    ctx.strokeStyle = "#cbd5e1";
    ctx.beginPath();
    ctx.moveTo(pad.l, pad.t);
    ctx.lineTo(pad.l, H - pad.b);
    ctx.lineTo(W - pad.r, H - pad.b);
    ctx.stroke();
    values.forEach((v, i) => {
      const val = Number(v);
      const yVal = H - pad.b - ((val - minV) / span) * (H - pad.t - pad.b);
      const x = pad.l + gap + i * (barW + gap);
      const top = Math.min(y0, yVal);
      const h = Math.abs(y0 - yVal);
      ctx.fillStyle = opts.colors && opts.colors[i] ? opts.colors[i] : "#2563eb";
      ctx.fillRect(x, top, barW, Math.max(h, 1));
      ctx.fillStyle = "#334155";
      ctx.font = "11px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(String(labels[i]).slice(0, 14), x + barW / 2, H - pad.b + 14);
      ctx.fillText(Number(v).toFixed(opts.digits != null ? opts.digits : 3), x + barW / 2, top - 4);
    });
    drawAxisLabels(ctx, W, H, pad, opts.xLabel, opts.yLabel);
  }

  function drawScatter(canvas, xs, ys, opts) {
    opts = opts || {};
    const ctx = canvas.getContext("2d");
    const W = canvas.width, H = canvas.height;
    const pad = { l: opts.yLabel ? 58 : 48, r: 16, t: 20, b: opts.xLabel ? 52 : 40 };
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, W, H);
    let xmin = Math.min(...xs), xmax = Math.max(...xs);
    let ymin = Math.min(...ys), ymax = Math.max(...ys);
    if (xmin === xmax) { xmin -= 1; xmax += 1; }
    if (ymin === ymax) { ymin -= 1; ymax += 1; }
    // optional shared scale for actual-vs-predicted identity line
    if (opts.sharedScale) {
      const lo = Math.min(xmin, ymin), hi = Math.max(xmax, ymax);
      xmin = ymin = lo;
      xmax = ymax = hi;
    }
    const sx = (v) => pad.l + ((v - xmin) / (xmax - xmin)) * (W - pad.l - pad.r);
    const sy = (v) => H - pad.b - ((v - ymin) / (ymax - ymin)) * (H - pad.t - pad.b);
    ctx.strokeStyle = "#e2e8f0";
    ctx.beginPath();
    ctx.moveTo(pad.l, H - pad.b);
    ctx.lineTo(W - pad.r, H - pad.b);
    ctx.moveTo(pad.l, pad.t);
    ctx.lineTo(pad.l, H - pad.b);
    ctx.stroke();
    if (opts.zeroY) {
      ctx.strokeStyle = "#94a3b8";
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(pad.l, sy(0));
      ctx.lineTo(W - pad.r, sy(0));
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (opts.diag) {
      ctx.strokeStyle = "#94a3b8";
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(sx(xmin), sy(xmin));
      ctx.lineTo(sx(xmax), sy(xmax));
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.fillStyle = "#2563eb";
    for (let i = 0; i < xs.length; i++) {
      ctx.beginPath();
      ctx.arc(sx(xs[i]), sy(ys[i]), 3, 0, Math.PI * 2);
      ctx.fill();
    }
    // tick hints
    ctx.fillStyle = "#64748b";
    ctx.font = "10px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(xmin.toFixed(2), pad.l, H - pad.b + 12);
    ctx.fillText(xmax.toFixed(2), W - pad.r, H - pad.b + 12);
    ctx.textAlign = "right";
    ctx.fillText(ymin.toFixed(2), pad.l - 4, H - pad.b);
    ctx.fillText(ymax.toFixed(2), pad.l - 4, pad.t + 8);
    drawAxisLabels(ctx, W, H, pad, opts.xLabel, opts.yLabel);
  }

  function drawHeatmap(canvas, matrix, rowLabels, colLabels, opts) {
    opts = opts || {};
    const ctx = canvas.getContext("2d");
    const W = canvas.width, H = canvas.height;
    const pad = { l: 72, r: 16, t: 36, b: 52 };
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, W, H);
    const rows = matrix.length, cols = matrix[0] ? matrix[0].length : 0;
    if (!rows || !cols) return;
    let max = 1;
    matrix.forEach((r) => r.forEach((v) => { if (v > max) max = v; }));
    const cw = (W - pad.l - pad.r) / cols;
    const ch = (H - pad.t - pad.b) / rows;
    for (let i = 0; i < rows; i++) {
      for (let j = 0; j < cols; j++) {
        const v = matrix[i][j];
        const t = max ? v / max : 0;
        ctx.fillStyle = "rgba(37,99,235," + (0.15 + 0.85 * t) + ")";
        ctx.fillRect(pad.l + j * cw, pad.t + i * ch, cw - 1, ch - 1);
        ctx.fillStyle = t > 0.5 ? "#fff" : "#0f172a";
        ctx.font = "11px sans-serif";
        ctx.textAlign = "center";
        ctx.fillText(String(v), pad.l + j * cw + cw / 2, pad.t + i * ch + ch / 2 + 4);
      }
      ctx.fillStyle = "#334155";
      ctx.textAlign = "right";
      ctx.fillText(String(rowLabels[i] || i).slice(0, 12), pad.l - 6, pad.t + i * ch + ch / 2 + 4);
    }
    ctx.textAlign = "center";
    for (let j = 0; j < cols; j++) {
      ctx.fillText(String(colLabels[j] || j).slice(0, 12), pad.l + j * cw + cw / 2, H - pad.b + 14);
    }
    drawAxisLabels(ctx, W, H, pad, opts.xLabel || "Y prediksi (kelas)", opts.yLabel || "Y aktual (kelas)");
  }

  function drawCurve(canvas, series, xKey, yKey, opts) {
    // series: [{name, x:[], y:[], auc?}]
    opts = opts || {};
    const ctx = canvas.getContext("2d");
    const W = canvas.width, H = canvas.height;
    const pad = { l: opts.yLabel ? 58 : 48, r: 12, t: 20, b: opts.xLabel ? 48 : 36 };
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = "#e2e8f0";
    ctx.beginPath();
    ctx.moveTo(pad.l, H - pad.b);
    ctx.lineTo(W - pad.r, H - pad.b);
    ctx.moveTo(pad.l, pad.t);
    ctx.lineTo(pad.l, H - pad.b);
    ctx.stroke();
    if (opts.diag) {
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = "#94a3b8";
      ctx.beginPath();
      ctx.moveTo(pad.l, H - pad.b);
      ctx.lineTo(W - pad.r, pad.t);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    const colors = ["#2563eb", "#dc2626", "#16a34a", "#ca8a04", "#7c3aed", "#0891b2"];
    series.forEach((s, si) => {
      const xs = s[xKey] || s.x || [];
      const ys = s[yKey] || s.y || [];
      ctx.strokeStyle = colors[si % colors.length];
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (let i = 0; i < xs.length; i++) {
        const x = pad.l + xs[i] * (W - pad.l - pad.r);
        const y = H - pad.b - ys[i] * (H - pad.t - pad.b);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.lineWidth = 1;
    });
    ctx.font = "11px sans-serif";
    series.forEach((s, si) => {
      ctx.fillStyle = colors[si % colors.length];
      const label = (s.class || s.name || "") + (s.auc != null ? " AUC=" + Number(s.auc).toFixed(3) : "");
      ctx.fillText(label, pad.l + 8, pad.t + 12 + si * 14);
    });
    drawAxisLabels(ctx, W, H, pad, opts.xLabel, opts.yLabel);
  }

  function drawLineSeries(canvas, seriesList, opts) {
    // seriesList: [{name, values: number[]}]
    opts = opts || {};
    const ctx = canvas.getContext("2d");
    const W = canvas.width, H = canvas.height;
    const pad = { l: opts.yLabel ? 58 : 48, r: 16, t: 28, b: opts.xLabel ? 48 : 36 };
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, W, H);
    let min = Infinity, max = -Infinity, n = 0;
    seriesList.forEach((s) => {
      n = Math.max(n, s.values.length);
      s.values.forEach((v) => {
        if (v < min) min = v;
        if (v > max) max = v;
      });
    });
    if (!isFinite(min) || min === max) { min = 0; max = 1; }
    const colors = ["#2563eb", "#dc2626", "#16a34a", "#ca8a04"];
    const sx = (i) => pad.l + (i / Math.max(n - 1, 1)) * (W - pad.l - pad.r);
    const sy = (v) => H - pad.b - ((v - min) / (max - min)) * (H - pad.t - pad.b);
    ctx.strokeStyle = "#e2e8f0";
    ctx.beginPath();
    ctx.moveTo(pad.l, H - pad.b);
    ctx.lineTo(W - pad.r, H - pad.b);
    ctx.moveTo(pad.l, pad.t);
    ctx.lineTo(pad.l, H - pad.b);
    ctx.stroke();
    seriesList.forEach((s, si) => {
      ctx.strokeStyle = colors[si % colors.length];
      ctx.lineWidth = 2;
      ctx.beginPath();
      s.values.forEach((v, i) => {
        const x = sx(i), y = sy(v);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
      ctx.lineWidth = 1;
    });
    // legend
    ctx.font = "11px sans-serif";
    seriesList.forEach((s, si) => {
      ctx.fillStyle = colors[si % colors.length];
      ctx.fillText(s.name || ("seri " + (si + 1)), pad.l + 8 + si * 110, pad.t - 6);
    });
    drawAxisLabels(ctx, W, H, pad, opts.xLabel, opts.yLabel);
  }

  function drawHBarChart(canvas, labels, values, opts) {
    opts = opts || {};
    const ctx = canvas.getContext("2d");
    const W = canvas.width, H = canvas.height;
    const pad = { l: 120, r: 48, t: 20, b: opts.xLabel ? 44 : 28 };
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, W, H);
    const maxV = Math.max(...values.map(Number), 1e-9);
    const n = labels.length;
    const gap = 6;
    const barH = Math.max(10, (H - pad.t - pad.b - gap * n) / n);
    ctx.strokeStyle = "#cbd5e1";
    ctx.beginPath();
    ctx.moveTo(pad.l, pad.t);
    ctx.lineTo(pad.l, H - pad.b);
    ctx.lineTo(W - pad.r, H - pad.b);
    ctx.stroke();
    values.forEach((v, i) => {
      const w = ((W - pad.l - pad.r) * Number(v)) / maxV;
      const y = pad.t + gap + i * (barH + gap);
      ctx.fillStyle = opts.colors && opts.colors[i] ? opts.colors[i] : "#2563eb";
      ctx.fillRect(pad.l, y, Math.max(w, 1), barH);
      ctx.fillStyle = "#334155";
      ctx.font = "11px sans-serif";
      ctx.textAlign = "right";
      ctx.fillText(String(labels[i]).slice(0, 18), pad.l - 6, y + barH / 2 + 4);
      ctx.textAlign = "left";
      ctx.fillText(Number(v).toFixed(opts.digits != null ? opts.digits : 3), pad.l + w + 4, y + barH / 2 + 4);
    });
    drawAxisLabels(ctx, W, H, pad, opts.xLabel || "Importance (X)", opts.yLabel || "Fitur");
  }

  function fmtScore(v, digits) {
    if (v == null || !Number.isFinite(Number(v))) return "—";
    return Number(v).toFixed(digits != null ? digits : 4);
  }

  function appendSectionTitle(host, title, blurb) {
    const el = document.createElement("div");
    el.className = "feature-box";
    el.innerHTML = "<h3 style='margin:0 0 4px'>" + title + "</h3><p class='micro' style='margin:0'>" + blurb + "</p>";
    host.appendChild(el);
  }

  function buildResultPlots(host, r) {
    host.innerHTML = "";
    const scores = r.scores || {};
    const task = r.task || state.task;
    const isCls = task === "classification";
    const yName = r.target || state.target || "Y";
    const plots = r.plots || {};
    const yTrue = r.y_test || [];
    const yPred = r.y_pred_test || [];

    const primaryKey = scores.primary_metric || r.metric || "";
    const primaryVal = scores.primary_value != null ? scores.primary_value : scores[primaryKey];
    const flatScores = Object.fromEntries(
      Object.entries(scores).filter(([, v]) => typeof v !== "object")
    );

    const head = document.createElement("div");
    head.className = "feature-box";
    if (isCls) {
      head.innerHTML =
        "<h2>Langkah 6 — Hasil klasifikasi</h2>" +
        "<p class='am-hero'>Model memprediksi <b>kelas " + yName + "</b> dari fitur X. " +
        "Semua grafik di bawah memakai <b>data test (hold-out)</b> yang tidak ikut tuning.</p>" +
        "<p><b>Model terbaik:</b> " + (r.best_model_name || "—") +
        " &nbsp;|&nbsp; <b>Train:</b> " + (r.train_shape ? r.train_shape.join(" × ") : "—") +
        " &nbsp;|&nbsp; <b>Test:</b> " + (r.test_shape ? r.test_shape.join(" × ") : "—") + "</p>" +
        "<p><b>Metrik utama:</b> " + (primaryKey || "roc_auc_test") +
        " = <b>" + fmtScore(primaryVal) + "</b> " +
        "<span class='micro'>(semakin dekat 1 semakin baik)</span></p>" +
        "<div class='table-scroll'><table class='automl-table'><thead><tr>" +
        "<th>Akurasi train</th><th>Akurasi test</th><th>Balanced acc.</th><th>F1</th><th>Precision</th><th>Recall</th><th>ROC-AUC train</th><th>ROC-AUC test</th>" +
        "</tr></thead><tbody><tr>" +
        "<td>" + fmtScore(scores.accuracy_train) + "</td>" +
        "<td>" + fmtScore(scores.accuracy_test) + "</td>" +
        "<td>" + fmtScore(scores.balanced_accuracy_test) + "</td>" +
        "<td>" + fmtScore(scores.f1_test != null ? scores.f1_test : scores.f1_macro_test) + "</td>" +
        "<td>" + fmtScore(scores.precision_test) + "</td>" +
        "<td>" + fmtScore(scores.recall_test) + "</td>" +
        "<td>" + fmtScore(scores.roc_auc_train) + "</td>" +
        "<td>" + fmtScore(scores.roc_auc_test) + "</td>" +
        "</tr></tbody></table></div>" +
        "<p class='micro'><b>Cara baca:</b> jika akurasi/ROC-AUC <i>train</i> jauh lebih tinggi dari <i>test</i>, model overfitting. " +
        "ROC-AUC &amp; F1 lebih andal daripada akurasi saat kelas tidak seimbang.</p>" +
        "<details class='fold'><summary>Parameter model &amp; skor mentah</summary>" +
        "<pre class='automl-log' style='max-height:140px'>" + JSON.stringify(r.best_model_param || {}, null, 2) + "</pre>" +
        "<pre class='automl-log' style='max-height:160px'>" + JSON.stringify(flatScores, null, 2) + "</pre></details>";
    } else {
      head.innerHTML =
        "<h2>Langkah 6 — Hasil regresi</h2>" +
        "<p class='am-hero'>Model memprediksi nilai numerik <b>" + yName + "</b> dari fitur X. " +
        "Grafik membandingkan <b>Y aktual</b> vs <b>Y prediksi</b> pada data test.</p>" +
        "<p><b>Model terbaik:</b> " + (r.best_model_name || "—") +
        " &nbsp;|&nbsp; <b>Train:</b> " + (r.train_shape ? r.train_shape.join(" × ") : "—") +
        " &nbsp;|&nbsp; <b>Test:</b> " + (r.test_shape ? r.test_shape.join(" × ") : "—") + "</p>" +
        "<p><b>Metrik utama:</b> " + (primaryKey || "rmse_test") +
        " = <b>" + fmtScore(primaryVal) + "</b> " +
        "<span class='micro'>(RMSE/MAE: semakin kecil semakin baik; R²: semakin dekat 1 semakin baik)</span></p>" +
        "<div class='table-scroll'><table class='automl-table'><thead><tr>" +
        "<th>R² train</th><th>R² test</th><th>RMSE test</th><th>MAE test</th><th>MSE test</th><th>MAPE test %</th>" +
        "</tr></thead><tbody><tr>" +
        "<td>" + fmtScore(scores.r2_train) + "</td>" +
        "<td>" + fmtScore(scores.r2_test) + "</td>" +
        "<td>" + fmtScore(scores.rmse_test) + "</td>" +
        "<td>" + fmtScore(scores.mae_test) + "</td>" +
        "<td>" + fmtScore(scores.mse_test) + "</td>" +
        "<td>" + fmtScore(scores.mape_test, 2) + "</td>" +
        "</tr></tbody></table></div>" +
        "<p class='micro'><b>Cara baca:</b> R² test jauh di bawah R² train → overfitting. " +
        "Titik di grafik Aktual vs Prediksi harus mendekati garis putus-putus (prediksi sempurna).</p>" +
        "<details class='fold'><summary>Parameter model &amp; skor mentah</summary>" +
        "<pre class='automl-log' style='max-height:140px'>" + JSON.stringify(r.best_model_param || {}, null, 2) + "</pre>" +
        "<pre class='automl-log' style='max-height:160px'>" + JSON.stringify(flatScores, null, 2) + "</pre></details>";
    }
    host.appendChild(head);

    const plotsHost = document.createElement("div");
    plotsHost.className = "am-plots";
    host.appendChild(plotsHost);

    if (isCls) {
      appendSectionTitle(
        plotsHost,
        "A. Metrik train vs test",
        "Sumbu X = jenis metrik / set data. Sumbu Y = nilai skor (0–1)."
      );
      const metricLabels = [];
      const metricVals = [];
      const metricColors = [];
      [
        ["Akurasi train", scores.accuracy_train, "#93c5fd"],
        ["Akurasi test", scores.accuracy_test, "#2563eb"],
        ["F1 test", scores.f1_test != null ? scores.f1_test : scores.f1_macro_test, "#16a34a"],
        ["ROC-AUC train", scores.roc_auc_train, "#fcd34d"],
        ["ROC-AUC test", scores.roc_auc_test, "#d97706"],
        ["Bal.acc test", scores.balanced_accuracy_test, "#7c3aed"],
      ].forEach(function (row) {
        if (row[1] == null || !Number.isFinite(Number(row[1]))) return;
        metricLabels.push(row[0]);
        metricVals.push(Number(row[1]));
        metricColors.push(row[2]);
      });
      if (metricLabels.length) {
        const c = makeCanvas(560, 260);
        drawBarChart(c, metricLabels, metricVals, {
          colors: metricColors,
          xLabel: "Metrik (X)",
          yLabel: "Nilai skor (Y)",
        });
        plotsHost.appendChild(
          plotBox(
            "Ringkasan skor klasifikasi",
            "X = nama metrik, Y = nilai. Bandingkan train (muda) vs test (tua) untuk mendeteksi overfitting.",
            c
          )
        );
      }

      if (scores.confusion_matrix) {
        appendSectionTitle(
          plotsHost,
          "B. Matriks kebingungan (Y aktual × Y prediksi)",
          "Baris = kelas sebenarnya (Y aktual). Kolom = kelas yang diprediksi model (Y prediksi)."
        );
        const cm = scores.confusion_matrix;
        const labels = r.class_names || cm.map(function (_, i) { return String(i); });
        const c = makeCanvas(Math.max(360, labels.length * 72 + 100), Math.max(300, labels.length * 56 + 90));
        drawHeatmap(c, cm, labels, labels, {
          xLabel: "Y prediksi (kelas)",
          yLabel: "Y aktual (kelas)",
        });
        plotsHost.appendChild(
          plotBox(
            "Confusion matrix — " + yName,
            "Diagonal = prediksi benar. Di luar diagonal = kesalahan. Angka = jumlah sampel test.",
            c
          )
        );
      }

      if (scores.classification_report) {
        const rep = scores.classification_report;
        const tbl = document.createElement("div");
        tbl.className = "feature-box";
        let html =
          "<h3>Laporan per kelas</h3>" +
          "<p class='micro'>Precision = ketepatan prediksi kelas itu. Recall = kelengkapan kelas itu tertangkap. F1 = gabungan keduanya. Support = jumlah sampel aktual.</p>" +
          "<div class='table-scroll'><table class='automl-table'><thead><tr><th>Kelas (Y)</th><th>Precision</th><th>Recall</th><th>F1</th><th>Support</th></tr></thead><tbody>";
        Object.keys(rep).forEach(function (k) {
          const row = rep[k];
          if (!row || typeof row !== "object" || row.precision == null) return;
          html +=
            "<tr><td>" + k + "</td><td>" + Number(row.precision).toFixed(3) +
            "</td><td>" + Number(row.recall).toFixed(3) +
            "</td><td>" + Number(row["f1-score"]).toFixed(3) +
            "</td><td>" + (row.support != null ? row.support : "") + "</td></tr>";
        });
        html += "</tbody></table></div>";
        tbl.innerHTML = html;
        plotsHost.appendChild(tbl);
      }

      if (plots.roc_curves && plots.roc_curves.length) {
        appendSectionTitle(
          plotsHost,
          "C. Kurva ROC",
          "X = False Positive Rate (kesalahan positif). Y = True Positive Rate (recall). Semakin ke kiri-atas semakin baik."
        );
        const c = makeCanvas(480, 360);
        drawCurve(c, plots.roc_curves, "fpr", "tpr", {
          diag: true,
          xLabel: "False Positive Rate (X)",
          yLabel: "True Positive Rate (Y)",
        });
        plotsHost.appendChild(
          plotBox(
            "ROC curve — " + yName,
            "Garis putus-putus = tebak acak (AUC 0,5). AUC mendekati 1 = pemisahan kelas kuat.",
            c
          )
        );
      }

      if (plots.pr_curves && plots.pr_curves.length) {
        appendSectionTitle(
          plotsHost,
          "D. Kurva Precision–Recall",
          "Penting jika kelas tidak seimbang. X = Recall, Y = Precision."
        );
        const c = makeCanvas(480, 360);
        drawCurve(
          c,
          plots.pr_curves.map(function (s) {
            return { class: s.class, fpr: s.recall, tpr: s.precision, auc: null };
          }),
          "fpr",
          "tpr",
          { diag: false, xLabel: "Recall (X)", yLabel: "Precision (Y)" }
        );
        plotsHost.appendChild(
          plotBox(
            "Precision–Recall — " + yName,
            "X = recall (kelengkapan), Y = precision (ketepatan). Berguna saat kelas jarang.",
            c
          )
        );
      }

      if (yTrue.length && yPred.length) {
        appendSectionTitle(
          plotsHost,
          "E. Sebaran kelas aktual vs prediksi",
          "Membandingkan distribusi Y aktual dan Y prediksi pada set test."
        );
        const labels = r.class_names || Array.from(new Set(yTrue.concat(yPred).map(String)));
        const act = labels.map(function (l) {
          return yTrue.filter(function (x) { return String(x) === String(l); }).length;
        });
        const pred = labels.map(function (l) {
          return yPred.filter(function (x) { return String(x) === String(l); }).length;
        });
        const c = makeCanvas(520, 260);
        drawBarChart(c, labels.map(function (l) { return "Aktual " + String(l).slice(0, 8); }), act, {
          xLabel: "Kelas Y aktual (X)",
          yLabel: "Jumlah sampel (Y)",
          digits: 0,
        });
        plotsHost.appendChild(plotBox("Jumlah kelas aktual", "X = kelas sebenarnya, Y = banyaknya baris test.", c));
        const c2 = makeCanvas(520, 260);
        drawBarChart(c2, labels.map(function (l) { return "Pred " + String(l).slice(0, 8); }), pred, {
          colors: labels.map(function () { return "#16a34a"; }),
          xLabel: "Kelas Y prediksi (X)",
          yLabel: "Jumlah sampel (Y)",
          digits: 0,
        });
        plotsHost.appendChild(plotBox("Jumlah kelas prediksi", "X = kelas hasil model, Y = banyaknya prediksi.", c2));
      }

      // probability histogram for binary if available
      if (r.y_proba_test && yTrue.length) {
        let proba = r.y_proba_test;
        // may be 1d scores or 2d
        let pos = [];
        if (Array.isArray(proba[0])) {
          pos = proba.map(function (row) { return Number(row[row.length - 1]); });
        } else {
          pos = proba.map(Number);
        }
        if (pos.length && pos.every(function (v) { return Number.isFinite(v); })) {
          appendSectionTitle(
            plotsHost,
            "F. Distribusi skor / probabilitas kelas positif",
            "X = nilai skor model (mendekati 1 = lebih yakin kelas positif). Y = frekuensi sampel test."
          );
          const bins = 10;
          const counts = Array(bins).fill(0);
          const labelsP = [];
          for (let i = 0; i < bins; i++) labelsP.push((i / bins).toFixed(1) + "–" + ((i + 1) / bins).toFixed(1));
          pos.forEach(function (v) {
            let b = Math.floor(Math.min(0.9999, Math.max(0, v)) * bins);
            counts[b]++;
          });
          const c = makeCanvas(520, 260);
          drawBarChart(c, labelsP, counts, {
            xLabel: "Skor / probabilitas (X)",
            yLabel: "Jumlah sampel (Y)",
            digits: 0,
          });
          plotsHost.appendChild(
            plotBox(
              "Histogram skor prediksi",
              "Puncak di kiri/kanan yang terpisah = model yakin membedakan kelas.",
              c
            )
          );
        }
      }
    } else {
      // ---------------- regression ----------------
      const yt = yTrue.map(Number).filter(function (v, i) { return Number.isFinite(v) && Number.isFinite(Number(yPred[i])); });
      const yp = yPred.map(Number).filter(function (v, i) { return Number.isFinite(v) && Number.isFinite(Number(yTrue[i])); });
      // rebuild aligned
      const yt2 = [];
      const yp2 = [];
      for (let i = 0; i < yTrue.length; i++) {
        const a = Number(yTrue[i]), b = Number(yPred[i]);
        if (Number.isFinite(a) && Number.isFinite(b)) {
          yt2.push(a);
          yp2.push(b);
        }
      }

      appendSectionTitle(
        plotsHost,
        "A. Metrik regresi train vs test",
        "Sumbu X = jenis metrik. Sumbu Y = nilai (R² 0–1; RMSE/MAE dalam satuan Y)."
      );
      const regBars = [];
      if (scores.r2_train != null) regBars.push(["R² train", scores.r2_train, "#93c5fd"]);
      if (scores.r2_test != null) regBars.push(["R² test", scores.r2_test, "#2563eb"]);
      if (scores.rmse_test != null) regBars.push(["RMSE test", scores.rmse_test, "#dc2626"]);
      if (scores.mae_test != null) regBars.push(["MAE test", scores.mae_test, "#ea580c"]);
      if (regBars.length) {
        const c = makeCanvas(480, 260);
        drawBarChart(
          c,
          regBars.map(function (x) { return x[0]; }),
          regBars.map(function (x) { return Number(x[1]); }),
          {
            colors: regBars.map(function (x) { return x[2]; }),
            xLabel: "Metrik (X)",
            yLabel: "Nilai (Y)",
          }
        );
        plotsHost.appendChild(
          plotBox(
            "Ringkasan skor regresi",
            "R² semakin tinggi semakin baik. RMSE/MAE semakin rendah semakin baik (satuannya sama dengan " + yName + ").",
            c
          )
        );
      }

      if (yt2.length && yp2.length) {
        appendSectionTitle(
          plotsHost,
          "B. Y aktual vs Y prediksi",
          "Setiap titik = satu baris test. Idealnya titik menempel garis putus-putus (prediksi = aktual)."
        );
        const c = makeCanvas(440, 400);
        drawScatter(c, yt2, yp2, {
          diag: true,
          sharedScale: true,
          xLabel: "Y aktual — " + yName + " (X)",
          yLabel: "Y prediksi (Y)",
        });
        plotsHost.appendChild(
          plotBox(
            "Aktual vs prediksi",
            "X = nilai sebenarnya, Y = keluaran model. R² test = " + fmtScore(scores.r2_test) + ".",
            c
          )
        );

        appendSectionTitle(
          plotsHost,
          "C. Deret sampel: aktual & prediksi",
          "X = urutan sampel test. Y = nilai " + yName + ". Biru = aktual, merah = prediksi."
        );
        const c2 = makeCanvas(560, 280);
        drawLineSeries(
          c2,
          [
            { name: "Y aktual", values: yt2.slice(0, 250) },
            { name: "Y prediksi", values: yp2.slice(0, 250) },
          ],
          { xLabel: "Indeks sampel test (X)", yLabel: yName + " (Y)" }
        );
        plotsHost.appendChild(
          plotBox(
            "Perbandingan per sampel",
            "Jika garis merah mengikuti biru, model menangkap pola dengan baik.",
            c2
          )
        );

        const resid = yt2.map(function (v, i) { return v - yp2[i]; });
        const absErr = resid.map(function (v) { return Math.abs(v); });

        appendSectionTitle(
          plotsHost,
          "D. Residual (error)",
          "Residual = Y aktual − Y prediksi. Pola acak di sekitar 0 = bagus; pola lengkung = bias model."
        );
        const c3 = makeCanvas(440, 360);
        drawScatter(c3, yp2, resid, {
          zeroY: true,
          xLabel: "Y prediksi (X)",
          yLabel: "Residual = aktual − prediksi (Y)",
        });
        plotsHost.appendChild(
          plotBox(
            "Residual vs prediksi",
            "X = prediksi model, Y = error. Sebaran horizontal di sekitar 0 tanpa bentuk jelas = residual sehat.",
            c3
          )
        );

        const c3b = makeCanvas(440, 360);
        drawScatter(c3b, yt2, resid, {
          zeroY: true,
          xLabel: "Y aktual (X)",
          yLabel: "Residual (Y)",
        });
        plotsHost.appendChild(
          plotBox(
            "Residual vs aktual",
            "X = nilai sebenarnya, Y = error. Membantu melihat apakah error membesar di rentang Y tertentu.",
            c3b
          )
        );

        const c4 = makeCanvas(480, 260);
        const bins = 12;
        let rmin = Math.min.apply(null, resid), rmax = Math.max.apply(null, resid);
        if (rmin === rmax) { rmin -= 1; rmax += 1; }
        const counts = Array(bins).fill(0);
        const binLabels = [];
        for (let i = 0; i < bins; i++) {
          const a = rmin + ((rmax - rmin) * i) / bins;
          const b = rmin + ((rmax - rmin) * (i + 1)) / bins;
          binLabels.push(a.toFixed(1));
          void b;
        }
        resid.forEach(function (v) {
          let b = Math.floor(((v - rmin) / (rmax - rmin)) * bins);
          if (b >= bins) b = bins - 1;
          if (b < 0) b = 0;
          counts[b]++;
        });
        drawBarChart(c4, binLabels, counts, {
          xLabel: "Nilai residual (X)",
          yLabel: "Frekuensi (Y)",
          digits: 0,
        });
        plotsHost.appendChild(
          plotBox(
            "Histogram residual",
            "X = besar error, Y = berapa sering. Idealnya berbentuk lonceng di sekitar 0.",
            c4
          )
        );

        const c5 = makeCanvas(440, 360);
        drawScatter(c5, yp2, absErr, {
          xLabel: "Y prediksi (X)",
          yLabel: "|Error| absolut (Y)",
        });
        plotsHost.appendChild(
          plotBox(
            "Error absolut vs prediksi",
            "X = prediksi, Y = |aktual − prediksi|. Membantu melihat di mana model paling meleset.",
            c5
          )
        );
      }
    }

    // Feature importance (both tasks)
    if (plots.feature_importance && plots.feature_importance.length) {
      appendSectionTitle(
        plotsHost,
        isCls ? "G. Importance fitur (X)" : "E. Importance fitur (X)",
        "Seberapa besar tiap kolom X berkontribusi ke prediksi Y menurut model."
      );
      const top = plots.feature_importance.slice(0, 20);
      const c = makeCanvas(520, Math.max(260, top.length * 22 + 50));
      drawHBarChart(
        c,
        top.map(function (x) { return String(x.feature); }),
        top.map(function (x) { return x.importance; }),
        { xLabel: "Importance (X)", yLabel: "Nama fitur" }
      );
      plotsHost.appendChild(
        plotBox(
          "Feature importance",
          "Batang lebih panjang = fitur X lebih berpengaruh ke Y. Berguna untuk interpretasi lapangan.",
          c
        )
      );
    }

    // Loss (unit) vs number of training epochs / trials
    let curve = r.training_curve;
    if ((!curve || !curve.loss || !curve.loss.length) && Array.isArray(r.history) && r.history.length) {
      // Client-side fallback if worker didn't emit training_curve
      const metricVals = [];
      r.history.forEach(function (t) {
        const raw = t && (t.value != null ? t.value : t.loss);
        const v = Number(raw);
        if (Number.isFinite(v)) metricVals.push(v);
      });
      if (metricVals.length) {
        const loss = metricVals.map(function (v) {
          if (isCls && v >= 0 && v <= 1) return 1 - v;
          if (isCls) return -v;
          return v;
        });
        const best = [];
        let cur = Infinity;
        loss.forEach(function (v) {
          if (v < cur) cur = v;
          best.push(cur);
        });
        curve = {
          epochs: metricVals.map(function (_, i) { return i + 1; }),
          loss: loss,
          best_loss: best,
          metric: metricVals,
          note: "Dibangun di klien dari riwayat trial Optuna.",
        };
      }
    }
    if (curve && Array.isArray(curve.loss) && curve.loss.length) {
      appendSectionTitle(
        plotsHost,
        "Loss (unit) vs number of training epochs",
        (curve.note ||
          "AutoML memakai trial hyperparameter sebagai langkah training. X = epoch/trial, Y = loss.") +
          " Kurva best-so-far menunjukkan loss terbaik sampai epoch tersebut."
      );
      const cLoss = makeCanvas(560, 280);
      drawLineSeries(
        cLoss,
        [
          { name: "Loss per epoch/trial", values: curve.loss },
          { name: "Best loss so far", values: curve.best_loss || curve.loss },
        ],
        {
          xLabel: "Number of training epochs / trials (X)",
          yLabel: "Loss (unit) (Y, ↓ lebih baik)",
        }
      );
      plotsHost.appendChild(
        plotBox(
          "Loss vs training epochs",
          "Sumbu X = nomor epoch/trial, sumbu Y = loss. Idealnya loss (dan best loss) menurun seiring training.",
          cLoss
        )
      );
      if (Array.isArray(curve.metric) && curve.metric.length) {
        const cMet = makeCanvas(560, 240);
        drawLineSeries(
          cMet,
          [{ name: isCls ? "CV score (↑)" : "CV MSE (↓)", values: curve.metric }],
          {
            xLabel: "Epoch / trial (X)",
            yLabel: isCls ? "Skor CV (Y)" : "MSE CV (Y)",
          }
        );
        plotsHost.appendChild(
          plotBox(
            "Metrik CV per trial",
            isCls
              ? "Skor validasi silang mentah (mis. ROC-AUC / balanced accuracy)."
              : "MSE validasi silang mentah per trial.",
            cMet
          )
        );
      }
    } else if (Array.isArray(r.history) && r.history.length) {
      const vals = r.history
        .map(function (t) { return t.value != null ? Number(t.value) : NaN; })
        .filter(function (v) { return isFinite(v); });
      if (vals.length) {
        appendSectionTitle(
          plotsHost,
          "Riwayat optimasi hyperparameter",
          isCls
            ? "X = nomor trial. Y = skor CV: semakin tinggi semakin baik."
            : "X = nomor trial. Y = skor CV (MSE): semakin rendah semakin baik."
        );
        const c = makeCanvas(520, 240);
        drawLineSeries(c, [{ name: isCls ? "CV score" : "MSE CV", values: vals }], {
          xLabel: "Trial ke- (X)",
          yLabel: isCls ? "Skor CV (Y)" : "MSE (Y)",
        });
        plotsHost.appendChild(
          plotBox(
            "Optimization history",
            "Setiap titik = satu percobaan parameter saat tuning.",
            c
          )
        );
      }
    }

    const zipBtn = document.createElement("button");
    zipBtn.type = "button";
    zipBtn.className = "btn";
    zipBtn.textContent = "Unduh semua plot (PNG satu per satu)";
    zipBtn.onclick = function () {
      plotsHost.querySelectorAll("canvas").forEach(function (cv, i) {
        downloadCanvas(cv, "automl_plot_" + (i + 1), "png");
      });
    };
    host.appendChild(zipBtn);
  }

  // ---------- parse paste into table ----------
  function parsePaste(text) {
    const lines = text.replace(/\r/g, "").trim().split("\n").filter((l) => l.length);
    if (!lines.length) return [];
    const delim = lines[0].indexOf("\t") >= 0 ? "\t" : lines[0].indexOf(";") >= 0 ? ";" : ",";
    const rows = lines.map((l) => l.split(delim).map((c) => c.trim()));
    const feats = inputFeatures();
    // if first row looks like headers matching features
    let start = 0;
    let colMap = null;
    if (rows[0].some((h) => feats.includes(h))) {
      colMap = rows[0];
      start = 1;
    }
    const out = [];
    for (let i = start; i < rows.length; i++) {
      const obj = {};
      if (colMap) {
        colMap.forEach((h, j) => {
          if (feats.includes(h)) obj[h] = rows[i][j];
        });
      } else {
        feats.forEach((f, j) => {
          obj[f] = rows[i][j] != null ? rows[i][j] : "";
        });
      }
      // coerce numbers when column was numeric in training preview
      state.columns.forEach((c) => {
        if (c.type === "numeric" && obj[c.name] != null && obj[c.name] !== "") {
          const n = Number(String(obj[c.name]).replace(",", "."));
          if (!isNaN(n)) obj[c.name] = n;
        }
      });
      out.push(obj);
    }
    return out;
  }

  function ensurePredRows(n) {
    const feats = inputFeatures();
    while (state.predRows.length < n) {
      const o = {};
      feats.forEach((f) => {
        const info = featureInfo(f);
        o[f] = info.default != null && info.default !== "" ? info.default : "";
      });
      state.predRows.push(o);
    }
    // strip target from existing rows if present
    const y = (state.result && state.result.target) || state.target;
    state.predRows.forEach((row) => {
      if (y && Object.prototype.hasOwnProperty.call(row, y)) delete row[y];
      feats.forEach((f) => {
        if (row[f] === undefined || row[f] === "") {
          const info = featureInfo(f);
          if (row[f] === undefined || (row[f] === "" && info.kind === "categorical" && info.categories.length)) {
            row[f] = info.default != null ? info.default : "";
          }
        }
      });
    });
  }

  function render() {
    const host = document.getElementById("automl-step-panel");
    if (!host) return;

    if (state.step === 1) {
      host.innerHTML =
        '<section class="feature-box am-skip-box">' +
        "<h2>Sudah punya model tersimpan?</h2>" +
        "<p class='am-hero'>Langsung ke <b>langkah 7</b> untuk memuat model yang sudah dilatih — tanpa unggah CSV atau latih ulang.</p>" +
        '<div class="row-actions">' +
        '<button type="button" class="btn am-primary" id="am-jump-7">Lompat ke langkah 7 → Muat model</button> ' +
        '<button type="button" class="btn ghost" id="am-jump-8">Lompat ke langkah 8 → Prediksi</button> ' +
        '<button type="button" class="btn ghost" id="am-refresh-saved-models">Segarkan daftar model</button>' +
        "</div>" +
        '<div id="am-saved-models-home" class="storage-file-list"></div>' +
        '<p class="micro">Atau lanjut unggah CSV di bawah untuk melatih model baru.</p>' +
        "</section>" +
        '<section class="feature-box"><h2>Langkah 1 — Impor CSV (latih baru)</h2>' +
        '<p class="micro">Mode lokal: jalankan <b>Start_Migas.bat</b> (biarkan jendela itu tetap terbuka), lalu unggah CSV di sini. Default API: <code>http://127.0.0.1:5055</code>.</p>' +
        '<p class="am-busy" id="am-api-banner">Memeriksa server lokal…</p>' +
        '<label class="dropzone am-dropzone" id="automl-drop">' +
        '<input id="automl-file" type="file" accept=".csv,text/csv,application/vnd.ms-excel" />' +
        "<strong>Seret CSV ke sini, atau klik untuk memilih file</strong>" +
        "<span>Menerima .csv (koma, titik koma, atau tab)</span></label>" +
        '<h3>File di folder uploads</h3>' +
        '<div class="row-actions"><button type="button" class="btn ghost" id="am-refresh-uploads">Segarkan daftar</button></div>' +
        '<div id="am-upload-list" class="storage-file-list"></div>' +
        '<div id="automl-preview"></div></section>';
      wireUpload();
      refreshUploadList();
      probeLocalApi();
      wireHomeModelShortcut();
      if (state.head.length) showPreview();
      return;
    }

    if (state.step === 2) {
      detectTask();
      const taskLabel = state.task === "classification" ? "Klasifikasi" : "Regresi";
      host.innerHTML =
        '<section class="feature-box"><h2>Langkah 2 — Pilih target (Y) dan input (X)</h2>' +
        '<p class="micro">Pilih tepat satu Y (yang diprediksi) dan satu atau lebih X (fitur). Jenis masalah dideteksi otomatis ala AutoGluon, bisa diganti manual.</p>' +
        '<div class="row-actions"><button type="button" class="btn ghost" id="am-select-all-x">Pilih semua sebagai X</button>' +
        '<button type="button" class="btn ghost" id="am-clear-x">Kosongkan X</button></div>' +
        '<div class="am-task-box">' +
        '<p><span class="automl-badge">Jenis: ' + taskLabel + "</span></p>" +
        '<p class="micro">' + (state.taskReason || "") + "</p>" +
        '<div class="row-actions">' +
        '<label class="check-line"><input type="radio" name="am-task" value="classification" ' +
        (state.task === "classification" ? "checked" : "") +
        '/> Klasifikasi <span class="micro">(kategori / ya-tidak / kelas)</span></label>' +
        '<label class="check-line"><input type="radio" name="am-task" value="regression" ' +
        (state.task === "regression" ? "checked" : "") +
        '/> Regresi <span class="micro">(angka kontinu, mis. ROP, pressure)</span></label>' +
        "</div></div>" +
        '<div class="table-scroll"><table class="automl-table"><thead><tr><th>X</th><th>Y</th><th>Kolom</th><th>Tipe</th><th>Unik</th><th>Kosong</th><th>Saran jika Y</th></tr></thead><tbody>' +
        state.columns
          .map((c) => {
            const isY = state.target === c.name;
            const isX = state.features.includes(c.name);
            const uniq = c.n_unique != null ? c.n_unique : "—";
            const sug = c.suggested_task === "classification" ? "klasifikasi" : c.suggested_task === "regression" ? "regresi" : "—";
            return (
              "<tr><td><input type='checkbox' data-x='" +
              c.name +
              "' " +
              (isX ? "checked" : "") +
              " " +
              (isY ? "disabled" : "") +
              "/></td>" +
              "<td><input type='radio' name='am-y' data-y='" +
              c.name +
              "' " +
              (isY ? "checked" : "") +
              "/></td>" +
              "<td>" +
              c.name +
              "</td><td>" +
              c.type +
              "</td><td>" +
              uniq +
              "</td><td>" +
              c.missing +
              "</td><td>" +
              sug +
              "</td></tr>"
            );
          })
          .join("") +
        "</tbody></table></div></section>";
      wireStep2();
      return;
    }

    if (state.step === 3) {
      const mode = state.splitMode === "files" ? "files" : "auto";
      host.innerHTML =
        '<section class="feature-box"><h2>Langkah 3 — Persiapan data &amp; split</h2>' +
        '<p class="micro">Preprocessing (<code>DataPrepare</code>) hanya di-<b>fit</b> pada train, lalu <b>transform</b> ke test — mencegah kebocoran data.</p>' +
        '<div class="am-split-modes">' +
        '<label class="check-line"><input type="radio" name="am-split-mode" value="auto" ' +
        (mode === "auto" ? "checked" : "") +
        "/> <b>Acak train/test</b> dari CSV langkah 1</label>" +
        '<label class="check-line"><input type="radio" name="am-split-mode" value="files" ' +
        (mode === "files" ? "checked" : "") +
        "/> <b>Unggah CSV terpisah</b> untuk train &amp; test</label>" +
        "</div>" +
        '<div id="am-split-auto" ' +
        (mode === "auto" ? "" : "hidden") +
        ">" +
        '<label>Proporsi test (hold-out) <input id="am-test-size" type="number" min="0.05" max="0.5" step="0.05" value="' +
        state.testSize +
        '"/></label>' +
        '<label>Random seed <input id="am-seed" type="number" value="' +
        state.randomState +
        '"/></label>' +
        '<p class="micro">Saran: 0,2 (20%) test. Seed tetap = hasil bisa diulang.</p>' +
        "</div>" +
        '<div id="am-split-files" ' +
        (mode === "files" ? "" : "hidden") +
        ">" +
        '<p class="micro">Kolom harus sama dengan X/Y di langkah 2 (termasuk nama target). Boleh memakai file langkah 1 sebagai train.</p>' +
        '<div class="am-split-upload-grid">' +
        '<div class="am-s8-card">' +
        "<h3>Train CSV</h3>" +
        '<p class="micro" id="am-train-file-info">' +
        (state.trainUploadId
          ? "Aktif: <b>" +
            (state.trainFileName || state.trainUploadId) +
            "</b>" +
            (state.trainMeta ? " · " + state.trainMeta.rows + " baris" : "")
          : state.uploadId
            ? "Default: file langkah 1 (<b>" +
              (state.sourceName || state.uploadId) +
              "</b>) — atau unggah pengganti."
            : "Belum ada file train.") +
        "</p>" +
        '<label class="dropzone am-dropzone am-dropzone-sm">' +
        '<input id="am-train-file" type="file" accept=".csv,text/csv" />' +
        "<strong>Pilih / seret train.csv</strong></label>" +
        '<div class="row-actions">' +
        '<button type="button" class="btn ghost" id="am-train-use-step1">Pakai file langkah 1</button>' +
        "</div></div>" +
        '<div class="am-s8-card">' +
        "<h3>Test CSV</h3>" +
        '<p class="micro" id="am-test-file-info">' +
        (state.testUploadId
          ? "Aktif: <b>" +
            (state.testFileName || state.testUploadId) +
            "</b>" +
            (state.testMeta ? " · " + state.testMeta.rows + " baris" : "")
          : "Wajib unggah file test (hold-out).") +
        "</p>" +
        '<label class="dropzone am-dropzone am-dropzone-sm">' +
        '<input id="am-test-file" type="file" accept=".csv,text/csv" />' +
        "<strong>Pilih / seret test.csv</strong></label>" +
        "</div></div>" +
        '<label>Random seed (encoding / sampling) <input id="am-seed" type="number" value="' +
        state.randomState +
        '"/></label>' +
        "</div>" +
        '<details class="fold"><summary>Lanjutan</summary>' +
        '<p class="micro">Fitur interaksi dimatikan default agar cepat &amp; hemat RAM. Encoding kategori + pembersihan kolom konstan dijalankan otomatis saat training.</p></details>' +
        "</section>";
      wireStep3();
      return;
    }

    if (state.step === 4) {
      // All names exist in automl-alex 1.6 all_models and support both clf + reg wrappers.
      const modelMeta = [
        { id: "LightGBM", ok: "baik", note: "Stabil & cepat — disarankan (clf + reg)" },
        { id: "CatBoost", ok: "baik", note: "Kuat untuk tabular — disarankan (clf + reg)" },
        { id: "RandomForest", ok: "baik", note: "Stabil, interpretable (clf + reg)" },
        { id: "ExtraTrees", ok: "baik", note: "Mirip RF, sering kompetitif (clf + reg)" },
        { id: "XGBoost", ok: "hati-hati", note: "Bagus; di regresi beberapa trial bisa gagal (ditangkap Optuna)" },
        { id: "LinearModel", ok: "hati-hati", note: "Butuh normalisasi (otomatis). Cocok baseline linear" },
        { id: "KNeighbors", ok: "lemah", note: "Sensitif skala; sering gagal di data kecil / sparse" },
        { id: "MLP", ok: "lemah", note: "Butuh normalisasi; lambat, jarang menang di tabular kecil" },
      ];
      const taskNote =
        state.task === "classification"
          ? "Klasifikasi biner: BestSingleModelClassifier (metrik ROC-AUC). ≥3 kelas: LightGBM + Optuna (balanced accuracy) — daftar di bawah hanya untuk biner/regresi."
          : "Regresi: BestSingleModelRegressor (optimasi MSE; laporan RMSE / MAE / R²).";
      host.innerHTML =
        '<section class="feature-box"><h2>Langkah 4 — Pilih kandidat model</h2>' +
        '<p class="micro">' + taskNote + "</p>" +
        '<p class="micro">Centang model yang mau dibandingkan. Yang <b>baik</b> aman untuk klasifikasi dan regresi. AutoML memilih yang terbaik dalam batas waktu.</p>' +
        '<div class="row-actions"><button type="button" class="btn ghost" id="am-models-default">Default disarankan</button> ' +
        '<button type="button" class="btn ghost" id="am-models-safe">Hanya yang baik</button> ' +
        '<button type="button" class="btn ghost" id="am-models-all">Pilih semua</button></div>' +
        modelMeta
          .map((m) => {
            const on = state.models.includes(m.id);
            const badge =
              m.ok === "baik" ? "✓ baik" : m.ok === "hati-hati" ? "~ hati-hati" : "! lemah";
            return (
              "<label class='check-line'><input type='checkbox' data-model='" +
              m.id +
              "' " +
              (on ? "checked" : "") +
              "/> <b>" +
              m.id +
              "</b> <span class='automl-badge'>" +
              badge +
              "</span><br/><span class='micro'>" +
              m.note +
              "</span></label>"
            );
          })
          .join("") +
        "</section>";
      wireStep4();
      return;
    }

    if (state.step === 5) {
      host.innerHTML =
        '<section class="feature-box"><h2>Langkah 5 — Optimasi (model.opt)</h2>' +
        '<label>Time budget (seconds) <input id="am-timeout" type="number" min="30" value="' +
        state.timeout +
        '"/></label>' +
        '<p class="micro">Training runs in the background. Live log below. You can leave this page and return.</p>' +
        '<button type="button" class="btn" id="am-start">Start training</button> ' +
        '<button type="button" class="btn ghost" id="am-cancel">Cancel</button>' +
        '<pre id="am-log" class="automl-log"></pre></section>';
      wireStep5();
      return;
    }

    if (state.step === 6) {
      if (!state.result) {
        host.innerHTML = '<p class="micro">No results yet. Finish training first.</p>';
        return;
      }
      buildResultPlots(host, state.result);
      return;
    }

    if (state.step === 7) {
      host.innerHTML =
        '<section class="feature-box"><h2>Langkah 7 — Muat model tersimpan</h2>' +
        '<p class="am-hero">Pilih model yang sudah dilatih. <b>Tidak perlu unggah CSV atau latih ulang</b> — langsung prediksi di langkah 8.</p>' +
        '<p class="micro">Model disimpan di <code>migas_data/ml_model/</code>.</p>' +
        "<p>Model aktif: <b>" +
        ((state.result && state.result.model_file) || "—") +
        "</b>" +
        (state.result && state.result.task ? " · " + (state.result.task === "classification" ? "klasifikasi" : "regresi") : "") +
        (state.result && state.result.target ? " · Y: " + state.result.target : "") +
        "</p>" +
        '<div class="row-actions">' +
        '<button type="button" class="btn ghost" id="am-list-models">Segarkan daftar</button>' +
        '<button type="button" class="btn am-primary" id="am-goto-predict">Lanjut ke Prediksi →</button>' +
        '<button type="button" class="btn ghost" id="am-back-train">← Latih model baru</button>' +
        "</div>" +
        '<div id="am-models"></div></section>';
      wireStep7();
      return;
    }

    // Step 8 — Predict (beginner-first UI)
    if (!state.result || !state.result.model_file) {
      host.innerHTML =
        '<section class="feature-box"><h2>Langkah 8 — Prediksi</h2>' +
        '<p class="am-hero">Pilih <b>model tersimpan</b> di bawah. Tidak perlu unggah CSV atau latih ulang.</p>' +
        '<div class="row-actions">' +
        '<button type="button" class="btn ghost" id="am-s8-refresh-models">Segarkan daftar model</button> ' +
        '<button type="button" class="btn ghost" id="am-s8-goto-7">Ke langkah 7</button>' +
        "</div>" +
        '<div id="am-models"></div></section>';
      const b = document.getElementById("am-s8-refresh-models");
      const g7 = document.getElementById("am-s8-goto-7");
      const h = document.getElementById("am-models");
      if (b) b.addEventListener("click", function () { renderSavedModelButtons(h, { goPredict: true }); });
      if (g7) g7.addEventListener("click", function () { setStep(7); });
      renderSavedModelButtons(h, { goPredict: true });
      return;
    }
    ensurePredRows(Math.max(1, state.predRows.length));
    const yName = (state.result && state.result.target) || state.target || "Y";
    const task = (state.result && state.result.task) || state.task || "";
    const nFeat = inputFeatures().length;

    const classNames = (state.result && state.result.class_names) || [];
    const isCls = task === "classification";
    let goalBlock = "";
    if (isCls) {
      const opts = classNames.length
        ? classNames.map((c) => "<option value=\"" + c + "\">" + c + "</option>").join("")
        : "<option value=\"\">(no class list — train again)</option>";
      goalBlock =
        '<div class="am-opt-goal am-opt-cls">' +
        '<p class="micro"><b>Classification goal</b> — pick a class by its <b>original name</b> (not 0/1 codes).</p>' +
        '<label>Class <select id="am-goal-class">' + opts + "</select></label>" +
        '<label class="check-line"><input type="radio" name="am-goal" value="max_class_proba" checked/> Push probability of this class <b>as high as possible</b></label>' +
        '<label class="check-line"><input type="radio" name="am-goal" value="min_class_proba"/> Push probability of this class <b>as low as possible</b></label>' +
        '<label class="check-line"><input type="radio" name="am-goal" value="target"/> Reach probability ≈ <input id="am-goal-target" type="number" min="0" max="1" step="0.01" value="0.8" style="width:80px"/> (0–1)</label>' +
        "</div>";
    } else {
      goalBlock =
        '<div class="am-opt-goal am-opt-reg">' +
        '<p class="micro"><b>Regression goal</b> — ' + yName + ' is a number (physical units).</p>' +
        '<label class="check-line"><input type="radio" name="am-goal" value="minimize" checked/> Minimize predicted ' + yName + "</label>" +
        '<label class="check-line"><input type="radio" name="am-goal" value="maximize"/> Maximize predicted ' + yName + "</label>" +
        '<label class="check-line"><input type="radio" name="am-goal" value="target"/> Reach ' + yName + ' ≈ <input id="am-goal-target" type="number" step="any" style="width:100px"/></label>' +
        "</div>";
    }

    host.innerHTML =
      '<section class="feature-box am-step8">' +
      '<h2>Langkah 8 — Buat prediksi</h2>' +
      '<p class="am-hero">You already trained a model. Now give it <b>inputs (X)</b> and it will fill <b>' + yName + ' (Y)</b> for you. You never type Y.</p>' +
      '<div class="am-s8-meta">' +
      '<span class="automl-badge">Model: ' + ((state.result && state.result.model_file) || "—") + '</span> ' +
      '<span class="automl-badge">Task: ' + task + '</span> ' +
      '<span class="automl-badge">Inputs: ' + nFeat + '</span> ' +
      '<span class="automl-badge">Predicts: ' + yName + '</span>' +
      '</div>' +
      '<label class="am-model-label">Model file <input id="am-model-name" type="text" value="' +
      ((state.result && state.result.model_file) || "") +
      '"/></label>' +

      '<div class="am-s8-grid">' +
      // Card A
      '<div class="am-s8-card" id="am-card-table">' +
      '<div class="am-s8-num">1</div>' +
      '<h3>Type or paste inputs</h3>' +
      '<p class="micro">One row = one case. Paste from Excel (tab or comma). Only input columns are shown — not ' + yName + '.</p>' +
      '<textarea id="am-paste" rows="2" placeholder="Paste Excel / CSV rows here, then Apply paste"></textarea>' +
      '<div class="row-actions">' +
      '<button type="button" class="btn ghost" id="am-apply-paste">Apply paste</button>' +
      '<button type="button" class="btn ghost" id="am-add-row">Add row</button>' +
      '<button type="button" class="btn ghost" id="am-clear-rows">Clear</button>' +
      '</div>' +
      '<div class="table-scroll" id="am-pred-table-wrap"></div>' +
      '<button type="button" class="btn am-primary" id="am-predict">▶ Predict → fill ' + yName + '</button>' +
      '</div>' +

      // Card B
      '<div class="am-s8-card" id="am-card-csv">' +
      '<div class="am-s8-num">2</div>' +
      '<h3>Or upload a CSV of inputs</h3>' +
      '<p class="micro">File must contain the input column names. ' + yName + ' will be added in the result.</p>' +
      '<input id="am-pred-csv" type="file" accept=".csv,text/csv" />' +
      '<button type="button" class="btn am-primary" id="am-predict-csv">▶ Predict from CSV</button>' +
      '</div>' +
      '</div>' +

      '<div class="am-s8-card am-s8-opt" id="am-card-opt">' +
      '<div class="am-s8-num">3</div>' +
      '<h3>Find best inputs (optional)</h3>' +
      '<p class="micro">Model stays fixed. We only search <b>inputs (X)</b>. ' +
      (isCls
        ? "For classification, choose a <b>class name</b> and we maximize/minimize its predicted probability."
        : "For regression, minimize/maximize/hit a numeric " + yName + ".") +
      "</p>" +
      goalBlock +
      '<p class="micro"><b>Which inputs may change?</b> Numerik: isi min/max dari batas proses. ' +
      "Kategorikal (mis. Gender): centang nilai yang boleh dicari (male/female) — bukan angka.</p>" +
      '<div class="table-scroll" id="am-opt-vars"></div>' +
      '<label>Search budget (trials) <input id="am-opt-budget" type="number" min="20" max="500" value="80"/></label>' +
      '<label>Cost strength (0 = ignore cost) <input id="am-opt-cost" type="number" min="0" max="10" step="0.1" value="0"/></label>' +
      '<p class="micro">Cost strength &gt; 0 prefers lower values of inputs that have a cost weight.</p>' +
      '<button type="button" class="btn am-primary" id="am-optimize">▶ Find best inputs</button>' +
      '<div id="am-opt-out"></div>' +
      '</div>' +

      '<div id="am-pred-busy" class="am-busy" hidden>Running prediction…</div>' +
      '<div id="am-pred-out"></div>' +
      '<div class="row-actions" id="am-pred-dl-row" hidden>' +
      '<button type="button" class="btn" id="am-dl-pred">Download results CSV (inputs + ' + yName + ')</button>' +
      '</div>' +
      '</section>';
    renderPredTable();
    renderOptVars();
    wireStep8();
    wireOptimize();
  }

  function renderPredTable() {
    const wrap = document.getElementById("am-pred-table-wrap");
    if (!wrap) return;
    const feats = inputFeatures();
    const yName = (state.result && state.result.target) || state.target || "prediction";
    let html =
      '<table class="automl-table" id="am-pred-table"><thead><tr><th>#</th>' +
      feats
        .map(function (f) {
          const info = featureInfo(f);
          const tip = info.kind === "categorical" ? "kategorikal" : "numerik";
          return (
            "<th title='" +
            escapeAttr(info.reason || tip) +
            "'>" +
            f +
            " <span class='micro'>(" +
            (info.kind === "categorical" ? "kat" : "num") +
            ")</span></th>"
          );
        })
        .join("") +
      "<th class='am-y-col'>" + yName + " <span class='micro'>(Y predicted)</span></th>" +
      "</tr></thead><tbody>";
    state.predRows.forEach((row, ri) => {
      html += "<tr><td>" + (ri + 1) + "</td>";
      feats.forEach((f) => {
        const info = featureInfo(f);
        const cur = row[f] != null ? row[f] : "";
        if (info.kind === "categorical" && info.categories.length) {
          const opts = info.categories
            .map(function (c) {
              const sel = String(c) === String(cur) ? " selected" : "";
              return "<option value=\"" + escapeAttr(c) + "\"" + sel + ">" + escapeAttr(c) + "</option>";
            })
            .join("");
          const extra =
            cur !== "" && !info.categories.some(function (c) { return String(c) === String(cur); })
              ? "<option value=\"" + escapeAttr(cur) + "\" selected>" + escapeAttr(cur) + "</option>"
              : "";
          html +=
            "<td><select data-pr='" +
            ri +
            "' data-pf='" +
            escapeAttr(f) +
            "' style='width:100%;min-width:88px'>" +
            opts +
            extra +
            "</select></td>";
        } else if (info.kind === "categorical") {
          html +=
            "<td><input data-pr='" +
            ri +
            "' data-pf='" +
            escapeAttr(f) +
            "' list='am-dl-" +
            escapeAttr(f) +
            "' value=\"" +
            escapeAttr(cur) +
            '" placeholder="mis. male" style="width:100%;min-width:72px" autocomplete="off"/></td>';
        } else {
          html +=
            "<td><input type='number' step='any' data-pr='" +
            ri +
            "' data-pf='" +
            escapeAttr(f) +
            "' value=\"" +
            escapeAttr(cur) +
            '" style="width:100%;min-width:72px" autocomplete="off"/></td>';
        }
      });
      const pred =
        state.predResults && state.predResults[ri] != null
          ? state.predResults[ri]
          : "—";
      html += "<td class='am-y-col'><b>" + pred + "</b></td>";
      html += "</tr>";
    });
    html += "</tbody></table>";
    // datalists for free-text categoricals (old models without category list)
    feats.forEach(function (f) {
      const info = featureInfo(f);
      if (info.kind === "categorical" && !info.categories.length) return;
      if (info.kind !== "categorical") return;
      // already used <select> when categories exist
    });
    wrap.innerHTML = html;
    wrap.querySelectorAll("input[data-pr], select[data-pr]").forEach((inp) => {
      inp.addEventListener("change", () => {
        const r = Number(inp.getAttribute("data-pr"));
        const f = inp.getAttribute("data-pf");
        state.predRows[r][f] = inp.value;
      });
    });
  }

  function showPreview() {
    const host = document.getElementById("automl-preview");
    if (!host) return;
    const cols = state.columns.map((c) => c.name);
    const rowHtml = (rows) =>
      rows
        .map(
          (r) =>
            "<tr>" +
            cols.map((c) => "<td>" + (r[c] == null ? "" : r[c]) + "</td>").join("") +
            "</tr>"
        )
        .join("");
    host.innerHTML =
      "<p class='micro'>" +
      state.rows +
      " rows × " +
      state.cols +
      " columns" +
      (state.sourceName ? " · source: " + state.sourceName : "") +
      "</p>" +
      '<div class="table-scroll"><table class="automl-table"><thead><tr>' +
      state.columns
        .map((c) => "<th>" + c.name + "<br/><span class='micro'>" + c.type + " · miss " + c.missing + "</span></th>")
        .join("") +
      "</tr></thead><tbody>" +
      rowHtml(state.head) +
      "<tr><td colspan='" +
      cols.length +
      "' style='text-align:center'>…</td></tr>" +
      rowHtml(state.tail) +
      "</tbody></table></div>";
  }

  function applyUploadPayload(data) {
    state.uploadId = data.upload_id || null;
    state.sourceName = data.source_name || data.upload_id || state.sourceName;
    state.columns = data.columns || [];
    state.rows = data.rows;
    state.cols = data.cols;
    state.head = data.head || [];
    state.tail = data.tail || [];
    state.taskManual = false;
    state.forceClassification = false;
    state.target = "";
    state.features = [];
    state.result = null;
    if (!data.local) state.pendingFile = null;
    setStatus("CSV siap: " + state.sourceName + (data.local ? " (pratinjau lokal)" : ""));
    summary();
    showPreview();
  }

  function parseCsvLine(line, sep) {
    const out = [];
    let cur = "";
    let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQ) {
        if (ch === '"') {
          if (line[i + 1] === '"') {
            cur += '"';
            i++;
          } else inQ = false;
        } else cur += ch;
      } else if (ch === '"') inQ = true;
      else if (ch === sep) {
        out.push(cur);
        cur = "";
      } else cur += ch;
    }
    out.push(cur);
    return out;
  }

  function detectCsvSep(headerLine) {
    const counts = { ",": 0, ";": 0, "\t": 0 };
    let inQ = false;
    for (let i = 0; i < headerLine.length; i++) {
      const ch = headerLine[i];
      if (ch === '"') inQ = !inQ;
      else if (!inQ && counts[ch] !== undefined) counts[ch]++;
    }
    let best = ",";
    let n = -1;
    Object.keys(counts).forEach((k) => {
      if (counts[k] > n) {
        n = counts[k];
        best = k;
      }
    });
    return best;
  }

  function parseCsvText(text) {
    const cleaned = String(text || "").replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const lines = cleaned.split("\n").filter((line, idx, arr) => line.length > 0 || idx < arr.length - 1);
    while (lines.length && !String(lines[lines.length - 1]).trim()) lines.pop();
    if (!lines.length) throw new Error("File CSV kosong.");
    const sep = detectCsvSep(lines[0]);
    const headers = parseCsvLine(lines[0], sep).map((h) => String(h || "").replace(/^\uFEFF/, "").trim() || "col");
    const seen = {};
    const names = headers.map((h, i) => {
      let name = h || "col_" + (i + 1);
      if (seen[name]) {
        seen[name] += 1;
        name = name + "_" + seen[name];
      } else seen[name] = 1;
      return name;
    });
    const rows = [];
    for (let r = 1; r < lines.length; r++) {
      if (!String(lines[r]).trim()) continue;
      const cells = parseCsvLine(lines[r], sep);
      const obj = {};
      names.forEach((name, i) => {
        const raw = cells[i] == null ? "" : String(cells[i]).trim();
        if (raw === "") {
          obj[name] = null;
          return;
        }
        const num = Number(raw.replace(",", "."));
        obj[name] = Number.isFinite(num) && /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(raw.replace(",", ".")) ? num : raw;
      });
      rows.push(obj);
    }
    if (!rows.length) throw new Error("CSV tidak punya baris data.");
    const columns = names.map((name) => {
      let missing = 0;
      let numeric = 0;
      let total = 0;
      const seen = new Set();
      const samples = [];
      rows.forEach((row) => {
        const v = row[name];
        if (v == null || v === "") missing += 1;
        else {
          total += 1;
          if (typeof v === "number") numeric += 1;
          seen.add(String(v));
          if (samples.length < 8) samples.push(v);
        }
      });
      const ctype = total && numeric >= total * 0.8 ? "numeric" : "text";
      const nUnique = seen.size;
      const uniqRatio = total ? nUnique / total : 0;
      const col = {
        name,
        type: ctype,
        missing,
        n_unique: nUnique,
        unique_ratio: Math.round(uniqRatio * 10000) / 10000,
        samples,
      };
      // local AutoGluon-style suggestion
      if (ctype !== "numeric") {
        col.suggested_task = "classification";
        col.suggested_reason = "Target teks/kategori → klasifikasi.";
      } else if (nUnique === 2) {
        col.suggested_task = "classification";
        col.suggested_reason = "Tepat 2 nilai unik → klasifikasi biner.";
      } else if (nUnique > 1000) {
        col.suggested_task = "regression";
        col.suggested_reason = "Banyak nilai unik → regresi.";
      } else {
        const thresh = rows.length >= 1000 ? 0.05 : 0.1;
        const intLike = samples.every((v) => typeof v !== "number" || Math.abs(v - Math.round(v)) < 1e-8);
        if (intLike && nUnique <= Math.max(10, Math.floor(rows.length * thresh))) {
          col.suggested_task = "classification";
          col.suggested_reason = nUnique + " kelas bilangan bulat → klasifikasi.";
        } else if (uniqRatio >= thresh && !intLike) {
          col.suggested_task = "regression";
          col.suggested_reason = "Numerik kontinu → regresi.";
        } else if (uniqRatio < thresh) {
          col.suggested_task = "classification";
          col.suggested_reason = "Sedikit nilai unik → klasifikasi.";
        } else {
          col.suggested_task = "regression";
          col.suggested_reason = "Numerik → regresi.";
        }
      }
      return col;
    });
    return {
      ok: true,
      local: true,
      upload_id: null,
      rows: rows.length,
      cols: names.length,
      columns,
      head: rows.slice(0, 5),
      tail: rows.slice(Math.max(0, rows.length - 5)),
      _rows: rows,
    };
  }

  async function loadLocalCsv(file) {
    const text = await file.text();
    const data = parseCsvText(text);
    state.pendingFile = file;
    data.source_name = file.name;
    applyUploadPayload(data);
  }

  async function uploadFileToApi(file) {
    const base = apiBase();
    if (!base) throw new Error("Server API belum aktif. Jalankan Start_Migas.bat lalu buka http://127.0.0.1:5055/");
    const fd = new FormData();
    fd.append("file", file);
    const h = {};
    const t = localStorage.getItem("migas-api-token") || "";
    if (t) h["X-Migas-Token"] = t;
    const res = await fetch(base + "/api/automl/upload", { method: "POST", headers: h, body: fd });
    const raw = await res.text();
    let data = {};
    try {
      data = JSON.parse(raw);
    } catch (e) {
      throw new Error("Upload HTTP " + res.status + " — " + raw.slice(0, 120));
    }
    if (!data.ok) throw new Error(data.error || "Upload gagal");
    data.source_name = file.name;
    state.pendingFile = null;
    applyUploadPayload(data);
    refreshUploadList();
    return data;
  }

  async function ensureServerUpload() {
    if (state.uploadId) return state.uploadId;
    if (state.splitMode === "files" && requiredTrainUploadId()) return requiredTrainUploadId();
    if (state.pendingFile) {
      setStatus("Mengunggah CSV ke server…");
      await uploadFileToApi(state.pendingFile);
      return state.uploadId;
    }
    throw new Error("Belum ada CSV. Unggah atau pilih file dulu.");
  }

  async function probeLocalApi() {
    const banner = document.getElementById("am-api-banner");
    const base = apiBase();
    if (!banner) return;
    if (!base) {
      banner.textContent = "API belum diset. Isi di Pengaturan atau jalankan Start_Migas.bat.";
      return;
    }
    try {
      const res = await fetch(base.replace(/\/$/, "") + "/api/health", { headers: headers(false) });
      const data = await res.json();
      if (res.ok && data && data.ok) {
        banner.className = "am-pred-success";
        banner.innerHTML = "Server lokal aktif: <code>" + base + "</code>. Siap unggah &amp; latih.";
      } else {
        throw new Error((data && data.error) || "Health check gagal");
      }
    } catch (err) {
      banner.className = "am-busy";
      banner.innerHTML =
        "Server lokal belum aktif di <code>" + base + "</code>. " +
        "Double-click <b>Start_Migas.bat</b>, tunggu browser terbuka, lalu klik Segarkan daftar / unggah lagi. " +
        "<span class='micro'>(" + (err && err.message ? err.message : err) + ")</span>";
    }
  }

  async function refreshUploadList() {
    const host = document.getElementById("am-upload-list");
    if (!host) return;
    const base = apiBase();
    if (!base) {
      host.innerHTML = "<p class='micro'>Daftar folder uploads tersedia setelah server lokal aktif (Start_Migas.bat).</p>";
      return;
    }
    try {
      const res = await fetch(base + "/api/automl/uploads", { headers: headers(false) });
      const data = await res.json();
      if (!data.ok) {
        host.innerHTML = "<p class='status'>" + (data.error || "Gagal memuat daftar") + "</p>";
        return;
      }
      state.uploadList = data.files || [];
      if (!state.uploadList.length) {
        host.innerHTML = "<p class='micro'>Belum ada file CSV di folder uploads.</p>";
        return;
      }
      host.innerHTML = state.uploadList
        .map(
          (f) =>
            '<button type="button" class="storage-file" data-up="' +
            f.name +
            '"><strong>' +
            f.name +
            "</strong><span class='micro'>" +
            (f.size / 1024).toFixed(1) +
            " KB · " +
            new Date(f.modified).toLocaleString() +
            "</span></button>"
        )
        .join("");
      host.querySelectorAll("[data-up]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          try {
            setStatus("Memuat " + btn.getAttribute("data-up") + " …");
            const res2 = await fetch(base + "/api/automl/use-upload", {
              method: "POST",
              headers: headers(true),
              body: JSON.stringify({ name: btn.getAttribute("data-up") }),
            });
            const d = await res2.json();
            if (!d.ok) throw new Error(d.error || "Gagal memuat file");
            state.pendingFile = null;
            applyUploadPayload(d);
          } catch (e) {
            setStatus(e.message || String(e));
          }
        });
      });
    } catch (e) {
      host.innerHTML = "<p class='status'>" + (e.message || e) + "</p>";
    }
  }

  function wireUpload() {
    const input = document.getElementById("automl-file");
    const drop = document.getElementById("automl-drop");
    const ref = document.getElementById("am-refresh-uploads");
    if (ref) ref.addEventListener("click", refreshUploadList);
    if (!input || !drop) return;

    const send = async (file) => {
      if (!file) return;
      const name = String(file.name || "").toLowerCase();
      if (name && !name.endsWith(".csv") && file.type && file.type.indexOf("csv") < 0 && file.type !== "text/plain") {
        setStatus("Pilih file CSV (.csv).");
        return;
      }
      setStatus("Membaca " + file.name + "…");
      try {
        if (apiBase()) {
          await uploadFileToApi(file);
        } else {
          await loadLocalCsv(file);
          setStatus("CSV dibaca di browser: " + file.name + ". Untuk melatih, jalankan Start_Migas.bat.");
        }
      } catch (err) {
        try {
          await loadLocalCsv(file);
          setStatus("Upload server gagal, CSV dibaca lokal: " + (err && err.message ? err.message : err));
        } catch (err2) {
          setStatus("Gagal membaca CSV: " + (err2 && err2.message ? err2.message : err2));
        }
      } finally {
        input.value = "";
      }
    };

    input.addEventListener("change", () => {
      const f = input.files && input.files[0];
      if (f) send(f);
    });
    drop.addEventListener("dragenter", (e) => {
      e.preventDefault();
      drop.classList.add("hot");
    });
    drop.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      drop.classList.add("hot");
    });
    drop.addEventListener("dragleave", (e) => {
      if (!drop.contains(e.relatedTarget)) drop.classList.remove("hot");
    });
    drop.addEventListener("drop", (e) => {
      e.preventDefault();
      drop.classList.remove("hot");
      const f = e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) send(f);
    });
  }

  function wireStep2() {
    document.querySelectorAll("[data-y]").forEach((el) => {
      el.addEventListener("change", () => {
        state.target = el.getAttribute("data-y");
        state.features = state.features.filter((f) => f !== state.target);
        state.taskManual = false;
        state.forceClassification = false;
        detectTask();
        render();
        summary();
      });
    });
    document.querySelectorAll("[data-x]").forEach((el) => {
      el.addEventListener("change", () => {
        const name = el.getAttribute("data-x");
        if (el.checked) {
          if (!state.features.includes(name) && name !== state.target) state.features.push(name);
        } else {
          state.features = state.features.filter((f) => f !== name);
        }
        summary();
      });
    });
    document.querySelectorAll('input[name="am-task"]').forEach((el) => {
      el.addEventListener("change", () => {
        if (!el.checked) return;
        state.taskManual = true;
        state.task = el.value;
        state.forceClassification = el.value === "classification";
        state.taskReason = "Dipilih manual.";
        render();
        summary();
      });
    });
    const all = document.getElementById("am-select-all-x");
    if (all)
      all.addEventListener("click", () => {
        state.features = state.columns.map((c) => c.name).filter((n) => n !== state.target);
        render();
        summary();
      });
    const clear = document.getElementById("am-clear-x");
    if (clear)
      clear.addEventListener("click", () => {
        state.features = [];
        render();
        summary();
      });
  }

  function requiredTrainUploadId() {
    return state.trainUploadId || state.uploadId || null;
  }

  async function uploadSplitCsv(file, role) {
    const base = apiBase();
    if (!base) throw new Error("Server API belum aktif. Jalankan Start_Migas.bat.");
    if (!file) throw new Error("Pilih file CSV dulu.");
    setStatus("Mengunggah " + role + " CSV…");
    const fd = new FormData();
    fd.append("file", file);
    const h = headers(false);
    // FormData: jangan set Content-Type manual
    const res = await fetch(base + "/api/automl/upload", { method: "POST", headers: h, body: fd });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "Upload gagal");
    // Validasi kolom vs X/Y terpilih
    const names = (data.columns || []).map(function (c) { return c.name; });
    const need = [state.target].concat(state.features || []).filter(Boolean);
    const missing = need.filter(function (n) { return names.indexOf(n) < 0; });
    if (missing.length) {
      throw new Error(
        "CSV " + role + " tidak punya kolom: " + missing.join(", ") +
          ". Samakan nama kolom dengan X/Y langkah 2."
      );
    }
    const meta = { rows: data.rows, cols: data.cols };
    if (role === "train") {
      state.trainUploadId = data.upload_id;
      state.trainFileName = file.name;
      state.trainMeta = meta;
    } else {
      state.testUploadId = data.upload_id;
      state.testFileName = file.name;
      state.testMeta = meta;
    }
    setStatus(
      "CSV " + role + " siap: " + file.name + " (" + meta.rows + " baris). Kolom X/Y cocok."
    );
    render();
    summary();
  }

  function wireStep3() {
    document.querySelectorAll('input[name="am-split-mode"]').forEach(function (el) {
      el.addEventListener("change", function () {
        state.splitMode = el.value === "files" ? "files" : "auto";
        render();
      });
    });
    const ts = document.getElementById("am-test-size");
    const seed = document.getElementById("am-seed");
    if (ts)
      ts.addEventListener("change", () => {
        state.testSize = Math.min(0.5, Math.max(0.05, Number(ts.value) || 0.2));
      });
    if (seed)
      seed.addEventListener("change", () => {
        state.randomState = Number(seed.value) || 42;
      });
    const trainInp = document.getElementById("am-train-file");
    const testInp = document.getElementById("am-test-file");
    if (trainInp) {
      trainInp.addEventListener("change", async function () {
        try {
          await uploadSplitCsv(trainInp.files && trainInp.files[0], "train");
        } catch (err) {
          setStatus(err.message || String(err));
        }
      });
    }
    if (testInp) {
      testInp.addEventListener("change", async function () {
        try {
          await uploadSplitCsv(testInp.files && testInp.files[0], "test");
        } catch (err) {
          setStatus(err.message || String(err));
        }
      });
    }
    const use1 = document.getElementById("am-train-use-step1");
    if (use1) {
      use1.addEventListener("click", function () {
        if (!state.uploadId) {
          setStatus("Belum ada CSV di langkah 1.");
          return;
        }
        state.trainUploadId = state.uploadId;
        state.trainFileName = state.sourceName || state.uploadId;
        state.trainMeta = { rows: state.rows, cols: state.cols };
        setStatus("Train memakai file langkah 1.");
        render();
      });
    }
  }

  function wireStep4() {
    document.querySelectorAll("[data-model]").forEach((el) => {
      el.addEventListener("change", () => {
        const m = el.getAttribute("data-model");
        if (el.checked) {
          if (!state.models.includes(m)) state.models.push(m);
        } else state.models = state.models.filter((x) => x !== m);
      });
    });
    const def = document.getElementById("am-models-default");
    if (def)
      def.addEventListener("click", () => {
        state.models = ["LightGBM", "CatBoost", "RandomForest"];
        render();
      });
    const safe = document.getElementById("am-models-safe");
    if (safe)
      safe.addEventListener("click", () => {
        state.models = ["LightGBM", "CatBoost", "RandomForest", "ExtraTrees"];
        render();
      });
    const all = document.getElementById("am-models-all");
    if (all)
      all.addEventListener("click", () => {
        state.models = ["LightGBM", "CatBoost", "RandomForest", "ExtraTrees", "XGBoost", "LinearModel", "KNeighbors", "MLP"];
        render();
      });
  }

  function wireStep5() {
    const start = document.getElementById("am-start");
    const cancel = document.getElementById("am-cancel");
    const logEl = document.getElementById("am-log");
    const timeout = document.getElementById("am-timeout");
    if (start)
      start.addEventListener("click", async () => {
        const base = apiBase();
        if (!base) return setStatus("Server API belum aktif. Jalankan Start_Migas.bat.");
        try {
          await ensureServerUpload();
        } catch (err) {
          return setStatus(err.message || String(err));
        }
        if (!state.target || !state.features.length) return setStatus("Pilih Y dan minimal satu X.");
        state.timeout = Number((timeout && timeout.value) || state.timeout);
        setStatus("Memulai training…");
        const res = await fetch(base + "/api/automl/train", {
          method: "POST",
          headers: headers(true),
          body: JSON.stringify({
            upload_id:
              state.splitMode === "files"
                ? requiredTrainUploadId() || state.uploadId
                : state.uploadId,
            target: state.target,
            features: state.features,
            task: state.task,
            test_size: state.testSize,
            random_state: state.randomState,
            timeout: state.timeout,
            models_names: state.models,
            force_classification: state.task === "classification" && state.forceClassification,
            split_mode: state.splitMode === "files" ? "files" : "auto",
            train_upload_id:
              state.splitMode === "files" ? requiredTrainUploadId() : null,
            test_upload_id: state.splitMode === "files" ? state.testUploadId : null,
          }),
        });
        const data = await res.json();
        if (!data.ok) return setStatus(data.error || "Train failed to start");
        state.jobId = data.job_id;
        setStatus("Job " + state.jobId + " running…");
        pollJob(logEl);
      });
    if (cancel)
      cancel.addEventListener("click", async () => {
        if (!state.jobId) return;
        const base = apiBase();
        await fetch(base + "/api/automl/jobs/" + state.jobId + "/cancel", { method: "POST", headers: headers(false) });
        setStatus("Cancel requested.");
      });
  }

  function pollJob(logEl) {
    if (state.pollTimer) clearInterval(state.pollTimer);
    state.pollTimer = setInterval(async () => {
      try {
        const base = apiBase();
        const res = await fetch(base + "/api/automl/jobs/" + state.jobId, { headers: headers(false) });
        const data = await res.json();
        if (!data.ok) return;
        const job = data.job;
        if (logEl) logEl.textContent = (job.log || []).slice(-60).join("\n");
        setStatus("Status: " + job.status + " (" + (job.progress || 0) + "%)");
        if (job.status === "done") {
          clearInterval(state.pollTimer);
          state.result = job.result;
          if (state.result && state.result.features) state.features = state.result.features;
          if (state.result && state.result.target) state.target = state.result.target;
          setStatus("Training finished.");
          setStep(6);
        } else if (job.status === "error" || job.status === "cancelled") {
          clearInterval(state.pollTimer);
          setStatus(job.error || job.status);
        }
      } catch (e) {
        /* keep polling */
      }
    }, 2000);
  }

  async function renderSavedModelButtons(host, opts) {
    opts = opts || {};
    if (!host) return;
    const base = apiBase();
    if (!base) {
      host.innerHTML = "<p class='micro'>Nyalakan server (Start_Migas.bat) untuk melihat model tersimpan.</p>";
      return;
    }
    try {
      const res = await fetch(base + "/api/models", { headers: headers(false) });
      const data = await res.json();
      if (!data.ok) {
        host.innerHTML = "<p class='status'>" + (data.error || "Gagal memuat model") + "</p>";
        return;
      }
      const files = data.files || [];
      if (!files.length) {
        host.innerHTML =
          "<p class='micro'>Belum ada model. Latih sekali lewat langkah 1–6, lalu model muncul di sini.</p>";
        return;
      }
      host.innerHTML =
        "<p class='micro'>Klik model untuk memuat" +
        (opts.goPredict ? " dan lanjut prediksi" : "") +
        " — <b>tanpa latih ulang</b>.</p>" +
        files
          .map(function (f) {
            return (
              '<button type="button" class="storage-file am-model-pick" data-model="' +
              f.name +
              '"><strong>' +
              f.name +
              "</strong><span class='micro'>" +
              (f.task === "classification" ? "klasifikasi" : f.task === "regression" ? "regresi" : f.task || "") +
              (f.target ? " · Y: " + f.target : "") +
              " · " +
              (f.created || f.modified || "") +
              "</span></button>"
            );
          })
          .join("");
      host.querySelectorAll("[data-model]").forEach(function (btn) {
        btn.addEventListener("click", async function () {
          try {
            setStatus("Memuat model " + btn.getAttribute("data-model") + " …");
            await loadModelForPredict(btn.getAttribute("data-model"));
            setStatus("Model dimuat: " + btn.getAttribute("data-model"));
            setStep(opts.goPredict ? 8 : 7);
          } catch (e) {
            setStatus(e.message || String(e));
          }
        });
      });
    } catch (e) {
      host.innerHTML = "<p class='status'>" + (e.message || e) + "</p>";
    }
  }

  function wireHomeModelShortcut() {
    const j7 = document.getElementById("am-jump-7");
    const j8 = document.getElementById("am-jump-8");
    const ref = document.getElementById("am-refresh-saved-models");
    const host = document.getElementById("am-saved-models-home");
    if (j7) j7.addEventListener("click", function () { setStep(7); });
    if (j8) {
      j8.addEventListener("click", function () {
        if (state.result && state.result.model_file) setStep(8);
        else setStep(7);
      });
    }
    if (ref) ref.addEventListener("click", function () { renderSavedModelButtons(host, { goPredict: true }); });
    renderSavedModelButtons(host, { goPredict: true });
  }

  function wireStep7() {
    const btn = document.getElementById("am-list-models");
    const host = document.getElementById("am-models");
    const goPred = document.getElementById("am-goto-predict");
    const backTrain = document.getElementById("am-back-train");
    if (goPred && !goPred._wired) {
      goPred._wired = true;
      goPred.addEventListener("click", () => {
        if (!state.result || !state.result.model_file) {
          setStatus("Pilih model di daftar dulu.");
          return;
        }
        setStep(8);
      });
    }
    if (backTrain && !backTrain._wired) {
      backTrain._wired = true;
      backTrain.addEventListener("click", function () {
        setStep(1);
      });
    }
    async function refreshModels() {
      await renderSavedModelButtons(host, { goPredict: false });
    }
    if (btn && !btn._wired) {
      btn._wired = true;
      btn.addEventListener("click", refreshModels);
    }
    refreshModels();
  }


  function renderOptVars() {
    const host = document.getElementById("am-opt-vars");
    if (!host) return;
    const feats = inputFeatures();
    let html =
      "<table class='automl-table'><thead><tr>" +
      "<th>Use</th><th>Input (X)</th><th>Jenis</th><th>Batas / nilai</th><th>Cost weight</th>" +
      "</tr></thead><tbody>";
    let rows = 0;
    feats.forEach((f) => {
      const info = featureInfo(f);
      rows += 1;
      if (info.kind === "categorical") {
        const cats = info.categories.length ? info.categories : [];
        let valuesCell;
        if (cats.length) {
          valuesCell =
            "<div class='am-cat-choices' data-opt-type='categorical' data-opt-name='" +
            escapeAttr(f) +
            "'>" +
            cats
              .map(function (c) {
                return (
                  "<label class='check-line'><input type='checkbox' data-opt-cat='" +
                  escapeAttr(f) +
                  "' value=\"" +
                  escapeAttr(c) +
                  "\" checked/> " +
                  escapeAttr(c) +
                  "</label>"
                );
              })
              .join("") +
            "</div>";
        } else {
          valuesCell =
            "<input type='text' data-opt-cat-free='" +
            escapeAttr(f) +
            "' placeholder='male, female' style='width:180px' title='Pisahkan dengan koma'/>";
        }
        html +=
          "<tr>" +
          "<td><input type='checkbox' data-opt-en='" + escapeAttr(f) + "' data-opt-kind='categorical' checked/></td>" +
          "<td>" + escapeAttr(f) + "</td>" +
          "<td><span class='automl-badge'>kategorikal</span></td>" +
          "<td>" + valuesCell + "</td>" +
          "<td><input type='number' step='any' min='0' data-opt-cw='" + escapeAttr(f) + "' value='0' style='width:70px' disabled title='Cost hanya untuk numerik'/></td>" +
          "</tr>";
      } else {
        html +=
          "<tr>" +
          "<td><input type='checkbox' data-opt-en='" + escapeAttr(f) + "' data-opt-kind='numeric' checked/></td>" +
          "<td>" + escapeAttr(f) + "</td>" +
          "<td><span class='automl-badge'>numerik</span></td>" +
          "<td>" +
          "Min <input type='number' step='any' data-opt-min='" + escapeAttr(f) + "' value='" + info.min + "' style='width:90px'/> " +
          "Max <input type='number' step='any' data-opt-max='" + escapeAttr(f) + "' value='" + info.max + "' style='width:90px'/>" +
          "</td>" +
          "<td><input type='number' step='any' min='0' data-opt-cw='" + escapeAttr(f) + "' value='0' style='width:70px'/></td>" +
          "</tr>";
      }
    });
    html += "</tbody></table>";
    host.innerHTML = rows
      ? html
      : "<p class='micro'>Tidak ada input yang bisa dioptimasi.</p>";
  }

  function wireOptimize() {
    const btn = document.getElementById("am-optimize");
    if (!btn || btn._wired) return;
    btn._wired = true;
    btn.addEventListener("click", async () => {
      const base = apiBase();
      const model = (document.getElementById("am-model-name") || {}).value || "";
      const goalEl = document.querySelector("input[name='am-goal']:checked");
      const goal = goalEl ? goalEl.value : "minimize";
      const targetVal = document.getElementById("am-goal-target");
      const budget = Number((document.getElementById("am-opt-budget") || {}).value || 80);
      const costStrength = Number((document.getElementById("am-opt-cost") || {}).value || 0);
      const variables = [];
      const cost_weights = {};
      const fixed = {};
      const baseRow = (state.predRows && state.predRows[0]) || {};
      document.querySelectorAll("[data-opt-en]").forEach((en) => {
        const f = en.getAttribute("data-opt-en");
        const kind = en.getAttribute("data-opt-kind") || featureInfo(f).kind;
        const cwEl = document.querySelector("[data-opt-cw='" + f + "']");
        cost_weights[f] = Number(cwEl && cwEl.value) || 0;
        if (!en.checked) {
          const info = featureInfo(f);
          let fv = baseRow[f];
          if (fv === undefined || fv === "") fv = info.default;
          fixed[f] = fv;
          variables.push({ name: f, enabled: false, type: kind });
          return;
        }
        if (kind === "categorical") {
          let choices = [];
          document.querySelectorAll("[data-opt-cat='" + f + "']").forEach(function (cb) {
            if (cb.checked) choices.push(cb.value);
          });
          const freeEl = document.querySelector("[data-opt-cat-free='" + f + "']");
          if (freeEl && freeEl.value.trim()) {
            choices = freeEl.value.split(/[,;|]/).map(function (s) { return s.trim(); }).filter(Boolean);
          }
          if (!choices.length) {
            const info = featureInfo(f);
            choices = info.categories.slice();
          }
          variables.push({ name: f, enabled: true, type: "categorical", choices: choices });
        } else {
          const minEl = document.querySelector("[data-opt-min='" + f + "']");
          const maxEl = document.querySelector("[data-opt-max='" + f + "']");
          variables.push({
            name: f,
            enabled: true,
            type: "numeric",
            min: Number(minEl && minEl.value),
            max: Number(maxEl && maxEl.value),
          });
        }
      });
      const out = document.getElementById("am-opt-out");
      const busy = document.getElementById("am-pred-busy");
      if (busy) {
        busy.hidden = false;
        busy.textContent = "Searching best inputs…";
      }
      setStatus("Optimizing inputs…");
      try {
        const res = await fetch(base + "/api/automl/optimize-inputs", {
          method: "POST",
          headers: headers(true),
          body: JSON.stringify({
            model_name: model.trim(),
            goal: goal,
            target_value: targetVal && targetVal.value !== "" ? Number(targetVal.value) : null,
            class_name: (document.getElementById("am-goal-class") || {}).value || null,
            budget: budget,
            variables: variables,
            cost_weights: cost_weights,
            cost_strength: costStrength,
            fixed: fixed,
          }),
        });
        const data = await res.json();
        if (!data.ok) {
          if (out) out.innerHTML = "<p class='status'>" + (data.error || "Failed") + "</p>";
          setStatus(data.error || "Optimize failed");
          return;
        }
        // fill first pred row with best inputs + show predicted y
        const feats = inputFeatures();
        const row = {};
        const src = data.best_inputs_full || data.best_inputs || {};
        feats.forEach((f) => {
          row[f] = src[f] != null ? src[f] : "";
        });
        state.predRows = [row];
        var showY = data.predicted_y;
        if (data.predicted_display && data.predicted_display.probability != null) {
          showY = data.predicted_display.class + " (" + Number(data.predicted_display.probability).toFixed(3) + ")";
        }
        state.predResults = [showY];
        renderPredTable();
        if (out) {
          var disp = data.predicted_display;
          var summary;
          if (disp && typeof disp === "object") {
            summary =
              "<b>Class: " + (disp.class || disp.pred_label || "—") +
              "</b> · probability <b>" +
              (disp.probability != null ? Number(disp.probability).toFixed(4) : data.predicted_y) +
              "</b>";
          } else {
            summary = "<b>Best predicted " + (data.target_name || "Y") + " = " + data.predicted_y + "</b>";
          }
          out.innerHTML =
            "<div class='am-pred-success'>" +
            summary + "<br/>" +
            "Engine: " + data.engine + " · trials: " + data.budget +
            (data.class_name ? " · focus class: <b>" + data.class_name + "</b>" : "") +
            "<br/>" +
            "<pre class='automl-log' style='max-height:140px'>" +
            JSON.stringify(data.best_inputs, null, 2) +
            "</pre>" +
            "<span class='micro'>Best inputs copied into the table (row 1). Y column shows the focus probability/score.</span>" +
            "</div>";
        }
        setStatus("Optimization done.");
      } catch (e) {
        setStatus("Optimize error: " + (e.message || e));
      } finally {
        if (busy) {
          busy.hidden = true;
          busy.textContent = "Running prediction…";
        }
      }
    });
  }

  function wireStep8() {
    document.querySelectorAll(".am-tab").forEach((tab) => {
      tab.addEventListener("click", () => {
        document.querySelectorAll(".am-tab").forEach((t) => t.classList.remove("on"));
        tab.classList.add("on");
        const which = tab.getAttribute("data-ptab");
        document.getElementById("am-ptab-table").hidden = which !== "table";
        document.getElementById("am-ptab-csv").hidden = which !== "csv";
      });
    });
    const paste = document.getElementById("am-apply-paste");
    if (paste)
      paste.addEventListener("click", () => {
        const t = document.getElementById("am-paste").value;
        const rows = parsePaste(t);
        if (!rows.length) return setStatus("Paste is empty or could not be parsed.");
        state.predRows = rows;
        state.predResults = null;
        renderPredTable();
        setStatus("Loaded " + rows.length + " row(s) from paste.");
      });
    const add = document.getElementById("am-add-row");
    if (add)
      add.addEventListener("click", () => {
        ensurePredRows(state.predRows.length + 1);
        state.predResults = null;
        renderPredTable();
      });
    const clr = document.getElementById("am-clear-rows");
    if (clr)
      clr.addEventListener("click", () => {
        state.predRows = [];
        state.predResults = null;
        ensurePredRows(1);
        renderPredTable();
      });
    const proba = document.getElementById("am-include-proba");
    if (proba)
      proba.addEventListener("change", () => {
        state.predIncludeProba = proba.checked;
      });

    const runPredict = async (rows) => {
      const base = apiBase();
      const model = document.getElementById("am-model-name").value.trim();
      const busy = document.getElementById("am-pred-busy");
      const out = document.getElementById("am-pred-out");
      const feats = inputFeatures();
      const y = (state.result && state.result.target) || state.target;
      // strip Y from every row before send
      const clean = rows.map((r) => {
        const o = {};
        feats.forEach((f) => {
          o[f] = r[f];
        });
        return o;
      });
      if (busy) busy.hidden = false;
      setStatus("Predicting…");
      const t0 = Date.now();
      try {
        const res = await fetch(base + "/api/automl/predict", {
          method: "POST",
          headers: headers(true),
          body: JSON.stringify({ model_name: model, rows: clean }),
        });
        const data = await res.json();
        if (!data.ok) {
          if (out) out.innerHTML = "<p class='status'>" + (data.error || "Predict failed") + "</p>";
          setStatus(data.error || "Predict failed");
          return;
        }
        state.predResults = data.predictions || [];
        renderPredTable();
        const ms = Date.now() - t0;
        if (out) {
          out.innerHTML =
            "<div class='am-pred-success'><b>Done in " + ms + " ms.</b> " +
            "Column <b>" + (y || "Y") + "</b> is the model output (not something you type).</div>";
        }
        const dlRow = document.getElementById("am-pred-dl-row");
        if (dlRow) dlRow.hidden = false;
        state._lastPredBundle = { rows: clean, data: data };
        setStatus("Prediction ready (" + state.predResults.length + " rows).");
      } catch (e) {
        setStatus("Predict error: " + (e.message || e));
      } finally {
        if (busy) busy.hidden = true;
      }
    };

    const btn = document.getElementById("am-predict");
    if (btn)
      btn.addEventListener("click", async () => {
        // sync inputs
        document.querySelectorAll("input[data-pr]").forEach((inp) => {
          const r = Number(inp.getAttribute("data-pr"));
          const f = inp.getAttribute("data-pf");
          state.predRows[r][f] = inp.value;
        });
        await runPredict(state.predRows);
      });

    const csvBtn = document.getElementById("am-predict-csv");
    const csvInput = document.getElementById("am-pred-csv");
    if (csvBtn && csvInput)
      csvBtn.addEventListener("click", async () => {
        const f = csvInput.files && csvInput.files[0];
        if (!f) return setStatus("Choose a CSV file first.");
        const text = await f.text();
        const rows = parsePaste(text);
        if (!rows.length) return setStatus("CSV has no usable rows.");
        state.predRows = rows;
        state.predResults = null;
        renderPredTable();
        await runPredict(rows);
      });

    const dl = document.getElementById("am-dl-pred");
    if (dl)
      dl.addEventListener("click", () => {
        const bundle = state._lastPredBundle;
        if (!bundle) return;
        const feats = inputFeatures();
        const yName = (state.result && state.result.target) || state.target || "prediction";
        const lines = [];
        const header = feats.concat([yName]);
        if (state.predIncludeProba && bundle.data.probabilities) {
          const cn = bundle.data.class_names || [];
          cn.forEach((c) => header.push("proba_" + c));
        }
        lines.push(header.join(","));
        bundle.rows.forEach((row, i) => {
          const cells = feats.map((f) => {
            const v = row[f];
            const s = v == null ? "" : String(v);
            return s.indexOf(",") >= 0 ? '"' + s + '"' : s;
          });
          cells.push(bundle.data.predictions[i]);
          if (state.predIncludeProba && bundle.data.probabilities) {
            (bundle.data.probabilities[i] || []).forEach((p) => cells.push(p));
          }
          lines.push(cells.join(","));
        });
        const blob = new Blob([lines.join("\n")], { type: "text/csv" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = "predictions.csv";
        a.click();
      });
  }

  function canNext() {
    if (state.step === 1) return !!(state.uploadId || state.pendingFile || (state.columns && state.columns.length));
    if (state.step === 2) return !!state.target && state.features.length > 0;
    if (state.step === 3) {
      if (state.splitMode !== "files") return true;
      return !!(requiredTrainUploadId() && state.testUploadId);
    }
    if (state.step === 4) return state.models.length > 0;
    if (state.step === 5) return !!state.result;
    return true;
  }

  function canJumpToStep(s) {
    if (s === 7 || s === 8) return true;
    if (s <= state.step) return true;
    if (state.result && state.result.model_file && s >= 7) return true;
    return false;
  }

  function bind() {
    const next = document.getElementById("automl-next");
    const back = document.getElementById("automl-back");
    if (next)
      next.addEventListener("click", async () => {
        if (state.step === 3) {
          const ts = document.getElementById("am-test-size");
          const seed = document.getElementById("am-seed");
          if (ts) state.testSize = Number(ts.value) || 0.2;
          if (seed) state.randomState = Number(seed.value) || 42;
        }
        if (!canNext()) {
          if (state.step === 3 && state.splitMode === "files") {
            setStatus("Mode file: unggah train (atau pakai langkah 1) dan test CSV dulu.");
          } else {
            setStatus("Lengkapi langkah ini sebelum lanjut.");
          }
          return;
        }
        if (state.step === 1 && state.pendingFile && apiBase() && !state.uploadId) {
          try {
            await ensureServerUpload();
          } catch (err) {
            setStatus(err.message || String(err));
            return;
          }
        }
        setStep(state.step + 1);
      });
    if (back) back.addEventListener("click", () => setStep(state.step - 1));
    const tab = document.getElementById("tab-automl");
    if (tab) tab.addEventListener("click", () => setStep(state.step));
    const stepList = document.getElementById("automl-step-list");
    if (stepList && !stepList._wiredJump) {
      stepList._wiredJump = true;
      stepList.addEventListener("click", function (ev) {
        const li = ev.target.closest("li[data-step]");
        if (!li) return;
        const s = Number(li.getAttribute("data-step"));
        if (!canJumpToStep(s)) {
          if (s < 7) setStatus("Lengkapi langkah berurutan, atau lompat ke langkah 7 jika sudah punya model.");
          return;
        }
        setStep(s);
      });
      stepList.addEventListener("keydown", function (ev) {
        if (ev.key !== "Enter" && ev.key !== " ") return;
        const li = ev.target.closest("li[data-step]");
        if (!li) return;
        ev.preventDefault();
        const s = Number(li.getAttribute("data-step"));
        if (canJumpToStep(s)) setStep(s);
      });
    }
  }

  window.MigasAutoML = {
    snapshot() {
      return {
        step: state.step,
        uploadId: state.uploadId,
        sourceName: state.sourceName,
        target: state.target,
        features: state.features,
        task: state.task,
        resultMeta: state.result
          ? {
              best_model_name: state.result.best_model_name,
              model_file: state.result.model_file,
              scores: state.result.scores,
              task: state.result.task,
            }
          : null,
      };
    },
    load(data) {
      if (!data) return;
      state.step = data.step || 1;
      state.target = data.target || "";
      state.features = data.features || [];
      state.task = data.task || "regression";
      state.sourceName = data.sourceName || null;
    },
  };

  document.addEventListener("DOMContentLoaded", () => {
    bind();
    setStep(1);
  });
})();
