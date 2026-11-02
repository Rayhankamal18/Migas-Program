(function () {
  const DEFAULT_API = (localStorage.getItem("migas-api-base") || "").replace(/\/$/, "");
  const TOKEN_KEY = "migas-api-token";
  let dirty = false;
  let lastLoaded = { name: null, source: null, at: null };

  function apiBase() {
    const stored = (localStorage.getItem("migas-api-base") || DEFAULT_API || "").trim().replace(/\/$/, "");
    if (stored) return stored;
    // Same-origin default: works when nginx proxies /api -> backend
    if (typeof location !== "undefined" && location.protocol && location.protocol !== "file:") {
      return location.origin;
    }
    return "";
  }

  function token() {
    return localStorage.getItem(TOKEN_KEY) || "";
  }

  function headers(json) {
    const h = {};
    if (json) h["Content-Type"] = "application/json";
    const t = token();
    if (t) h["X-Migas-Token"] = t;
    return h;
  }

  function setDirty(v) {
    dirty = !!v;
    const el = document.getElementById("project-status-line");
    if (el && dirty && lastLoaded.name) {
      el.dataset.dirty = "1";
    }
  }

  function markClean(name, source) {
    dirty = false;
    lastLoaded = { name: name || lastLoaded.name, source: source || lastLoaded.source, at: new Date() };
    renderStatus();
  }

  function renderStatus() {
    const el = document.getElementById("project-status-line");
    if (!el) return;
    const n = lastLoaded.name || "unsaved";
    const s = lastLoaded.source || "—";
    const t = lastLoaded.at ? lastLoaded.at.toLocaleTimeString() : "—";
    el.textContent = dirty
      ? `Unsaved changes | Last loaded: ${n} (${s})`
      : `Loaded: ${n} (${s}) | Last saved/loaded: ${t}`;
  }

  function buildPayload() {
    const tabBtn = document.querySelector('.tab[aria-selected="true"]');
    let tab = "azimuth";
    if (tabBtn) {
      const id = tabBtn.id || "";
      if (id.includes("casing")) tab = "casing";
      else if (id.includes("drilling")) tab = "drilling";
      else if (id.includes("boxplot")) tab = "boxplot";
      else if (id.includes("ai")) tab = "ai";
      else if (id.includes("automl")) tab = "automl";
    }
    return {
      kind: "gambar-sumur",
      version: 1,
      savedAt: new Date().toISOString(),
      tab,
      azimuth: window.AzimuthChart ? window.AzimuthChart.snapshot() : null,
      casing: window.CasingSetting ? window.CasingSetting.snapshot() : null,
      drilling: window.DrillingSummary ? window.DrillingSummary.snapshot() : null,
      boxplot: window.BoxWhisker ? window.BoxWhisker.snapshot() : null,
      ai: window.MigasAI ? window.MigasAI.snapshot() : null,
      automl: window.MigasAutoML ? window.MigasAutoML.snapshot() : null,
    };
  }

  async function applyPayload(data) {
    if (!data || typeof data !== "object") throw new Error("Invalid project file.");
    if (data.kind && data.kind !== "gambar-sumur") throw new Error("This is not a Gambar Sumur project file.");
    if (data.azimuth && window.AzimuthChart) window.AzimuthChart.load(data.azimuth);
    if (data.casing && window.CasingSetting) window.CasingSetting.load(data.casing);
    if (data.drilling && window.DrillingSummary) window.DrillingSummary.load(data.drilling);
    if (data.boxplot && window.BoxWhisker) window.BoxWhisker.load(data.boxplot);
    if (data.ai && window.MigasAI) window.MigasAI.load(data.ai);
    if (data.automl && window.MigasAutoML) window.MigasAutoML.load(data.automl);
    if (data.tab && window.CasingSetting && window.CasingSetting.activate) {
      window.CasingSetting.activate(data.tab);
    }
  }

  async function listVps() {
    const base = apiBase();
    if (!base) throw new Error("Open the app via http://your-vps (not file://) or set API base URL in Settings.");
    let res;
    try {
      res = await fetch(base + "/api/files", { headers: headers(false) });
    } catch (err) {
      throw new Error(
        "Failed to reach API at " + base + "/api/files. " +
        "Check: (1) migas-api service is running, (2) Settings API base URL is correct, " +
        "(3) nginx proxies /api, (4) you are not using file://. Detail: " + (err && err.message)
      );
    }
    if (!res.ok) {
      const text = await res.text();
      throw new Error("API HTTP " + res.status + ": " + text.slice(0, 180));
    }
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "Could not list files.");
    return data.files || [];
  }

  async function loadVps(name) {
    if (dirty && !confirm("You have unsaved changes. Load anyway and discard them?")) return;
    const base = apiBase();
    const res = await fetch(base + "/api/files/" + encodeURIComponent(name), { headers: headers(false) });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "Load failed.");
    await applyPayload(data.data);
    markClean(data.name, "PC folder");
  }

  async function saveVps(name, overwrite) {
    const base = apiBase();
    if (!base) throw new Error("Open via http://your-vps or set API base URL in Settings.");
    const payload = buildPayload();
    let res;
    try {
      res = await fetch(base + "/api/files", {
        method: "POST",
        headers: headers(true),
        body: JSON.stringify({ name, data: payload, overwrite: !!overwrite }),
      });
    } catch (err) {
      throw new Error("Failed to reach API at " + base + " — is migas-api running? " + (err && err.message));
    }
    let data = {};
    try { data = await res.json(); } catch (e) { /* ignore */ }
    if (res.status === 409) {
      return { exists: true, name: data.name };
    }
    if (!res.ok || !data.ok) throw new Error(data.error || ("Save failed HTTP " + res.status));
    markClean(data.name, "PC folder");
    return data;
  }

  function saveDevice() {
    const payload = buildPayload();
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `gambar-sumur-${stamp}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1500);
    markClean(a.download, "device");
  }

  async function loadDeviceFile(file) {
    if (dirty && !confirm("You have unsaved changes. Load anyway and discard them?")) return;
    const text = await file.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      throw new Error("File is not valid JSON. Current data was not changed.");
    }
    await applyPayload(data);
    markClean(file.name, "device");
  }

  function openModal() {
    const m = document.getElementById("storage-modal");
    if (m) {
      m.hidden = false;
      refreshList().catch(() => {});
    }
  }
  function closeModal() {
    const m = document.getElementById("storage-modal");
    if (m) m.hidden = true;
  }

  async function refreshList() {
    const host = document.getElementById("storage-file-list");
    if (!host) return;
    host.innerHTML = "<p class='micro'>Loading…</p>";
    try {
      const files = await listVps();
      if (!files.length) {
        host.innerHTML = "<p class='micro'>No JSON files in the data folder yet.</p>";
        return;
      }
      host.innerHTML = files
        .map(
          (f) =>
            `<button type="button" class="storage-file" data-name="${f.name}">` +
            `<strong>${f.name}</strong>` +
            `<span class="micro">${(f.size / 1024).toFixed(1)} KB · ${new Date(f.modified).toLocaleString()}</span>` +
            `</button>`
        )
        .join("");
    } catch (err) {
      host.innerHTML = `<p class="status">${err.message}</p>`;
    }
  }

  function bind() {
    const openBtn = document.getElementById("btn-storage");
    if (openBtn) openBtn.addEventListener("click", openModal);
    const closeBtn = document.getElementById("storage-close");
    if (closeBtn) closeBtn.addEventListener("click", closeModal);
    const refresh = document.getElementById("storage-refresh");
    if (refresh) refresh.addEventListener("click", () => refreshList().catch((e) => alert(e.message)));
    const list = document.getElementById("storage-file-list");
    if (list) {
      list.addEventListener("click", (e) => {
        const btn = e.target.closest("[data-name]");
        if (!btn) return;
        loadVps(btn.getAttribute("data-name")).catch((err) => alert(err.message));
      });
    }
    const saveVpsBtn = document.getElementById("storage-save-vps");
    if (saveVpsBtn) {
      saveVpsBtn.addEventListener("click", async () => {
        const input = document.getElementById("storage-save-name");
        const name = (input && input.value) || "";
        if (!name.trim()) {
          alert("Enter a file name.");
          return;
        }
        try {
          const result = await saveVps(name, false);
          if (result && result.exists) {
            if (confirm(`"${result.name}" already exists. Overwrite?`)) {
              await saveVps(name, true);
              alert("Saved to data folder (overwritten).");
            } else {
              alert("Not saved. Choose a new name.");
            }
          } else {
            alert("Saved to data folder.");
          }
          refreshList();
        } catch (err) {
          alert(err.message);
        }
      });
    }
    const saveDev = document.getElementById("storage-save-device");
    if (saveDev) saveDev.addEventListener("click", () => saveDevice());
    const loadDev = document.getElementById("storage-load-device");
    const fileInput = document.getElementById("storage-device-file");
    if (loadDev && fileInput) {
      loadDev.addEventListener("click", () => fileInput.click());
      fileInput.addEventListener("change", async () => {
        const f = fileInput.files && fileInput.files[0];
        if (!f) return;
        try {
          await loadDeviceFile(f);
          alert("Loaded from device.");
          closeModal();
        } catch (err) {
          alert(err.message);
        }
        fileInput.value = "";
      });
    }
    // mark dirty on common inputs
    document.addEventListener("input", () => setDirty(true), true);
    renderStatus();
  }

  async function testConnection() {
    const base = apiBase();
    if (!base) throw new Error("No API base. Open app via http://VPS or set API base in Settings.");
    const url = base.replace(/\/$/, "") + "/api/health";
    const res = await fetch(url, { headers: headers(false) });
    const raw = await res.text();
    if (!res.ok) throw new Error("Health check HTTP " + res.status + " @ " + url + " — " + raw.slice(0, 120));
    try { return JSON.parse(raw); } catch (e) {
      throw new Error("Health not JSON @ " + url + " — " + raw.slice(0, 120));
    }
  }

  window.MigasStorage = {
    testConnection,
    openModal,
    saveDevice,
    listVps,
    loadVps,
    saveVps,
    apiBase,
    setApiBase(url) {
      localStorage.setItem("migas-api-base", (url || "").replace(/\/$/, ""));
    },
    setToken(t) {
      localStorage.setItem(TOKEN_KEY, t || "");
    },
  };

  document.addEventListener("DOMContentLoaded", bind);
})();
