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

  function endpointFor() {
    if (settings.endpoint && settings.endpoint.trim()) return settings.endpoint.trim();
    return PROVIDER_ENDPOINTS[settings.provider] || PROVIDER_ENDPOINTS.openai;
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

  function renderCasingResults() {
    const host = document.getElementById("ai-casing-results");
    if (!host) return;
    if (!cache.casingSuggestion) {
      host.innerHTML = '<div class="empty-state"><strong>Belum ada usulan casing</strong><span>Isi nama sumur proposed, lalu generate.</span></div>';
      return;
    }
    const item = cache.casingSuggestion;
    host.innerHTML = '<article class="ai-card"><h3>' + (item.wellName || "Proposed") +
      '</h3><p>' + (item.text || "") + '</p><p class="micro">Disimpan: ' + (item.savedAt || "") + "</p></article>";
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

    // Casing proposal
    if (sysText.indexOf("casing") >= 0 || (payload && payload.proposedWell)) {
      const name = (payload && payload.proposedWell) || "Proposed Well";
      const notes = (payload && payload.designNotes) || "";
      const offsets = (payload && payload.offsetWells) || [];
      const shoes = [];
      offsets.forEach(function (w) {
        (w.casings || []).forEach(function (c) {
          const tvd = Number(c.shoeTvd != null ? c.shoeTvd : c.shoeMd);
          if (!Number.isFinite(tvd)) return;
          shoes.push({ name: c.name || "Casing", tvd: tvd, from: w.name || "" });
        });
      });
      // group by rough name family
      const byKind = {};
      shoes.forEach(function (s) {
        const key = String(s.name).toLowerCase();
        if (!byKind[key]) byKind[key] = [];
        byKind[key].push(s.tvd);
      });
      const suggested = Object.keys(byKind)
        .map(function (k) {
          const arr = byKind[k].slice().sort(function (a, b) { return a - b; });
          const mid = arr[Math.floor(arr.length / 2)];
          return { name: k, tvd: Math.round(mid) };
        })
        .sort(function (a, b) { return a.tvd - b.tvd; })
        .slice(0, 6);
      if (!suggested.length) {
        suggested.push(
          { name: "conductor", tvd: 300 },
          { name: "surface", tvd: 1500 },
          { name: "intermediate", tvd: 4500 },
          { name: "production", tvd: 7500 }
        );
      }
      const list = suggested
        .map(function (s, i) { return (i + 1) + ". " + s.name + " @ " + s.tvd + " ft TVD"; })
        .join("\n");
      return (
        "[DEMO · tanpa API key] Usulan awal casing untuk sumur " + name +
        " disusun dari median shoe TVD offset wells yang tersedia" +
        (offsets.length ? " (" + offsets.length + " sumur)" : "") +
        (notes ? ", dengan catatan desain: " + notes : "") +
        ". Angka ini hanya untuk uji antarmuka — bukan rekomendasi engineering final; " +
        "validasi dengan PP/FG, kick tolerance, dan standar perusahaan sebelum dipakai.\n\n" +
        list
      );
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
      throw new Error("API error " + res.status + ": " + errText.slice(0, 240));
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
    setStatus("ai-casing-status", "Menganalisis offset wells...");
    try {
      const offsets = (snap.casing && Array.isArray(snap.casing.wells))
        ? snap.casing.wells.map((w) => ({
            name: w.name,
            tdTvd: w.tdTvd,
            casings: (w.casings || []).map((c) => ({ name: c.name, shoeTvd: c.shoeTvd, shoeMd: c.shoeMd, kind: c.kind })),
            pp: (w.pp || []).slice(0, 30),
            fg: (w.fg || []).slice(0, 30)
          }))
        : [];
      const formations = snap.casing && snap.casing.formations ? snap.casing.formations : [];
      const text = await chatCompletion([
        { role: "system", content: "You are a senior well engineer. Propose casing setting depths for a new well using offset well data. Reply in Indonesian, one cohesive paragraph plus a short ordered list of suggested shoes (name + TVD ft). Be practical." },
        { role: "user", content: JSON.stringify({ proposedWell: wellName, designNotes: notes, formations, offsetWells: offsets }) }
      ]);
      cache.casingSuggestion = { wellName, text, savedAt: new Date().toISOString() };
      saveCache();
      renderCasingResults();
      setStatus("ai-casing-status", "Saran casing disimpan.");
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
      ep.placeholder = demo
        ? "(tidak perlu — jawaban dibuat lokal)"
        : (PROVIDER_ENDPOINTS[p] || "https://...");
    }
    if (hint) {
      hint.textContent = demo
        ? "Mode Demo: uji Generate tanpa beli API. Jawaban dilabeli [DEMO] dan memakai data sumur lokal."
        : "Isi API Key provider yang dipilih, lalu Simpan. Tombol Uji AI mengecek chat completion.";
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

        setStatus("settings-status", "Menguji AI Suggestion…");
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
