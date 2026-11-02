(function () {
  const SETTINGS_KEY = "migas-ai-settings-v1";
  const CACHE_KEY = "migas-ai-cache-v1";

  const DEFAULTS = {
    provider: "openai",
    model: "gpt-4o-mini",
    apiKey: "",
    endpoint: "",
    vpsUrl: ""
  };

  const PROVIDER_ENDPOINTS = {
    openai: "https://api.openai.com/v1/chat/completions",
    openrouter: "https://openrouter.ai/api/v1/chat/completions",
    deepseek: "https://api.deepseek.com/chat/completions",
    grok: "https://api.x.ai/v1/chat/completions",
    custom: ""
  };

  let settings = loadSettingsLocal();
  let cache = loadCache();

  function loadSettingsLocal() {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (!raw) return Object.assign({}, DEFAULTS);
      return Object.assign({}, DEFAULTS, JSON.parse(raw));
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
      host.innerHTML = '<p class="micro">Belum ada ringkasan tersimpan.</p>';
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
      host.innerHTML = '<p class="micro">Belum ada saran casing.</p>';
      return;
    }
    const item = cache.casingSuggestion;
    host.innerHTML = '<article class="ai-card"><h3>' + (item.wellName || "Proposed") +
      '</h3><p>' + (item.text || "") + '</p><p class="micro">Disimpan: ' + (item.savedAt || "") + "</p></article>";
  }

  async function chatCompletion(messages) {
    if (!settings.apiKey) throw new Error("API key belum diisi di Settings.");
    const url = endpointFor();
    if (!url) throw new Error("Endpoint API belum diisi.");
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

  function openSettings() {
    const modal = document.getElementById("settings-modal");
    if (!modal) return;
    const set = (id, val) => { const el = document.getElementById(id); if (el) el.value = val || ""; };
    set("set-provider", settings.provider || "openai");
    set("set-model", settings.model || "");
    set("set-apikey", settings.apiKey || "");
    set("set-endpoint", settings.endpoint || "");
    set("set-vps-url", settings.vpsUrl || "");
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
    settings.provider = document.getElementById("set-provider").value || "openai";
    settings.model = document.getElementById("set-model").value.trim();
    settings.apiKey = document.getElementById("set-apikey").value.trim();
    settings.endpoint = document.getElementById("set-endpoint").value.trim();
    settings.vpsUrl = document.getElementById("set-vps-url").value.trim();
    const apiBaseEl = document.getElementById("set-api-base");
    if (apiBaseEl && window.MigasStorage) window.MigasStorage.setApiBase(apiBaseEl.value.trim());
    else if (apiBaseEl) localStorage.setItem("migas-api-base", apiBaseEl.value.trim().replace(/\/$/, ""));
    const apiTokEl = document.getElementById("set-api-token");
    if (apiTokEl) localStorage.setItem("migas-api-token", apiTokEl.value.trim());
    saveSettingsLocal();
    setStatus("settings-status", "Settings disimpan di browser.");
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
    const testApi = document.getElementById("settings-test-api");
    if (testApi) testApi.addEventListener("click", async () => {
      try {
        // persist fields first
        const apiBaseEl = document.getElementById("set-api-base");
        if (apiBaseEl) localStorage.setItem("migas-api-base", (apiBaseEl.value || "").trim().replace(/\/$/, ""));
        const apiTokEl = document.getElementById("set-api-token");
        if (apiTokEl) localStorage.setItem("migas-api-token", (apiTokEl.value || "").trim());
        if (window.MigasStorage && window.MigasStorage.testConnection) {
          const data = await window.MigasStorage.testConnection();
          setStatus("settings-status", "API OK: " + JSON.stringify(data));
        } else {
          const base = (localStorage.getItem("migas-api-base") || location.origin || "").replace(/\/$/, "");
          const res = await fetch(base + "/api/health");
          const data = await res.json();
          setStatus("settings-status", "API OK: " + JSON.stringify(data));
        }
      } catch (err) {
        setStatus("settings-status", "API failed: " + (err.message || err));
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
