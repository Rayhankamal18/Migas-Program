#!/usr/bin/env python3
"""
Migas Portable launcher
- Starts local API + static file server
- Opens the app in your default browser
- Saves projects under ./migas_data/ next to this program (changeable in Settings)
"""
from __future__ import annotations

import os
import sys
import threading
import time
import webbrowser
from pathlib import Path

# When frozen by PyInstaller, resources are in _MEIPASS or next to exe
if getattr(sys, "frozen", False):
    BASE = Path(sys.executable).resolve().parent
    # bundled files may be extracted to _MEIPASS
    BUNDLE = Path(getattr(sys, "_MEIPASS", BASE))
else:
    BASE = Path(__file__).resolve().parent
    BUNDLE = BASE

os.environ.setdefault("MIGAS_SAVE_DIR", str(BASE / "migas_data" / "savefile"))
os.environ.setdefault("MIGAS_MODEL_DIR", str(BASE / "migas_data" / "ml_model"))
os.environ.setdefault("MIGAS_JOB_DIR", str(BASE / "migas_data" / "jobs"))
os.environ.setdefault("MIGAS_UPLOAD_DIR", str(BASE / "migas_data" / "uploads"))
os.environ.setdefault("MIGAS_API_TOKEN", "")
# Python used for AutoML training. NEVER the frozen exe itself (it would just start another
# server instead of the worker). server/app.py:find_python() resolves .venv next to the exe.
if not getattr(sys, "frozen", False):
    os.environ.setdefault("MIGAS_PYTHON", sys.executable)

# Make server package importable
SERVER_DIR = BUNDLE / "server"
if not SERVER_DIR.is_dir():
    SERVER_DIR = BASE / "server"
sys.path.insert(0, str(SERVER_DIR))
sys.path.insert(0, str(BUNDLE))

PORT = int(os.environ.get("MIGAS_PORT", "5055"))
HOST = "127.0.0.1"


def create_app():
    from flask import Flask, send_from_directory, jsonify, request
    from flask_cors import CORS

    # Import after env is set
    import importlib
    # ensure config sees env
    if "config" in sys.modules:
        del sys.modules["config"]
    import config  # noqa: F401

    # Load API routes from app.py without running its __main__
    # We re-use the same Flask app module
    app_path = SERVER_DIR / "app.py"
    if not app_path.is_file():
        raise SystemExit(f"server/app.py not found at {app_path}")

    # Import the existing app module
    import importlib.util
    spec = importlib.util.spec_from_file_location("migas_api_app", app_path)
    mod = importlib.util.module_from_spec(spec)
    # Provide package-like context
    sys.modules["migas_api_app"] = mod
    # config must be loadable as "config"
    spec.loader.exec_module(mod)
    api_app = mod.app

    # Static frontend root
    static_root = BUNDLE if (BUNDLE / "Migas Program.html").is_file() else BASE
    if not (static_root / "Migas Program.html").is_file():
        # try alternate names
        for name in ("migas.html", "index.html"):
            if (static_root / name).is_file():
                break

    CORS(api_app)

    @api_app.route("/")
    def index():
        # Prefer migas.html then Migas Program.html
        for name in ("migas.html", "Migas Program.html", "index.html"):
            p = static_root / name
            if p.is_file():
                return send_from_directory(str(static_root), name)
        return jsonify({"ok": False, "error": "Frontend HTML not found"}), 404

    @api_app.route("/<path:path>")
    def static_proxy(path):
        # Do not shadow /api/*
        if path.startswith("api/") or path == "api":
            return jsonify({"ok": False, "error": "Not found"}), 404
        target = static_root / path
        if target.is_file():
            return send_from_directory(str(static_root), path)
        # nested
        folder = target.parent
        if folder.is_dir() and target.is_file():
            return send_from_directory(str(folder), target.name)
        return jsonify({"ok": False, "error": "Not found"}), 404

    # Portable: change data directory at runtime
    @api_app.post("/api/portable/set-data-dir")
    def set_data_dir():
        body = request.get_json(silent=True) or {}
        path = (body.get("path") or "").strip()
        if not path:
            return jsonify({"ok": False, "error": "path required"}), 400
        # safety: absolute path only, no empty
        path = os.path.abspath(path)
        try:
            os.makedirs(path, exist_ok=True)
            save = os.path.join(path, "savefile")
            models = os.path.join(path, "ml_model")
            jobs = os.path.join(path, "jobs")
            uploads = os.path.join(path, "uploads")
            for d in (save, models, jobs, uploads):
                os.makedirs(d, exist_ok=True)
            # update live config module
            import config as cfg
            cfg.SAVE_DIR = save
            cfg.MODEL_DIR = models
            cfg.JOB_DIR = jobs
            cfg.UPLOAD_DIR = uploads
            # persist choice next to app
            marker = BASE / "migas_data_path.txt"
            marker.write_text(path, encoding="utf-8")
            return jsonify({"ok": True, "path": path, "save_dir": save})
        except Exception as err:
            return jsonify({"ok": False, "error": str(err)}), 500

    @api_app.get("/api/portable/data-dir")
    def get_data_dir():
        import config as cfg
        return jsonify({
            "ok": True,
            "save_dir": cfg.SAVE_DIR,
            "model_dir": cfg.MODEL_DIR,
            "app_root": str(BASE),
        })

    return api_app


def load_saved_data_dir():
    marker = BASE / "migas_data_path.txt"
    if marker.is_file():
        path = marker.read_text(encoding="utf-8").strip()
        if path:
            os.environ["MIGAS_SAVE_DIR"] = str(Path(path) / "savefile")
            os.environ["MIGAS_MODEL_DIR"] = str(Path(path) / "ml_model")
            os.environ["MIGAS_JOB_DIR"] = str(Path(path) / "jobs")
            os.environ["MIGAS_UPLOAD_DIR"] = str(Path(path) / "uploads")


def main():
    load_saved_data_dir()
    app = create_app()

    url = f"http://{HOST}:{PORT}/"
    print("=" * 50)
    print("  Migas Portable")
    print(f"  Open: {url}")
    print(f"  Data: {os.environ.get('MIGAS_SAVE_DIR')}")
    print("  Press Ctrl+C to stop")
    print("=" * 50)

    def open_browser():
        time.sleep(0.8)
        try:
            webbrowser.open(url)
        except Exception:
            pass

    threading.Thread(target=open_browser, daemon=True).start()

    # Use waitress if available, else flask dev server
    try:
        from waitress import serve
        serve(app, host=HOST, port=PORT, threads=4)
    except ImportError:
        app.run(host=HOST, port=PORT, debug=False, threaded=True)


if __name__ == "__main__":
    main()
