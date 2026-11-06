(function () {
  const SETTINGS_KEY = "migas-ai-settings-v1";
  const CACHE_KEY = "migas-ai-cache-v1";

  const DEFAULTS = {
    provider: "demo",
    model: "demo-local",
    apiKey: "",
    endpoint: "",
    vpsUrl: ""
  };

  const PROVIDER_ENDPOINTS = {
    demo: "",
    openai: "https://api.openai.com/v1/chat/completions",
    openrouter: "https://openrouter.ai/api/v1/chat/completions",
    deepseek: "https://api.deepseek.com/chat/completions",
    grok: "https://api.x.ai/v1/chat/completions",
    custom: ""
  };

  const PROVIDER_MODELS = {
    demo: "demo-local",
    openai: "gpt-4o-mini",
    openrouter: "openai/gpt-4o-mini",
    deepseek: "deepseek-chat",
    grok: "grok-2-latest",
    custom: ""
  };

  let settings = loadSettingsLocal();
  let cache = loadCache();

  function loadSettingsLocal() {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (!raw) return Object.assign({}, DEFAULTS);
      const loaded = Object.assign({}, DEFAULTS, JSON.parse(raw));
      // Belum punya key → default ke Demo supaya Generate bisa diuji
      if (!loaded.apiKey && loaded.provider !== "demo" && loaded.provider !== "custom") {
        loaded.provider = "demo";
        loaded.model = "demo-local";
      }
      return loaded;
    } catch (e) {
      return Object.assign({}, DEFAULTS);
    }
  }

  function saveSettingsLocal() {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  }

  function loadCache() {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      return raw ? JSON.parse(raw) : { summaries: {}, casingSuggestion: null };
    } catch (e) {
      return { summaries: {}, casingSuggestion: null };
    }
  }

  function saveCache() {
    localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
  }

  /**
   * Penjual API memberi base URL (…/v1). Permintaan chat harus ke …/chat/completions.
   * URL yang sudah berakhiran /chat/completions dipakai apa adanya.
   */
  function normalizeChatEndpoint(raw) {
    let url = String(raw || "").trim().replace(/\s+/g, "");
    if (!url) return "";
    url = url.replace(/\/+$/, "");
    if (/\/chat\/completions$/i.test(url)) return url;
    try {
      const parsed = new URL(url);
      let path = (parsed.pathname || "").replace(/\/+$/, "");
      if (!path) path = "/v1";
      parsed.pathname = path + "/chat/completions";
      parsed.hash = "";
      return parsed.toString();
    } catch (e) {
      return url + "/chat/completions";
    }
  }

  function endpointFor() {
    const explicit = settings.endpoint && settings.endpoint.trim();
    const raw = explicit || PROVIDER_ENDPOINTS[settings.provider] || PROVIDER_ENDPOINTS.openai;
    return normalizeChatEndpoint(raw);
  }

  function setStatus(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text || "";
  }

  function collectProjectSnapshot() {
    const snap = {
      casing: window.CasingSetting && window.CasingSetting.snapshot ? window.CasingSetting.snapshot() : null,
      drilling: window.DrillingSummary && window.DrillingSummary.snapshot ? window.DrillingSummary.snapshot() : null,
      azimuth: window.AzimuthChart && window.AzimuthChart.snapshot ? window.AzimuthChart.snapshot() : null,
      boxplot: window.BoxWhisker && window.BoxWhisker.snapshot ? window.BoxWhisker.snapshot() : null
    };
    return snap;
  }

  function wellNamesFromSnapshot(snap) {
    const names = new Set();
    if (snap.casing && Array.isArray(snap.casing.wells)) {
      snap.casing.wells.forEach((w) => { if (w.name) names.add(w.name); });
    }
    if (snap.drilling) {
      if (Array.isArray(snap.drilling.wells)) {
        snap.drilling.wells.forEach((w) => { if (w.name) names.add(w.name); });
      } else if (snap.drilling.well) {
        names.add(snap.drilling.well);
      }
    }
    return Array.from(names);
  }

  function renderWellPicks() {
    const host = document.getElementById("ai-well-picks");
    if (!host) return;
    const snap = collectProjectSnapshot();
    const names = wellNamesFromSnapshot(snap);
    if (!names.length) {
      host.innerHTML = '<p class="micro">Belum ada sumur di proyek.</p>';
      return;
    }
    host.innerHTML = names.map((name) => {
      return '<label class="check-line"><input type="checkbox" data-ai-well="' +
        name.replace(/"/g, "&quot;") + '" checked /> ' + name + "</label>";
    }).join("");
  }

  function selectedWellNames() {
    const mode = (document.getElementById("ai-summary-mode") || {}).value || "one";
    const boxes = Array.from(document.querySelectorAll("#ai-well-picks input[data-ai-well]"));
    if (mode === "all") return boxes.map((b) => b.getAttribute("data-ai-well"));
    if (mode === "selected") return boxes.filter((b) => b.checked).map((b) => b.getAttribute("data-ai-well"));
    // one = first checked or first
    const checked = boxes.filter((b) => b.checked);
    if (checked.length) return [checked[0].getAttribute("data-ai-well")];
    return boxes[0] ? [boxes[0].getAttribute("data-ai-well")] : [];
  }

  function renderSummaryResults() {
    const host = document.getElementById("ai-summary-results");
    if (!host) return;
    const keys = Object.keys(cache.summaries || {});
    if (!keys.length) {
      host.innerHTML = '<div class="empty-state"><strong>Belum ada ringkasan</strong><span>Generate dari panel kiri untuk melihat hasil di sini.</span></div>';
      return;
    }
    host.innerHTML = keys.map((k) => {
      const item = cache.summaries[k];
      return '<article class="ai-card"><h3>' + k + '</h3><p>' + (item.text || "") +
        '</p><p class="micro">Disimpan: ' + (item.savedAt || "") + "</p></article>";
    }).join("");
  }

  function escHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function uidLocal() {
    return "ai-" + Math.random().toString(36).slice(2, 10);
  }

  function numOrNull(value) {
    if (value == null || value === "") return null;
    const n = Number(String(value).replace(",", "."));
    return Number.isFinite(n) ? n : null;
  }

  function ensureCasingDraftShape(item) {
    if (!item || typeof item !== "object") return null;
    const unit = item.unit === "m" ? "m" : "ft";
    const casings = Array.isArray(item.casings)
      ? item.casings.map(function (c, i) {
          const shoeTvd = numOrNull(c.shoeTvd != null ? c.shoeTvd : c.tvd);
          let shoeMd = numOrNull(c.shoeMd != null ? c.shoeMd : c.md);
          if (shoeMd == null && shoeTvd != null) shoeMd = shoeTvd;
          return {
            id: c.id || uidLocal(),
            name: (c.name || ("Casing " + (i + 1))).trim(),
            shoeMd: shoeMd,
            shoeTvd: shoeTvd,
            kind: c.kind === "liner" ? "liner" : "casing",
            topTvd: numOrNull(c.topTvd),
            style: c.style === "openhole" || c.style === "perforated" ? c.style : "solid",
            reason: String(c.reason || "").trim()
          };
        })
      : [];
    return {
      wellName: (item.wellName || item.name || "Proposed well").trim(),
      text: item.text || item.summary || "",
      savedAt: item.savedAt || new Date().toISOString(),
      unit: unit,
      tdMd: numOrNull(item.tdMd),
      tdTvd: numOrNull(item.tdTvd),
      color: item.color || "#F2D11A",
      includeOffsets: item.includeOffsets !== false,
      casings: casings
    };
  }

  function parseCasingProposal(rawText, fallbackName, unit) {
    const blob = tryParseJsonBlob(rawText);
    if (blob) {
      const draft = ensureCasingDraftShape({
        wellName: blob.wellName || blob.proposedWell || fallbackName,
        text: blob.summary || blob.text || "",
        unit: blob.unit || unit,
        tdMd: blob.tdMd,
        tdTvd: blob.tdTvd,
        casings: blob.casings || blob.shoes || []
      });
      if (draft && draft.casings.length) {
        if (!draft.text) draft.text = String(rawText || "").trim();
        return draft;
      }
    }
    // Fallback: parse "1. name @ 1234" lines from prose
    const shoes = [];
    String(rawText || "").split(/\r?\n/).forEach(function (line) {
      const m = line.match(/^\s*\d+[\).\]]\s*(.+?)\s*@\s*([\d.,]+)/i)
        || line.match(/^\s*[-*]\s*(.+?)\s*@\s*([\d.,]+)/i);
      if (!m) return;
      const tvd = numOrNull(m[2]);
      if (tvd == null) return;
      shoes.push({
        name: m[1].replace(/\s*\(.*\)\s*$/, "").trim(),
        shoeTvd: tvd,
        shoeMd: tvd,
        kind: "casing",
        reason: "Diambil dari daftar usulan AI; validasi ulang terhadap offset wells."
      });
    });
    if (!shoes.length) return null;
    return ensureCasingDraftShape({
      wellName: fallbackName,
      text: String(rawText || "").trim(),
      unit: unit,
      casings: shoes
    });
  }

  function buildPreviewData() {
    const draft = ensureCasingDraftShape(cache.casingSuggestion);
    if (!draft) return null;
    const snap = (window.CasingSetting && window.CasingSetting.snapshot)
      ? window.CasingSetting.snapshot()
      : { formations: [], wells: [], unit: "ft", title: "", endLabel: "End of Well" };
    const proposed = {
      id: "ai-proposed",
      name: draft.wellName,
      color: draft.color || "#F2D11A",
      tdMd: draft.tdMd,
      tdTvd: draft.tdTvd,
      selected: true,
      casings: draft.casings.map(function (c) {
        return {
          id: c.id,
          name: c.name,
          shoeMd: c.shoeMd,
          shoeTvd: c.shoeTvd,
          kind: c.kind,
          topTvd: c.topTvd,
          style: c.style
        };
      }),
      pp: [],
      fg: []
    };
    const offsets = draft.includeOffsets
      ? (snap.wells || [])
          .filter(function (w) {
            return ((w.name || "").trim().toLowerCase() !== draft.wellName.toLowerCase());
          })
          .map(function (w) {
            return Object.assign({}, w, { selected: true });
          })
      : [];
    return {
      title: "Usulan casing: " + draft.wellName,
      unit: draft.unit || snap.unit || "ft",
      decimalComma: !!snap.decimalComma,
      tvdMax: snap.tvdMax,
      endLabel: snap.endLabel || "End of Well",
      formations: snap.formations || [],
      wells: offsets.concat([proposed]),
      viewMode: "selected",
      showPpfg: false
    };
  }

  function redrawAiCasingPreview() {
    const canvas = document.getElementById("ai-csg-chart");
    if (!canvas || !window.CasingSetting || !window.CasingSetting.renderPreview) return;
    const data = buildPreviewData();
    if (!data) return;
    try {
      window.CasingSetting.renderPreview(canvas, data, { viewMode: "selected", scale: 2, showPpfg: false });
      // Fit canvas CSS width to container
      const sheet = document.getElementById("ai-csg-sheet");
      if (sheet && canvas.width && canvas.height) {
        const avail = Math.max(280, sheet.clientWidth - 16);
        const cssW = Math.min(avail, canvas.width / 2);
        canvas.style.width = cssW + "px";
        canvas.style.height = (canvas.height / canvas.width) * cssW + "px";
      }
    } catch (err) {
      setStatus("ai-casing-status", "Pratinjau gagal: " + (err.message || err));
    }
  }

  function readDraftFromDom() {
    const draft = ensureCasingDraftShape(cache.casingSuggestion);
    if (!draft) return null;
    const nameEl = document.getElementById("ai-csg-name");
    const tdMdEl = document.getElementById("ai-csg-td-md");
    const tdTvdEl = document.getElementById("ai-csg-td-tvd");
    const offsetEl = document.getElementById("ai-csg-include-offsets");
    if (nameEl) draft.wellName = nameEl.value.trim() || draft.wellName;
    if (tdMdEl) draft.tdMd = numOrNull(tdMdEl.value);
    if (tdTvdEl) draft.tdTvd = numOrNull(tdTvdEl.value);
    if (offsetEl) draft.includeOffsets = !!offsetEl.checked;
    const rows = Array.from(document.querySelectorAll("#ai-csg-rows .ai-csg-row"));
    draft.casings = rows.map(function (row, i) {
      const shoeTvd = numOrNull((row.querySelector('[data-f="shoeTvd"]') || {}).value);
      let shoeMd = numOrNull((row.querySelector('[data-f="shoeMd"]') || {}).value);
      if (shoeMd == null && shoeTvd != null) shoeMd = shoeTvd;
      return {
        id: row.getAttribute("data-id") || uidLocal(),
        name: ((row.querySelector('[data-f="name"]') || {}).value || ("Casing " + (i + 1))).trim(),
        shoeMd: shoeMd,
        shoeTvd: shoeTvd,
        kind: ((row.querySelector('[data-f="kind"]') || {}).value || "casing") === "liner" ? "liner" : "casing",
        topTvd: numOrNull((row.querySelector('[data-f="topTvd"]') || {}).value),
        style: "solid",
        reason: ((row.querySelector('[data-f="reason"]') || {}).value || "").trim()
      };
    });
    return draft;
  }

  function persistDraftFromDom() {
    const draft = readDraftFromDom();
    if (!draft) return null;
    draft.savedAt = (cache.casingSuggestion && cache.casingSuggestion.savedAt) || new Date().toISOString();
    draft.text = (cache.casingSuggestion && cache.casingSuggestion.text) || draft.text;
    cache.casingSuggestion = draft;
    saveCache();
    return draft;
  }

  function casingRowHtml(c, unit) {
    const u = unit || "ft";
    return (
      '<div class="ai-csg-row" data-id="' + escHtml(c.id) + '">' +
        '<div class="ai-csg-row-main">' +
          '<label>Nama<input data-f="name" type="text" value="' + escHtml(c.name) + '" spellcheck="false" /></label>' +
          '<label>MD (' + u + ')<input data-f="shoeMd" type="text" inputmode="decimal" value="' + escHtml(c.shoeMd == null ? "" : c.shoeMd) + '" /></label>' +
          '<label>TVD (' + u + ')<input data-f="shoeTvd" type="text" inputmode="decimal" value="' + escHtml(c.shoeTvd == null ? "" : c.shoeTvd) + '" /></label>' +
          '<label>Jenis<select data-f="kind"><option value="casing"' + (c.kind !== "liner" ? " selected" : "") +
            '>Casing</option><option value="liner"' + (c.kind === "liner" ? " selected" : "") +
            ">Liner</option></select></label>" +
          '<label class="ai-csg-top">Top liner TVD<input data-f="topTvd" type="text" inputmode="decimal" value="' +
            escHtml(c.topTvd == null ? "" : c.topTvd) + '" placeholder="opsional" /></label>' +
          '<button type="button" class="btn ghost ai-csg-del" title="Hapus string">Hapus</button>' +
        "</div>" +
        '<label class="ai-csg-reason-label">Alasan usulan' +
          '<textarea data-f="reason" rows="2" placeholder="Kenapa angka ini masuk akal berdasarkan offset/data">' +
            escHtml(c.reason || "") +
          "</textarea>" +
        "</label>" +
      "</div>"
    );
  }

  function renderCasingResults() {
    const host = document.getElementById("ai-casing-results");
    if (!host) return;
    const draft = ensureCasingDraftShape(cache.casingSuggestion);
    if (!draft || !draft.casings.length) {
      const legacy = cache.casingSuggestion;
      if (legacy && legacy.text && !(legacy.casings && legacy.casings.length)) {
        host.innerHTML =
          '<article class="ai-card"><h3>' + escHtml(legacy.wellName || "Proposed") +
          "</h3><p>" + escHtml(legacy.text) +
          '</p><p class="micro">Hasil lama (teks saja). Generate ulang untuk mendapatkan angka yang bisa diedit dan dipratinjau.</p></article>';
        return;
      }
      host.innerHTML =
        '<div class="empty-state"><strong>Belum ada usulan casing</strong>' +
        "<span>Isi nama sumur proposed, lalu generate. Hasil angka bisa diedit di sini sebelum disalin ke tab Casing.</span></div>";
      return;
    }
    cache.casingSuggestion = draft;
    const unit = draft.unit || "ft";
    host.innerHTML =
      '<div class="ai-csg-workbench">' +
        '<section class="ai-csg-editor">' +
          "<h3>" + escHtml(draft.wellName) + "</h3>" +
          '<p class="micro">Angka usulan memakai rumus gambar yang sama dengan tab Casing Setting Depth. Edit di sini dulu; tab Casing belum berubah sampai Anda menyalin.</p>' +
          '<div class="ai-csg-meta">' +
            '<label>Nama sumur<input id="ai-csg-name" type="text" value="' + escHtml(draft.wellName) + '" spellcheck="false" /></label>' +
            '<label>TD MD (' + unit + ')<input id="ai-csg-td-md" type="text" inputmode="decimal" value="' +
              escHtml(draft.tdMd == null ? "" : draft.tdMd) + '" /></label>' +
            '<label>TD TVD (' + unit + ')<input id="ai-csg-td-tvd" type="text" inputmode="decimal" value="' +
              escHtml(draft.tdTvd == null ? "" : draft.tdTvd) + '" /></label>' +
            '<label class="check-line"><input id="ai-csg-include-offsets" type="checkbox"' +
              (draft.includeOffsets !== false ? " checked" : "") +
              " /> Tampilkan offset wells di pratinjau</label>" +
          "</div>" +
          '<div id="ai-csg-rows" class="ai-csg-rows">' +
            draft.casings.map(function (c) { return casingRowHtml(c, unit); }).join("") +
          "</div>" +
          '<div class="row-actions">' +
            '<button type="button" class="btn ghost" id="ai-csg-add">+ String casing</button>' +
          "</div>" +
          (draft.text
            ? '<article class="ai-card ai-csg-narrative"><h4>Ringkasan AI</h4><p>' + escHtml(draft.text) + "</p></article>"
            : "") +
          '<p class="micro">Disimpan: ' + escHtml(draft.savedAt || "") + "</p>" +
        "</section>" +
        '<section class="ai-csg-preview">' +
          "<h3>Pratinjau (rumus Casing Setting Depth)</h3>" +
          '<div id="ai-csg-sheet" class="ai-csg-sheet"><canvas id="ai-csg-chart" aria-label="Pratinjau usulan casing"></canvas></div>' +
          '<div class="row-actions">' +
            '<button type="button" class="btn ghost" id="ai-csg-png">Export PNG</button>' +
            '<button type="button" class="btn ghost" id="ai-csg-jpg">Export JPG</button>' +
            '<button type="button" class="btn ghost" id="ai-csg-pdf">Export PDF</button>' +
            '<button type="button" class="btn" id="ai-csg-to-tab">Tambah ke Casing Setting Depth</button>' +
          "</div>" +
        "</section>" +
      "</div>";
    wireCasingEditor(host);
    requestAnimationFrame(redrawAiCasingPreview);
  }

  function wireCasingEditor(host) {
    if (!host || host._aiCsgWired) return;
    host._aiCsgWired = true;
    host.addEventListener("input", function (e) {
      const t = e.target;
      if (!t || !t.getAttribute) return;
      if (t.id === "ai-csg-name" || t.id === "ai-csg-td-md" || t.id === "ai-csg-td-tvd" || t.id === "ai-csg-include-offsets" || t.getAttribute("data-f")) {
        persistDraftFromDom();
        redrawAiCasingPreview();
      }
    });
    host.addEventListener("change", function (e) {
      const t = e.target;
      if (!t) return;
      if (t.id === "ai-csg-include-offsets" || (t.getAttribute && t.getAttribute("data-f") === "kind")) {
        persistDraftFromDom();
        redrawAiCasingPreview();
      }
    });
    host.addEventListener("click", async function (e) {
      const t = e.target;
      if (!t || !t.id && !t.classList) return;
      if (t.id === "ai-csg-add") {
        const draft = persistDraftFromDom() || ensureCasingDraftShape(cache.casingSuggestion);
        if (!draft) return;
        draft.casings.push({
          id: uidLocal(),
          name: "Casing " + (draft.casings.length + 1),
          shoeMd: null,
          shoeTvd: null,
          kind: "casing",
          topTvd: null,
          style: "solid",
          reason: ""
        });
        cache.casingSuggestion = draft;
        saveCache();
        renderCasingResults();
        return;
      }
      if (t.classList.contains("ai-csg-del")) {
        const row = t.closest(".ai-csg-row");
        if (!row) return;
        const id = row.getAttribute("data-id");
        const draft = persistDraftFromDom() || ensureCasingDraftShape(cache.casingSuggestion);
        if (!draft) return;
        draft.casings = draft.casings.filter(function (c) { return c.id !== id; });
        cache.casingSuggestion = draft;
        saveCache();
        renderCasingResults();
        return;
      }
      if (t.id === "ai-csg-png" || t.id === "ai-csg-jpg" || t.id === "ai-csg-pdf") {
        try {
          persistDraftFromDom();
          const data = buildPreviewData();
          if (!data || !window.CasingSetting || !window.CasingSetting.exportFromData) {
            throw new Error("Modul casing belum siap.");
          }
          const kind = t.id === "ai-csg-jpg" ? "jpg" : t.id === "ai-csg-pdf" ? "pdf" : "png";
          await window.CasingSetting.exportFromData(data, kind, data.title);
          setStatus("ai-casing-status", "Export " + kind.toUpperCase() + " berhasil.");
        } catch (err) {
          setStatus("ai-casing-status", err.message || String(err));
        }
        return;
      }
      if (t.id === "ai-csg-to-tab") {
        try {
          const draft = persistDraftFromDom();
          if (!draft || !draft.casings.length) throw new Error("Belum ada usulan untuk disalin.");
          if (!window.CasingSetting || !window.CasingSetting.addOrReplaceWell) {
            throw new Error("Modul casing belum siap.");
          }
          const existing = (window.CasingSetting.wells() || []).some(function (w) {
            return ((w.name || "").trim().toLowerCase() === draft.wellName.toLowerCase());
          });
          let replace = false;
          if (existing) {
            replace = window.confirm(
              'Sumur "' + draft.wellName + '" sudah ada di tab Casing Setting Depth.\n\nOK = ganti data sumur itu.\nCancel = batalkan.'
            );
            if (!replace) return;
          }
          window.CasingSetting.addOrReplaceWell(
            {
              name: draft.wellName,
              color: draft.color,
              tdMd: draft.tdMd,
              tdTvd: draft.tdTvd,
              casings: draft.casings
            },
            { replaceByName: true }
          );
          setStatus(
            "ai-casing-status",
            existing
              ? 'Sumur "' + draft.wellName + '" di tab Casing sudah diperbarui.'
              : 'Sumur "' + draft.wellName + '" ditambahkan ke tab Casing Setting Depth.'
          );
        } catch (err) {
          setStatus("ai-casing-status", err.message || String(err));
        }
      }
    });
  }

  function isDemoProvider() {
    return (settings.provider || "") === "demo";
  }

  function tryParseJsonBlob(text) {
    if (!text) return null;
    const s = String(text);
    const start = s.indexOf("{");
    const end = s.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
      return JSON.parse(s.slice(start, end + 1));
    } catch (e) {
      return null;
    }
  }

  /** Local demo replies — no API key / no internet LLM needed (uji UI saja). */
  function demoCompletion(messages) {
    const user = (messages || []).filter(function (m) { return m.role === "user"; }).pop();
    const system = (messages || []).filter(function (m) { return m.role === "system"; }).pop();
    const userText = (user && user.content) || "";
    const sysText = ((system && system.content) || "").toLowerCase();
    const payload = tryParseJsonBlob(userText);

    // Casing proposal — return structured JSON for editable draft + chart
    if (sysText.indexOf("casing") >= 0 || (payload && payload.proposedWell)) {
      const name = (payload && payload.proposedWell) || "Proposed Well";
      const notes = (payload && payload.designNotes) || "";
      const offsets = (payload && payload.offsetWells) || [];
      const unit = (payload && payload.unit) === "m" ? "m" : "ft";
      const shoes = [];
      const tdCandidates = [];
      offsets.forEach(function (w) {
        if (Number.isFinite(Number(w.tdTvd))) tdCandidates.push(Number(w.tdTvd));
        (w.casings || []).forEach(function (c) {
          const tvd = Number(c.shoeTvd != null ? c.shoeTvd : c.shoeMd);
          const md = Number(c.shoeMd != null ? c.shoeMd : c.shoeTvd);
          if (!Number.isFinite(tvd)) return;
          shoes.push({
            name: c.name || "Casing",
            tvd: tvd,
            md: Number.isFinite(md) ? md : tvd,
            kind: c.kind === "liner" ? "liner" : "casing",
            from: w.name || ""
          });
        });
      });
      const byKind = {};
      shoes.forEach(function (s) {
        const key = String(s.name).toLowerCase();
        if (!byKind[key]) byKind[key] = [];
        byKind[key].push(s);
      });
      let suggested = Object.keys(byKind)
        .map(function (k) {
          const arr = byKind[k].slice().sort(function (a, b) { return a.tvd - b.tvd; });
          const mid = arr[Math.floor(arr.length / 2)];
          const vals = arr.map(function (x) { return x.tvd; });
          const min = vals[0];
          const max = vals[vals.length - 1];
          const wells = Array.from(new Set(arr.map(function (x) { return x.from; }).filter(Boolean)));
          return {
            name: arr[0].name || k,
            shoeTvd: Math.round(mid.tvd),
            shoeMd: Math.round(mid.md),
            kind: mid.kind || "casing",
            reason:
              "Median TVD dari " + arr.length + " string sejenis di offset" +
              (wells.length ? " (" + wells.slice(0, 4).join(", ") + (wells.length > 4 ? ", …" : "") + ")" : "") +
              ": rentang " + Math.round(min) + "–" + Math.round(max) + " " + unit +
              ". Angka ini selaras dengan praktik offset; validasi PP/FG dan kick tolerance sebelum final."
          };
        })
        .sort(function (a, b) { return a.shoeTvd - b.shoeTvd; })
        .slice(0, 6);
      if (!suggested.length) {
        suggested = [
          { name: "Conductor", shoeTvd: 300, shoeMd: 300, kind: "casing", reason: "Nilai demo default (tidak ada offset); ganti dengan data proyek." },
          { name: "Surface", shoeTvd: 1500, shoeMd: 1500, kind: "casing", reason: "Nilai demo default untuk uji antarmuka." },
          { name: "Intermediate", shoeTvd: 4500, shoeMd: 4500, kind: "casing", reason: "Nilai demo default untuk uji antarmuka." },
          { name: "Production", shoeTvd: 7500, shoeMd: 7500, kind: "casing", reason: "Nilai demo default untuk uji antarmuka." }
        ];
      }
      tdCandidates.sort(function (a, b) { return a - b; });
      const tdTvd = tdCandidates.length
        ? Math.round(tdCandidates[Math.floor(tdCandidates.length / 2)])
        : (suggested[suggested.length - 1].shoeTvd + 200);
      return JSON.stringify({
        wellName: name,
        unit: unit,
        tdTvd: tdTvd,
        tdMd: tdTvd,
        summary:
          "[DEMO · tanpa API key] Usulan casing untuk " + name +
          " disusun dari median shoe TVD offset wells" +
          (offsets.length ? " (" + offsets.length + " sumur)" : "") +
          (notes ? ", catatan: " + notes : "") +
          ". Bukan rekomendasi engineering final — validasi dengan PP/FG, kick tolerance, dan standar perusahaan.",
        casings: suggested
      });
    }

    // Well summary
    const well = payload || {};
    const wname = well.name || "sumur";
    const td =
      (well.drilling && (well.drilling.tdTvd || well.drilling.td)) ||
      (well.casing && (well.casing.tdTvd || well.casing.tdMd)) ||
      null;
    const nCsg = well.casing && Array.isArray(well.casing.casings) ? well.casing.casings.length : 0;
    const nEvt = well.drilling && well.drilling.eventCount != null ? well.drilling.eventCount : 0;
    const forms =
      (well.drilling && well.drilling.formations) ||
      [];
    return (
      "[DEMO · tanpa API key] Sumur " + wname +
      (td != null ? " mencapai sekitar " + td + " (MD/TVD sesuai data proyek)" : "") +
      (nCsg ? ", dengan " + nCsg + " string casing tercatat" : "") +
      (nEvt ? " dan " + nEvt + " event drilling ringkas" : "") +
      (forms && forms.length ? ". Formasi terkait: " + forms.slice(0, 6).join(", ") : "") +
      ". Ringkasan ini dibuat lokal untuk uji fitur AI Suggestion; ganti provider ke OpenRouter/DeepSeek/OpenAI bila ingin jawaban model sungguhan."
    );
  }

  async function chatCompletion(messages) {
    if (isDemoProvider()) {
      // slight delay so UI status feels real
      await new Promise(function (r) { setTimeout(r, 350); });
      return demoCompletion(messages);
    }
    if (!settings.apiKey) throw new Error("API key belum diisi di Pengaturan. Untuk uji gratis, pilih provider Demo.");
    const url = endpointFor();
    if (!url) throw new Error("Endpoint API belum diisi di Pengaturan.");
    const headers = {
      "Content-Type": "application/json",
      Authorization: "Bearer " + settings.apiKey
    };
    if (settings.provider === "openrouter") {
      headers["HTTP-Referer"] = location.origin || "https://localhost";
      headers["X-Title"] = "Migas Program";
    }
    const body = {
      model: settings.model || "gpt-4o-mini",
      messages,
      temperature: 0.3
    };
    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
    if (!res.ok) {
      const errText = await res.text();
      if (res.status === 404) {
        throw new Error(
          "Endpoint tidak ditemukan (404) di " + url +
          ". Isi Base URL saja, contoh https://nama-penyedia/v1 (path /chat/completions ditambah otomatis). " +
          "Detail: " + errText.slice(0, 180)
        );
      }
      throw new Error("API error " + res.status + " di " + url + ": " + errText.slice(0, 240));
    }
    const data = await res.json();
    const text = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (!text) throw new Error("Respons API kosong.");
    return String(text).trim();
  }

  function slimWellData(snap, wellName) {
    const out = { name: wellName, casing: null, drilling: null };
    if (snap.casing && Array.isArray(snap.casing.wells)) {
      const w = snap.casing.wells.find((x) => (x.name || "") === wellName);
      if (w) {
        out.casing = {
          tdMd: w.tdMd,
          tdTvd: w.tdTvd,
          casings: (w.casings || []).map((c) => ({ name: c.name, shoeMd: c.shoeMd, shoeTvd: c.shoeTvd, kind: c.kind })),
          ppPoints: (w.pp || []).length,
          fgPoints: (w.fg || []).length
        };
      }
    }
    if (snap.drilling) {
      if (Array.isArray(snap.drilling.wells)) {
        const w = snap.drilling.wells.find((x) => (x.name || "") === wellName);
        if (w) {
          out.drilling = {
            td: w.td,
            tdTvd: w.tdTvd,
            endDay: w.endDay,
            eventCount: (w.events || []).length,
            events: (w.events || []).slice(0, 40).map((e) => ({ day: e.day, depth: e.depth, depthTvd: e.depthTvd, category: e.category })),
            formations: (w.formations || []).map((f) => f.name)
          };
        }
      } else if ((snap.drilling.well || "") === wellName) {
        out.drilling = {
          td: snap.drilling.td,
          tdTvd: snap.drilling.tdTvd,
          endDay: snap.drilling.endDay,
          eventCount: (snap.drilling.events || []).length,
          events: (snap.drilling.events || []).slice(0, 40).map((e) => ({ day: e.day, depth: e.depth, depthTvd: e.depthTvd, category: e.category })),
          formations: (snap.drilling.formations || []).map((f) => f.name)
        };
      }
    }
    return out;
  }

  async function generateSummaries() {
    const names = selectedWellNames();
    if (!names.length) {
      setStatus("ai-summary-status", "Pilih minimal satu sumur.");
      return;
    }
    const snap = collectProjectSnapshot();
    setStatus("ai-summary-status", "Menghasilkan ringkasan...");
    try {
      let generated = 0;
      let skipped = 0;
      for (const name of names) {
        if (cache.summaries[name] && cache.summaries[name].text) {
          skipped += 1;
          continue;
        }
        const payload = slimWellData(snap, name);
        const text = await chatCompletion([
          { role: "system", content: "You are a petroleum drilling engineer. Write exactly one concise paragraph summary in Indonesian about the well from the JSON data. No bullet points." },
          { role: "user", content: "Ringkas sumur berikut dalam 1 paragraf:\n" + JSON.stringify(payload) }
        ]);
        cache.summaries[name] = { text, savedAt: new Date().toISOString() };
        saveCache();
        generated += 1;
        renderSummaryResults();
      }
      setStatus("ai-summary-status", "Selesai. Baru: " + generated + ", dari cache: " + skipped + ".");
      renderSummaryResults();
    } catch (err) {
      setStatus("ai-summary-status", err.message || String(err));
    }
  }

  async function generateCasingSuggestion() {
    const wellName = ((document.getElementById("ai-proposed-name") || {}).value || "").trim() || "Proposed well";
    const notes = ((document.getElementById("ai-proposed-notes") || {}).value || "").trim();
    const snap = collectProjectSnapshot();
    const unit = (snap.casing && snap.casing.unit) === "m" ? "m" : "ft";
    setStatus("ai-casing-status", "Menganalisis offset wells...");
    try {
      const offsets = (snap.casing && Array.isArray(snap.casing.wells))
        ? snap.casing.wells
            .filter(function (w) {
              return ((w.name || "").trim().toLowerCase() !== wellName.toLowerCase());
            })
            .map((w) => ({
              name: w.name,
              tdTvd: w.tdTvd,
              tdMd: w.tdMd,
              casings: (w.casings || []).map((c) => ({
                name: c.name,
                shoeTvd: c.shoeTvd,
                shoeMd: c.shoeMd,
                kind: c.kind,
                topTvd: c.topTvd
              })),
              pp: (w.pp || []).slice(0, 30),
              fg: (w.fg || []).slice(0, 30)
            }))
        : [];
      const formations = snap.casing && snap.casing.formations ? snap.casing.formations : [];
      const text = await chatCompletion([
        {
          role: "system",
          content:
            "You are a senior well engineer. Propose casing setting depths for a new well from offset well data. " +
            "Reply with ONLY valid JSON (no markdown) matching: " +
            '{"wellName":string,"unit":"ft"|"m","tdMd":number|null,"tdTvd":number|null,"summary":string,' +
            '"casings":[{"name":string,"shoeMd":number,"shoeTvd":number,"kind":"casing"|"liner","topTvd":number|null,"reason":string}]}. ' +
            "Each reason must explain in Indonesian why that depth is sensible vs offset data (median/range, formation, PP/FG if relevant). " +
            "Be practical. Assume vertical well (shoeMd≈shoeTvd) unless offsets show otherwise. Units must match input unit."
        },
        {
          role: "user",
          content: JSON.stringify({
            proposedWell: wellName,
            designNotes: notes,
            unit: unit,
            formations: formations,
            offsetWells: offsets
          })
        }
      ]);
      const draft = parseCasingProposal(text, wellName, unit);
      if (!draft || !draft.casings.length) {
        throw new Error("AI tidak mengembalikan angka casing yang bisa diparse. Coba lagi atau ganti provider.");
      }
      draft.savedAt = new Date().toISOString();
      if (!draft.text) draft.text = String(text || "").trim();
      draft.includeOffsets = true;
      cache.casingSuggestion = draft;
      saveCache();
      renderCasingResults();
      setStatus("ai-casing-status", "Usulan angka casing siap diedit di tab AI.");
    } catch (err) {
      setStatus("ai-casing-status", err.message || String(err));
    }
  }

  function syncProviderFields() {
    const prov = document.getElementById("set-provider");
    const model = document.getElementById("set-model");
    const key = document.getElementById("set-apikey");
    const ep = document.getElementById("set-endpoint");
    const hint = document.getElementById("set-ai-hint");
    if (!prov) return;
    const p = prov.value || "demo";
    const demo = p === "demo";
    if (model && (!model.value.trim() || model.dataset.auto === "1" || PROVIDER_MODELS[model.value])) {
      model.value = PROVIDER_MODELS[p] || model.value;
      model.dataset.auto = "1";
    }
    if (key) {
      key.disabled = demo;
      key.placeholder = demo ? "(tidak perlu — mode Demo)" : "sk-...";
    }
    if (ep) {
      ep.disabled = demo;
      const full = PROVIDER_ENDPOINTS[p] || "";
      ep.placeholder = demo
        ? "(tidak perlu — jawaban dibuat lokal)"
        : (full.replace(/\/chat\/completions$/, "") || "https://nama-penyedia/v1");
    }
    if (hint) {
      hint.textContent = demo
        ? "Mode Demo: uji Generate tanpa beli API. Jawaban dilabeli [DEMO] dan memakai data sumur lokal."
        : "Tempel API Key dan Base URL dari penyedia (biasanya berakhir /v1). Kosongkan Base URL untuk memakai endpoint bawaan provider. Lalu Simpan dan Uji AI Suggestion.";
    }
  }

  function openSettings() {
    const modal = document.getElementById("settings-modal");
    if (!modal) return;
    const set = (id, val) => { const el = document.getElementById(id); if (el) el.value = val || ""; };
    set("set-provider", settings.provider || "demo");
    set("set-model", settings.model || PROVIDER_MODELS[settings.provider] || "demo-local");
    set("set-apikey", settings.apiKey || "");
    set("set-endpoint", settings.endpoint || "");
    set("set-vps-url", settings.vpsUrl || "");
    syncProviderFields();
    modal.hidden = false;
    modal.setAttribute("aria-hidden", "false");
    document.body.classList.add("settings-open");
  }

  function closeSettings() {
    const modal = document.getElementById("settings-modal");
    if (!modal) return;
    modal.hidden = true;
    modal.setAttribute("aria-hidden", "true");
    document.body.classList.remove("settings-open");
  }

  async function saveSettings() {
    settings.provider = document.getElementById("set-provider").value || "demo";
    settings.model = document.getElementById("set-model").value.trim() || (PROVIDER_MODELS[settings.provider] || "demo-local");
    settings.apiKey = settings.provider === "demo" ? "" : document.getElementById("set-apikey").value.trim();
    settings.endpoint = settings.provider === "demo" ? "" : document.getElementById("set-endpoint").value.trim();
    settings.vpsUrl = document.getElementById("set-vps-url").value.trim();
    const apiBaseEl = document.getElementById("set-api-base");
    if (apiBaseEl && window.MigasStorage) window.MigasStorage.setApiBase(apiBaseEl.value.trim());
    else if (apiBaseEl) localStorage.setItem("migas-api-base", apiBaseEl.value.trim().replace(/\/$/, ""));
    const apiTokEl = document.getElementById("set-api-token");
    if (apiTokEl) localStorage.setItem("migas-api-token", apiTokEl.value.trim());
    saveSettingsLocal();
    setStatus(
      "settings-status",
      settings.provider === "demo"
        ? "Demo aktif — Generate AI Suggestion tanpa API key."
        : "Settings disimpan di browser."
    );
    if (settings.vpsUrl) {
      try {
        const res = await fetch(settings.vpsUrl, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(settings)
        });
        if (!res.ok) {
          // try POST
          const res2 = await fetch(settings.vpsUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(settings)
          });
          if (!res2.ok) throw new Error("VPS respond " + res2.status);
        }
        setStatus("settings-status", "Settings disimpan di browser dan VPS.");
      } catch (err) {
        setStatus("settings-status", "Browser OK, VPS gagal: " + (err.message || err));
      }
    }
  }

  async function loadSettingsFromVps() {
    const url = (document.getElementById("set-vps-url").value || settings.vpsUrl || "").trim();
    if (!url) {
      setStatus("settings-status", "Isi VPS Settings URL dulu.");
      return;
    }
    try {
      const res = await fetch(url, { method: "GET" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const data = await res.json();
      settings = Object.assign({}, DEFAULTS, data);
      saveSettingsLocal();
      openSettings();
      setStatus("settings-status", "Settings dimuat dari VPS.");
    } catch (err) {
      setStatus("settings-status", "Gagal muat VPS: " + (err.message || err));
    }
  }

  // Patch project snapshot to include AI cache
  function patchProjectSaveLoad() {
    // Prefer extending drilling's project pack if present
    const originalSave = window.__migasProjectSnapshot;
  }

  function getAiSnapshot() {
    return { settingsMeta: { provider: settings.provider, model: settings.model, hasKey: !!settings.apiKey }, cache };
  }

  function loadAiSnapshot(data) {
    if (!data || !data.cache) return;
    cache = data.cache;
    saveCache();
    renderSummaryResults();
    renderCasingResults();
  }

  function bind() {
    const btnSet = document.getElementById("btn-settings");
    if (btnSet) btnSet.addEventListener("click", (e) => { e.preventDefault(); openSettings(); });
    const modal = document.getElementById("settings-modal");
    if (modal) {
      modal.addEventListener("click", (event) => {
        if (event.target && event.target.getAttribute && event.target.getAttribute("data-settings-close")) {
          closeSettings();
        }
      });
    }
    const close = document.getElementById("settings-close");
    if (close) close.addEventListener("click", (e) => { e.preventDefault(); closeSettings(); });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeSettings();
    });
    const save = document.getElementById("settings-save");
    if (save) save.addEventListener("click", saveSettings);
    const loadVps = document.getElementById("settings-load-vps");
    if (loadVps) loadVps.addEventListener("click", loadSettingsFromVps);
    const applyDataDir = document.getElementById("settings-apply-data-dir");
    if (applyDataDir) applyDataDir.addEventListener("click", async () => {
      try {
        const input = document.getElementById("set-data-dir");
        const path = (input && input.value || "").trim();
        if (!path) {
          setStatus("settings-data-dir-status", "Enter a full folder path first.");
          return;
        }
        const base = (localStorage.getItem("migas-api-base") || location.origin || "").replace(/\/$/, "");
        const res = await fetch(base + "/api/portable/set-data-dir", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path }),
        });
        const data = await res.json();
        if (!data.ok) throw new Error(data.error || "Failed");
        setStatus("settings-data-dir-status", "Data folder set to: " + data.path);
      } catch (err) {
        setStatus("settings-data-dir-status", "Error: " + (err.message || err));
      }
    });
    // load current data dir
    (async () => {
      try {
        const base = (localStorage.getItem("migas-api-base") || location.origin || "").replace(/\/$/, "");
        const res = await fetch(base + "/api/portable/data-dir");
        const data = await res.json();
        if (data.ok) {
          const input = document.getElementById("set-data-dir");
          if (input && data.save_dir) {
            // show parent of savefile
            const p = data.save_dir.replace(/[/\\]savefile[/\\]?$/, "");
            input.placeholder = p || data.save_dir;
          }
        }
      } catch (e) { /* offline */ }
    })();
    const provSel = document.getElementById("set-provider");
    if (provSel && !provSel._wiredDemo) {
      provSel._wiredDemo = true;
      provSel.addEventListener("change", syncProviderFields);
    }
    const modelInp = document.getElementById("set-model");
    if (modelInp && !modelInp._wiredDemo) {
      modelInp._wiredDemo = true;
      modelInp.addEventListener("input", function () { modelInp.dataset.auto = "0"; });
    }
    const testApi = document.getElementById("settings-test-api");
    if (testApi) testApi.addEventListener("click", async () => {
      try {
        // persist current AI fields into memory for the probe
        settings.provider = (document.getElementById("set-provider") || {}).value || settings.provider;
        settings.model = ((document.getElementById("set-model") || {}).value || "").trim() || settings.model;
        settings.apiKey = ((document.getElementById("set-apikey") || {}).value || "").trim();
        settings.endpoint = ((document.getElementById("set-endpoint") || {}).value || "").trim();
        const apiBaseEl = document.getElementById("set-api-base");
        if (apiBaseEl) localStorage.setItem("migas-api-base", (apiBaseEl.value || "").trim().replace(/\/$/, ""));
        const apiTokEl = document.getElementById("set-api-token");
        if (apiTokEl) localStorage.setItem("migas-api-token", (apiTokEl.value || "").trim());

        setStatus("settings-status", "Menguji " + (endpointFor() || "(endpoint kosong)") + " …");
        const reply = await chatCompletion([
          { role: "system", content: "You are a petroleum drilling engineer. Write exactly one concise paragraph summary in Indonesian about the well from the JSON data. No bullet points." },
          { role: "user", content: 'Ringkas sumur berikut dalam 1 paragraf:\n{"name":"TEST-1","casing":{"tdTvd":8000,"casings":[{"name":"surface","shoeTvd":1500}]},"drilling":{"tdTvd":8000,"eventCount":3,"formations":["A","B"]}}' }
        ]);
        setStatus("settings-status", "AI OK (" + settings.provider + "): " + String(reply).slice(0, 160) + (reply.length > 160 ? "…" : ""));
      } catch (err) {
        setStatus("settings-status", "AI failed: " + (err.message || err));
      }
    });
    const genSum = document.getElementById("ai-generate-summary");
    if (genSum) genSum.addEventListener("click", generateSummaries);
    const genCsg = document.getElementById("ai-generate-casing");
    if (genCsg) genCsg.addEventListener("click", generateCasingSuggestion);
    const mode = document.getElementById("ai-summary-mode");
    if (mode) mode.addEventListener("change", renderWellPicks);

    async function exportAiCasing(kind) {
      try {
        if (cache.casingSuggestion) persistDraftFromDom();
        const data = buildPreviewData();
        if (!data || !window.CasingSetting || !window.CasingSetting.exportFromData) {
          throw new Error("Generate usulan casing dulu, atau modul casing belum siap.");
        }
        await window.CasingSetting.exportFromData(data, kind, data.title);
        setStatus("ai-casing-status", "Export " + kind.toUpperCase() + " berhasil.");
      } catch (err) {
        setStatus("ai-casing-status", err.message || String(err));
      }
    }
    [
      ["ai-hdr-csg-png", "png"],
      ["ai-hdr-csg-jpg", "jpg"],
      ["ai-hdr-csg-pdf", "pdf"]
    ].forEach(function (pair) {
      const btn = document.getElementById(pair[0]);
      if (btn) btn.addEventListener("click", function () { exportAiCasing(pair[1]); });
    });

    const tab = document.getElementById("tab-ai");
    if (tab) {
      tab.addEventListener("click", () => {
        // Also force panel visible in case tab switcher missed it
        const panel = document.getElementById("panel-ai");
        if (panel) panel.hidden = false;
        renderWellPicks();
        renderSummaryResults();
        renderCasingResults();
      });
    }
    window.addEventListener("resize", function () {
      if (!document.getElementById("ai-csg-chart")) return;
      redrawAiCasingPreview();
    });
  }

  function init() {
    bind();
    renderWellPicks();
    renderSummaryResults();
    renderCasingResults();
    // Auto-load VPS settings if URL already known
    if (settings.vpsUrl) {
      loadSettingsFromVps().catch(() => {});
    }
  }

  window.MigasAI = {
    snapshot: getAiSnapshot,
    load: loadAiSnapshot,
    getSettings: () => Object.assign({}, settings)
  };

  document.addEventListener("DOMContentLoaded", init);
})();
