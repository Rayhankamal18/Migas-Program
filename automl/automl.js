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
    forceClassification: false,
    testSize: 0.2,
    randomState: 42,
    timeout: 300,
    models: ["LightGBM", "XGBoost", "LinearModel"],
    jobId: null,
    result: null,
    pollTimer: null,
    uploadList: [],
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
    return "";
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
    if (!state.uploadId) {
      el.textContent = "No CSV loaded yet.";
      return;
    }
    el.innerHTML =
      "File: <b>" + (state.sourceName || state.uploadId) + "</b><br/>" +
      "Rows: <b>" + state.rows + "</b><br/>" +
      "Columns: <b>" + state.cols + "</b><br/>" +
      "Target (Y): <b>" + (state.target || "—") + "</b><br/>" +
      "Inputs (X): <b>" + (state.features.length || 0) + "</b><br/>" +
      "Task: <b>" + state.task + "</b><br/>" +
      "Timeout: <b>" + state.timeout + "s</b>";
  }

  function setStep(n) {
    state.step = Math.max(1, Math.min(8, n));
    document.querySelectorAll("#automl-step-list li").forEach((li) => {
      const s = Number(li.getAttribute("data-step"));
      li.classList.toggle("on", s === state.step);
      li.classList.toggle("done", s < state.step);
    });
    const prog = document.getElementById("automl-progress");
    if (prog) prog.textContent = "Step " + state.step + " of 8";
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
    };
    state.target = state.result.target;
    state.features = (state.result.features || []).filter((f) => f !== state.target);
    state.task = state.result.task;
    state.predRows = [];
    state.predResults = null;
    setStatus("Loaded model " + state.result.model_file + " — go to Predict without retraining.");
    summary();
    return state.result;
  }

  function inputFeatures() {
    // X only — never the target Y
    const y = (state.result && state.result.target) || state.target || "";
    let feats = [];
    if (state.result && Array.isArray(state.result.features)) feats = state.result.features.slice();
    else if (state.features && state.features.length) feats = state.features.slice();
    return feats.filter((f) => f && f !== y);
  }

  function detectTask() {
    const col = state.columns.find((c) => c.name === state.target);
    if (!col) {
      state.task = "regression";
      return;
    }
    if (state.forceClassification) state.task = "classification";
    else state.task = col.type === "numeric" ? "regression" : "classification";
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

  function drawBarChart(canvas, labels, values, opts) {
    opts = opts || {};
    const ctx = canvas.getContext("2d");
    const W = canvas.width, H = canvas.height;
    const pad = { l: 48, r: 16, t: 24, b: 48 };
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, W, H);
    const maxV = Math.max(...values.map(Number), 1e-9);
    const n = labels.length;
    const gap = 8;
    const barW = Math.max(8, (W - pad.l - pad.r - gap * n) / n);
    ctx.strokeStyle = "#cbd5e1";
    ctx.beginPath();
    ctx.moveTo(pad.l, pad.t);
    ctx.lineTo(pad.l, H - pad.b);
    ctx.lineTo(W - pad.r, H - pad.b);
    ctx.stroke();
    values.forEach((v, i) => {
      const h = ((H - pad.t - pad.b) * Number(v)) / maxV;
      const x = pad.l + gap + i * (barW + gap);
      const y = H - pad.b - h;
      ctx.fillStyle = opts.colors && opts.colors[i] ? opts.colors[i] : "#2563eb";
      ctx.fillRect(x, y, barW, h);
      ctx.fillStyle = "#334155";
      ctx.font = "11px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(String(labels[i]).slice(0, 12), x + barW / 2, H - pad.b + 14);
      ctx.fillText(Number(v).toFixed(3), x + barW / 2, y - 4);
    });
  }

  function drawScatter(canvas, xs, ys, opts) {
    opts = opts || {};
    const ctx = canvas.getContext("2d");
    const W = canvas.width, H = canvas.height;
    const pad = { l: 48, r: 16, t: 16, b: 40 };
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, W, H);
    const all = xs.concat(ys);
    let min = Math.min(...all), max = Math.max(...all);
    if (min === max) { min -= 1; max += 1; }
    const sx = (v) => pad.l + ((v - min) / (max - min)) * (W - pad.l - pad.r);
    const sy = (v) => H - pad.b - ((v - min) / (max - min)) * (H - pad.t - pad.b);
    ctx.strokeStyle = "#e2e8f0";
    ctx.beginPath();
    ctx.moveTo(pad.l, H - pad.b);
    ctx.lineTo(W - pad.r, H - pad.b);
    ctx.moveTo(pad.l, pad.t);
    ctx.lineTo(pad.l, H - pad.b);
    ctx.stroke();
    if (opts.diag) {
      ctx.strokeStyle = "#94a3b8";
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(sx(min), sy(min));
      ctx.lineTo(sx(max), sy(max));
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.fillStyle = "#2563eb";
    for (let i = 0; i < xs.length; i++) {
      ctx.beginPath();
      ctx.arc(sx(xs[i]), sy(ys[i]), 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function drawHeatmap(canvas, matrix, rowLabels, colLabels) {
    const ctx = canvas.getContext("2d");
    const W = canvas.width, H = canvas.height;
    const pad = { l: 60, r: 16, t: 24, b: 40 };
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
      ctx.fillText(String(rowLabels[i] || i).slice(0, 10), pad.l - 6, pad.t + i * ch + ch / 2 + 4);
    }
    ctx.textAlign = "center";
    for (let j = 0; j < cols; j++) {
      ctx.fillText(String(colLabels[j] || j).slice(0, 10), pad.l + j * cw + cw / 2, H - pad.b + 14);
    }
  }

  function drawCurve(canvas, series, xKey, yKey, opts) {
    // series: [{name, x:[], y:[], auc?}]
    opts = opts || {};
    const ctx = canvas.getContext("2d");
    const W = canvas.width, H = canvas.height;
    const pad = { l: 44, r: 12, t: 16, b: 36 };
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
      ctx.beginPath();
      for (let i = 0; i < xs.length; i++) {
        const x = pad.l + xs[i] * (W - pad.l - pad.r);
        const y = H - pad.b - ys[i] * (H - pad.t - pad.b);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    });
    // legend
    ctx.font = "11px sans-serif";
    series.forEach((s, si) => {
      ctx.fillStyle = colors[si % colors.length];
      const label = (s.class || s.name || "") + (s.auc != null ? " AUC=" + Number(s.auc).toFixed(3) : "");
      ctx.fillText(label, pad.l + 8, pad.t + 12 + si * 14);
    });
  }

function drawLineSeries(canvas, seriesList, opts) {
    // seriesList: [{name, values: number[]}]
    opts = opts || {};
    const ctx = canvas.getContext("2d");
    const W = canvas.width, H = canvas.height;
    const pad = { l: 48, r: 16, t: 16, b: 32 };
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
      ctx.beginPath();
      s.values.forEach((v, i) => {
        const x = sx(i), y = sy(v);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
    });
  }

  function buildResultPlots(host, r) {
    host.innerHTML = "";
    const scores = r.scores || {};
    const task = r.task || state.task;

    // header metrics
    const head = document.createElement("div");
    head.className = "feature-box";
    head.innerHTML =
      "<h2>Step 6 — Results</h2>" +
      "<p><b>Best model:</b> " + (r.best_model_name || "—") + "</p>" +
      "<p><b>Metric:</b> " + (r.metric || "—") + "</p>" +
      "<p><b>Parameters:</b></p><pre class='automl-log' style='max-height:120px'>" +
      JSON.stringify(r.best_model_param || {}, null, 2) +
      "</pre>" +
      "<p><b>Scores:</b></p><pre class='automl-log' style='max-height:180px'>" +
      JSON.stringify(
        Object.fromEntries(Object.entries(scores).filter(([, v]) => typeof v !== "object")),
        null,
        2
      ) +
      "</pre>";
    host.appendChild(head);

    const plotsHost = document.createElement("div");
    plotsHost.className = "am-plots";
    host.appendChild(plotsHost);

    const yTrue = r.y_test || [];
    const yPred = r.y_pred_test || [];

    if (task === "classification") {
      // accuracy train/test bars
      if (scores.accuracy_train != null || scores.accuracy_test != null) {
        const c = makeCanvas(420, 240);
        drawBarChart(
          c,
          ["Train acc", "Test acc"],
          [scores.accuracy_train || 0, scores.accuracy_test || 0]
        );
        plotsHost.appendChild(
          plotBox("Accuracy train vs test", "Compare train and test accuracy to spot overfitting.", c)
        );
      }
      // confusion matrix
      if (scores.confusion_matrix) {
        const cm = scores.confusion_matrix;
        const labels = r.class_names || cm.map((_, i) => String(i));
        const c = makeCanvas(Math.max(320, labels.length * 64 + 80), Math.max(280, labels.length * 48 + 80));
        drawHeatmap(c, cm, labels, labels);
        plotsHost.appendChild(
          plotBox("Confusion matrix", "Rows = actual class, columns = predicted class. Darker = more samples.", c)
        );
      }
      // classification report table
      if (scores.classification_report) {
        const rep = scores.classification_report;
        const tbl = document.createElement("div");
        tbl.className = "feature-box";
        let html = "<h3>Classification report</h3><div class='table-scroll'><table class='automl-table'><thead><tr><th>Class</th><th>Precision</th><th>Recall</th><th>F1</th><th>Support</th></tr></thead><tbody>";
        Object.keys(rep).forEach((k) => {
          const row = rep[k];
          if (!row || typeof row !== "object" || row.precision == null) return;
          html +=
            "<tr><td>" +
            k +
            "</td><td>" +
            Number(row.precision).toFixed(3) +
            "</td><td>" +
            Number(row.recall).toFixed(3) +
            "</td><td>" +
            Number(row["f1-score"]).toFixed(3) +
            "</td><td>" +
            (row.support != null ? row.support : "") +
            "</td></tr>";
        });
        html += "</tbody></table></div>";
        tbl.innerHTML = html;
        plotsHost.appendChild(tbl);
      }

      // ROC / PR from worker plots (sklearn.metrics.roc_curve on model scores)
      const plots = r.plots || {};
      if (plots.roc_curves && plots.roc_curves.length) {
        const c = makeCanvas(440, 320);
        drawCurve(c, plots.roc_curves, "fpr", "tpr", { diag: true });
        plotsHost.appendChild(
          plotBox("ROC curve (one-vs-rest)", "From model scores via sklearn.metrics.roc_curve. Dashed line = random.", c)
        );
      }
      if (plots.pr_curves && plots.pr_curves.length) {
        const c = makeCanvas(440, 320);
        drawCurve(
          c,
          plots.pr_curves.map(function (s) {
            return { class: s.class, fpr: s.recall, tpr: s.precision, auc: null };
          }),
          "fpr",
          "tpr",
          { diag: false }
        );
        plotsHost.appendChild(
          plotBox("Precision–Recall curve", "Useful when classes are imbalanced. X = recall, Y = precision.", c)
        );
      }
      if (plots.feature_importance && plots.feature_importance.length) {
        const top = plots.feature_importance.slice(0, 20);
        const c = makeCanvas(480, Math.max(240, top.length * 18 + 40));
        drawBarChart(
          c,
          top.map(function (x) { return String(x.feature).slice(0, 14); }),
          top.map(function (x) { return x.importance; })
        );
        plotsHost.appendChild(
          plotBox(
            "Feature importance",
            "From the fitted model when the library/model exposes importances (gain / model attribute).",
            c
          )
        );
      }

      // class counts actual vs predicted
      if (yTrue.length && yPred.length) {
        const labels = r.class_names || Array.from(new Set(yTrue.concat(yPred)));
        const act = labels.map((l) => yTrue.filter((x) => String(x) === String(l)).length);
        const pred = labels.map((l) => yPred.filter((x) => String(x) === String(l)).length);
        const c = makeCanvas(480, 260);
        // simple side-by-side: draw actual only with labels
        drawBarChart(c, labels.map((l) => "A:" + String(l).slice(0, 6)), act);
        plotsHost.appendChild(plotBox("Actual class counts", "How many test samples belong to each true class.", c));
        const c2 = makeCanvas(480, 260);
        drawBarChart(c2, labels.map((l) => "P:" + String(l).slice(0, 6)), pred, {
          colors: labels.map(() => "#16a34a"),
        });
        plotsHost.appendChild(plotBox("Predicted class counts", "How many test samples the model assigned to each class.", c2));
      }
    } else {
      // regression plots
      const yt = yTrue.map(Number);
      const yp = yPred.map(Number);
      if (yt.length && yp.length) {
        const c = makeCanvas(420, 320);
        drawScatter(c, yt, yp, { diag: true });
        plotsHost.appendChild(
          plotBox(
            "Actual vs predicted",
            "Each point is a test sample. The dashed line is perfect prediction. R² = " +
              (scores.r2_test != null ? Number(scores.r2_test).toFixed(4) : "—"),
            c
          )
        );
        const c2 = makeCanvas(520, 260);
        drawLineSeries(c2, [
          { name: "actual", values: yt.slice(0, 200) },
          { name: "predicted", values: yp.slice(0, 200) },
        ]);
        plotsHost.appendChild(
          plotBox("Test vs predicted by sample", "Blue = actual, red = predicted (first 200 test rows).", c2)
        );
        const resid = yt.map((v, i) => v - yp[i]);
        const c3 = makeCanvas(420, 320);
        drawScatter(c3, yp, resid, { diag: false });
        plotsHost.appendChild(
          plotBox("Residuals vs predicted", "Residuals should scatter around zero without a clear pattern.", c3)
        );
        // residual histogram (simple bins)
        const c4 = makeCanvas(420, 240);
        const bins = 12;
        let rmin = Math.min(...resid), rmax = Math.max(...resid);
        if (rmin === rmax) { rmin -= 1; rmax += 1; }
        const counts = Array(bins).fill(0);
        resid.forEach((v) => {
          let b = Math.floor(((v - rmin) / (rmax - rmin)) * bins);
          if (b >= bins) b = bins - 1;
          if (b < 0) b = 0;
          counts[b]++;
        });
        drawBarChart(
          c4,
          counts.map((_, i) => String(i)),
          counts
        );
        plotsHost.appendChild(plotBox("Residual distribution", "Histogram of prediction errors on the test set.", c4));
      }
      if (scores.r2_train != null || scores.r2_test != null) {
        const c = makeCanvas(360, 220);
        drawBarChart(c, ["R² train", "R² test"], [scores.r2_train || 0, scores.r2_test || 0]);
        plotsHost.appendChild(plotBox("Train vs test R²", "Overfitting check for regression.", c));
      }
    }

    // optimization history if present
    if (Array.isArray(r.history) && r.history.length) {
      const vals = r.history.map((t) => (t.value != null ? Number(t.value) : NaN)).filter((v) => isFinite(v));
      if (vals.length) {
        const c = makeCanvas(480, 220);
        drawLineSeries(c, [{ name: "score", values: vals }]);
        plotsHost.appendChild(plotBox("Optimization history", "Score for each trial (higher or lower depends on metric).", c));
      }
    }

    const zipBtn = document.createElement("button");
    zipBtn.type = "button";
    zipBtn.className = "btn";
    zipBtn.textContent = "Download all plot canvases (one by one PNG)";
    zipBtn.onclick = () => {
      plotsHost.querySelectorAll("canvas").forEach((cv, i) => {
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
      feats.forEach((f) => (o[f] = ""));
      state.predRows.push(o);
    }
    // strip target from existing rows if present
    const y = (state.result && state.result.target) || state.target;
    state.predRows.forEach((row) => {
      if (y && Object.prototype.hasOwnProperty.call(row, y)) delete row[y];
      feats.forEach((f) => {
        if (row[f] === undefined) row[f] = "";
      });
    });
  }

  function render() {
    const host = document.getElementById("automl-step-panel");
    if (!host) return;

    if (state.step === 1) {
      host.innerHTML =
        '<section class="feature-box"><h2>Step 1 — Import CSV</h2>' +
        '<p class="micro">Upload a new file, or pick one already saved in the app uploads folder (<code>migas_data/uploads</code>).</p>' +
        '<div class="row-actions">' +
        '<label class="dropzone" id="automl-drop"><strong>Drop CSV here or click to upload</strong>' +
        '<input id="automl-file" type="file" accept=".csv,text/csv" hidden /></label>' +
        '</div>' +
        '<h3>Files already on this PC (uploads folder)</h3>' +
        '<div class="row-actions"><button type="button" class="btn ghost" id="am-refresh-uploads">Refresh list</button></div>' +
        '<div id="am-upload-list" class="storage-file-list"></div>' +
        '<div id="automl-preview"></div></section>';
      wireUpload();
      refreshUploadList();
      if (state.head.length) showPreview();
      return;
    }

    if (state.step === 2) {
      detectTask();
      host.innerHTML =
        '<section class="feature-box"><h2>Step 2 — Choose target (Y) and inputs (X)</h2>' +
        '<p class="micro">Exactly one Y. Any number of X. Task is detected automatically.</p>' +
        '<div class="row-actions"><button type="button" class="btn ghost" id="am-select-all-x">Select all as X</button>' +
        '<button type="button" class="btn ghost" id="am-clear-x">Clear</button></div>' +
        '<p><span class="automl-badge">Task: ' + state.task + "</span></p>" +
        (state.task === "regression"
          ? '<label class="check-line"><input type="checkbox" id="am-force-cls" /> Treat numeric Y as Classification</label>'
          : "") +
        '<div class="table-scroll"><table class="automl-table"><thead><tr><th>X</th><th>Y</th><th>Column</th><th>Type</th><th>Missing</th></tr></thead><tbody>' +
        state.columns
          .map((c) => {
            const isY = state.target === c.name;
            const isX = state.features.includes(c.name);
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
              c.missing +
              "</td></tr>"
            );
          })
          .join("") +
        "</tbody></table></div></section>";
      wireStep2();
      return;
    }

    if (state.step === 3) {
      host.innerHTML =
        '<section class="feature-box"><h2>Step 3 — Feature engineering (DataPrepare)</h2>' +
        '<p class="micro">Uses AutoML-Alex <code>DataPrepare.fit_transform</code> on train and <code>transform</code> on test during training.</p>' +
        '<label>Test size <input id="am-test-size" type="number" min="0.05" max="0.5" step="0.05" value="' +
        state.testSize +
        '"/></label>' +
        '<label>Random seed <input id="am-seed" type="number" value="' +
        state.randomState +
        '"/></label>' +
        '<details class="fold"><summary>Advanced</summary>' +
        '<p class="micro">Interaction features are turned off by default for speed and RAM. Defaults work without changes.</p></details>' +
        "</section>";
      return;
    }

    if (state.step === 4) {
      const models = ["LightGBM", "XGBoost", "LinearModel", "CatBoost", "RandomForest", "ExtraTrees", "KNeighbors"];
      host.innerHTML =
        '<section class="feature-box"><h2>Step 4 — Choose models (BestSingleModel)</h2>' +
        '<p class="micro">Classification uses BestSingleModelClassifier; regression uses BestSingleModelRegressor. Multiclass uses LightGBM when needed.</p>' +
        '<div class="row-actions"><button type="button" class="btn ghost" id="am-models-all">Select all</button></div>' +
        models
          .map((m) => {
            const on = state.models.includes(m);
            return (
              "<label class='check-line'><input type='checkbox' data-model='" +
              m +
              "' " +
              (on ? "checked" : "") +
              "/> " +
              m +
              "</label>"
            );
          })
          .join("") +
        "</section>";
      wireStep4();
      return;
    }

    if (state.step === 5) {
      host.innerHTML =
        '<section class="feature-box"><h2>Step 5 — Optimization (model.opt)</h2>' +
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
        '<section class="feature-box"><h2>Step 7 — Save / load model</h2>' +
        '<p class="micro">Models are stored in <code>migas_data/ml_model/</code>. After training once, <b>load a model here and jump to Predict</b> — you do not need to retrain.</p>' +
        "<p>Active model: <b>" +
        ((state.result && state.result.model_file) || "—") +
        "</b>" +
        (state.result && state.result.task ? " · task: " + state.result.task : "") +
        (state.result && state.result.target ? " · Y: " + state.result.target : "") +
        "</p>" +
        '<div class="row-actions">' +
        '<button type="button" class="btn ghost" id="am-list-models">Refresh list</button>' +
        '<button type="button" class="btn" id="am-goto-predict">Go to Predict →</button>' +
        "</div>" +
        '<div id="am-models"></div></section>';
      wireStep7();
      return;
    }

    // Step 8 — Predict (beginner-first UI)
    if (!state.result || !state.result.model_file) {
      host.innerHTML =
        '<section class="feature-box"><h2>Step 8 — Predict</h2>' +
        '<p class="am-hero">Load a <b>saved model</b> first. No need to retrain if you already finished Step 6 once.</p>' +
        '<button type="button" class="btn" id="am-s8-refresh-models">Show saved models</button>' +
        '<div id="am-models"></div>' +
        '<p class="micro">Or go to Step 7. After you click a model, this page will unlock.</p></section>';
      const b = document.getElementById("am-s8-refresh-models");
      if (b) {
        b.addEventListener("click", () => {
          // reuse step 7 list wiring
          setStep(7);
        });
      }
      // still allow listing here
      (async () => {
        try {
          const base = apiBase();
          const res = await fetch(base + "/api/models", { headers: headers(false) });
          const data = await res.json();
          const h = document.getElementById("am-models");
          if (!h || !data.ok) return;
          h.innerHTML = (data.files || [])
            .map(
              (f) =>
                '<button type="button" class="storage-file" data-model="' +
                f.name +
                '"><strong>' +
                f.name +
                "</strong></button>"
            )
            .join("") || "<p class='micro'>No saved models.</p>";
          h.querySelectorAll("[data-model]").forEach((btn) => {
            btn.addEventListener("click", async () => {
              await loadModelForPredict(btn.getAttribute("data-model"));
              setStep(8);
            });
          });
        } catch (e) {}
      })();
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
      '<h2>Step 8 — Get a prediction</h2>' +
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
      '<p class="micro"><b>Which inputs may change?</b> Set min and max from your process limits.</p>' +
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
      feats.map((f) => "<th title='Input'>" + f + " <span class='micro'>(X)</span></th>").join("") +
      "<th class='am-y-col'>" + yName + " <span class='micro'>(Y predicted)</span></th>" +
      "</tr></thead><tbody>";
    state.predRows.forEach((row, ri) => {
      html += "<tr><td>" + (ri + 1) + "</td>";
      feats.forEach((f) => {
        html +=
          "<td><input data-pr='" +
          ri +
          "' data-pf='" +
          f +
          "' value=\"" +
          String(row[f] != null ? row[f] : "").replace(/"/g, "&quot;") +
          '" style="width:100%;min-width:72px" autocomplete="off"/></td>';
      });
      const pred =
        state.predResults && state.predResults[ri] != null
          ? state.predResults[ri]
          : "—";
      html += "<td class='am-y-col'><b>" + pred + "</b></td>";
      html += "</tr>";
    });
    html += "</tbody></table>";
    wrap.innerHTML = html;
    wrap.querySelectorAll("input[data-pr]").forEach((inp) => {
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
    state.uploadId = data.upload_id;
    state.sourceName = data.source_name || data.upload_id;
    state.columns = data.columns || [];
    state.rows = data.rows;
    state.cols = data.cols;
    state.head = data.head || [];
    state.tail = data.tail || [];
    setStatus("CSV ready: " + state.sourceName);
    summary();
    showPreview();
  }

  async function refreshUploadList() {
    const host = document.getElementById("am-upload-list");
    if (!host) return;
    const base = apiBase();
    if (!base) {
      host.innerHTML = "<p class='micro'>API not available.</p>";
      return;
    }
    try {
      const res = await fetch(base + "/api/automl/uploads", { headers: headers(false) });
      const data = await res.json();
      if (!data.ok) {
        host.innerHTML = "<p class='status'>" + (data.error || "Failed") + "</p>";
        return;
      }
      state.uploadList = data.files || [];
      if (!state.uploadList.length) {
        host.innerHTML = "<p class='micro'>No CSV files in uploads folder yet.</p>";
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
            setStatus("Loading " + btn.getAttribute("data-up") + " …");
            const res2 = await fetch(base + "/api/automl/use-upload", {
              method: "POST",
              headers: headers(true),
              body: JSON.stringify({ name: btn.getAttribute("data-up") }),
            });
            const d = await res2.json();
            if (!d.ok) throw new Error(d.error || "Failed");
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
      const base = apiBase();
      if (!base) {
        setStatus("Open via the app URL (not file://) or set API base in Settings.");
        return;
      }
      const fd = new FormData();
      fd.append("file", file);
      setStatus("Uploading…");
      try {
        const h = {};
        const t = localStorage.getItem("migas-api-token") || "";
        if (t) h["X-Migas-Token"] = t;
        const res = await fetch(base + "/api/automl/upload", { method: "POST", headers: h, body: fd });
        const raw = await res.text();
        let data = {};
        try {
          data = JSON.parse(raw);
        } catch (e) {
          setStatus("Upload HTTP " + res.status + " — " + raw.slice(0, 120));
          return;
        }
        if (!data.ok) {
          setStatus(data.error || "Upload failed");
          return;
        }
        data.source_name = file.name;
        applyUploadPayload(data);
        refreshUploadList();
      } catch (err) {
        setStatus("Upload failed: " + (err && err.message));
      }
    };
    input.addEventListener("change", () => {
      const f = input.files && input.files[0];
      if (f) send(f);
    });
    drop.addEventListener("click", () => input.click());
    drop.addEventListener("dragover", (e) => e.preventDefault());
    drop.addEventListener("drop", (e) => {
      e.preventDefault();
      const f = e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) send(f);
    });
  }

  function wireStep2() {
    document.querySelectorAll("[data-y]").forEach((el) => {
      el.addEventListener("change", () => {
        state.target = el.getAttribute("data-y");
        state.features = state.features.filter((f) => f !== state.target);
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
    const force = document.getElementById("am-force-cls");
    if (force)
      force.addEventListener("change", () => {
        state.forceClassification = force.checked;
        detectTask();
        render();
        summary();
      });
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
    const all = document.getElementById("am-models-all");
    if (all)
      all.addEventListener("click", () => {
        state.models = ["LightGBM", "XGBoost", "LinearModel", "CatBoost", "RandomForest", "ExtraTrees", "KNeighbors"];
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
        if (!base) return setStatus("Set API base URL in Settings.");
        if (!state.uploadId) return setStatus("Upload or pick a CSV first.");
        if (!state.target || !state.features.length) return setStatus("Choose Y and at least one X.");
        state.timeout = Number((timeout && timeout.value) || state.timeout);
        setStatus("Starting training…");
        const res = await fetch(base + "/api/automl/train", {
          method: "POST",
          headers: headers(true),
          body: JSON.stringify({
            upload_id: state.uploadId,
            target: state.target,
            features: state.features,
            task: state.task,
            test_size: state.testSize,
            random_state: state.randomState,
            timeout: state.timeout,
            models_names: state.models,
            force_classification: state.forceClassification,
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

  function wireStep7() {
    const btn = document.getElementById("am-list-models");
    const host = document.getElementById("am-models");
    const goPred = document.getElementById("am-goto-predict");
    if (goPred && !goPred._wired) {
      goPred._wired = true;
      goPred.addEventListener("click", () => {
        if (!state.result || !state.result.model_file) {
          setStatus("Load a saved model first (click one in the list).");
          return;
        }
        setStep(8);
      });
    }
    async function refreshModels() {
      const base = apiBase();
      const res = await fetch(base + "/api/models", { headers: headers(false) });
      const data = await res.json();
      if (!host) return;
      if (!data.ok) {
        host.textContent = data.error || "Failed";
        return;
      }
      const files = data.files || [];
      if (!files.length) {
        host.innerHTML = "<p class='micro'>No models yet. Train once in Steps 1–6, then you can reuse models here.</p>";
        return;
      }
      host.innerHTML =
        "<p class='micro'>Click a model to load it for prediction — <b>no retraining</b>.</p>" +
        files
          .map(
            (f) =>
              '<button type="button" class="storage-file am-model-pick" data-model="' +
              f.name +
              '"><strong>' +
              f.name +
              "</strong><span class='micro'>" +
              (f.task || "") +
              " · " +
              (f.created || f.modified || "") +
              "</span></button>"
          )
          .join("");
      host.querySelectorAll("[data-model]").forEach((b) => {
        b.addEventListener("click", async () => {
          try {
            setStatus("Loading model…");
            await loadModelForPredict(b.getAttribute("data-model"));
            b.classList.add("on");
            setStatus("Model ready. Click “Go to Predict” or open Step 8.");
          } catch (e) {
            setStatus(e.message || String(e));
          }
        });
      });
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
    // guess numeric from training columns meta
    const meta = {};
    (state.columns || []).forEach((c) => { meta[c.name] = c; });
    let html = "<table class='automl-table'><thead><tr><th>Use</th><th>Input (X)</th><th>Min</th><th>Max</th><th>Cost weight</th></tr></thead><tbody>";
    feats.forEach((f) => {
      const isNum = !meta[f] || meta[f].type === "numeric";
      if (!isNum) return; // only numeric searchable
      html +=
        "<tr>" +
        "<td><input type='checkbox' data-opt-en='" + f + "' checked/></td>" +
        "<td>" + f + "</td>" +
        "<td><input type='number' step='any' data-opt-min='" + f + "' value='0' style='width:90px'/></td>" +
        "<td><input type='number' step='any' data-opt-max='" + f + "' value='100' style='width:90px'/></td>" +
        "<td><input type='number' step='any' min='0' data-opt-cw='" + f + "' value='0' style='width:70px'/></td>" +
        "</tr>";
    });
    html += "</tbody></table>";
    host.innerHTML = html || "<p class='micro'>No numeric inputs available to optimize.</p>";
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
      document.querySelectorAll("[data-opt-en]").forEach((en) => {
        const f = en.getAttribute("data-opt-en");
        const minEl = document.querySelector("[data-opt-min='" + f + "']");
        const maxEl = document.querySelector("[data-opt-max='" + f + "']");
        const cwEl = document.querySelector("[data-opt-cw='" + f + "']");
        variables.push({
          name: f,
          enabled: en.checked,
          min: Number(minEl && minEl.value),
          max: Number(maxEl && maxEl.value),
        });
        cost_weights[f] = Number(cwEl && cwEl.value) || 0;
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
            fixed: {},
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
        feats.forEach((f) => {
          row[f] = data.best_inputs && data.best_inputs[f] != null ? data.best_inputs[f] : "";
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
    if (state.step === 1) return !!state.uploadId;
    if (state.step === 2) return !!state.target && state.features.length > 0;
    if (state.step === 4) return state.models.length > 0;
    if (state.step === 5) return !!state.result;
    return true;
  }

  function bind() {
    const next = document.getElementById("automl-next");
    const back = document.getElementById("automl-back");
    if (next)
      next.addEventListener("click", () => {
        if (state.step === 3) {
          const ts = document.getElementById("am-test-size");
          const seed = document.getElementById("am-seed");
          if (ts) state.testSize = Number(ts.value) || 0.2;
          if (seed) state.randomState = Number(seed.value) || 42;
        }
        if (!canNext()) {
          setStatus("Complete this step before continuing.");
          return;
        }
        setStep(state.step + 1);
      });
    if (back) back.addEventListener("click", () => setStep(state.step - 1));
    const tab = document.getElementById("tab-automl");
    if (tab) tab.addEventListener("click", () => setStep(state.step));
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
