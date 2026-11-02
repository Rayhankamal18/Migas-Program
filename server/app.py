#!/usr/bin/env python3
"""Migas backend: project JSON save/load + AutoML job API."""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import traceback
import uuid
from datetime import datetime, timezone
from pathlib import Path

from flask import Flask, jsonify, request, send_file
from flask_cors import CORS

from config import SAVE_DIR, MODEL_DIR, JOB_DIR, UPLOAD_DIR, MAX_UPLOAD_MB, API_TOKEN

app = Flask(__name__)
CORS(app)

SAFE_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._\- ]{0,180}$")
JOBS = {}
JOB_LOCK = threading.Lock()


ANSI_RE = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")


def _app_root() -> Path:
    from config import APP_ROOT
    return Path(APP_ROOT)


def find_python() -> str:
    """Python that has automl_alex installed.

    When running as the frozen MigasPortable.exe, sys.executable IS the exe — launching it
    with a script path would just start another Migas server instead of the worker. So look
    for the project's .venv next to the exe (or any python on PATH) instead.
    """
    env = (os.environ.get("MIGAS_PYTHON") or "").strip()
    frozen = getattr(sys, "frozen", False)
    if env and Path(env).is_file():
        if not (frozen and Path(env).resolve() == Path(sys.executable).resolve()):
            return env
    root = _app_root()
    cands = [
        root / ".venv" / "Scripts" / "python.exe",
        root / "venv" / "Scripts" / "python.exe",
        root / ".venv" / "bin" / "python",
        root / "venv" / "bin" / "python",
        root.parent / ".venv" / "Scripts" / "python.exe",
    ]
    for c in cands:
        if c.is_file():
            return str(c)
    if not frozen:
        return sys.executable
    for name in ("python", "python3", "py"):
        p = shutil.which(name)
        if p:
            return p
    raise RuntimeError(
        "No Python found for AutoML. Put the .venv folder next to MigasPortable.exe "
        "(run Install_Or_Update.bat once) or install Python 3.10/3.11."
    )


def script_path(name: str) -> Path:
    """Prefer server/<name> next to the exe (editable without rebuilding), else the bundled copy."""
    ext = _app_root() / "server" / name
    if ext.is_file():
        return ext
    return Path(__file__).resolve().parent / name


def _popen_flags():
    return getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0


def utc_now():
    return datetime.now(timezone.utc).isoformat()


def require_auth():
    if not API_TOKEN:
        return None
    token = request.headers.get("X-Migas-Token") or request.args.get("token")
    if not token:
        auth = request.headers.get("Authorization") or ""
        if auth.lower().startswith("bearer "):
            token = auth[7:].strip()
    if token != API_TOKEN:
        return jsonify({"ok": False, "error": "Unauthorized. Set header X-Migas-Token or Authorization: Bearer."}), 401
    return None


def safe_json_name(name: str) -> str | None:
    name = (name or "").strip()
    if name.lower().endswith(".json"):
        name = name[:-5]
    if not SAFE_NAME.match(name):
        return None
    if ".." in name or "/" in name or "\\" in name:
        return None
    return name + ".json"


def safe_model_name(name: str) -> str | None:
    name = (name or "").strip()
    if name.lower().endswith(".joblib"):
        name = name[:-7]
    if not SAFE_NAME.match(name):
        return None
    if ".." in name or "/" in name or "\\" in name:
        return None
    return name + ".joblib"


def file_info(path: Path):
    st = path.stat()
    return {
        "name": path.name,
        "size": st.st_size,
        "modified": datetime.fromtimestamp(st.st_mtime, timezone.utc).isoformat(),
    }


@app.get("/api/health")
def health():
    return jsonify({
        "ok": True,
        "save_dir": SAVE_DIR,
        "model_dir": MODEL_DIR,
        "time": utc_now(),
    })


@app.get("/api/files")
def list_files():
    denied = require_auth()
    if denied:
        return denied
    root = Path(SAVE_DIR)
    files = sorted(
        [file_info(p) for p in root.glob("*.json") if p.is_file()],
        key=lambda x: x["modified"],
        reverse=True,
    )
    return jsonify({"ok": True, "files": files, "folder": SAVE_DIR})


@app.get("/api/files/<name>")
def get_file(name):
    denied = require_auth()
    if denied:
        return denied
    safe = safe_json_name(name)
    if not safe:
        return jsonify({"ok": False, "error": "Invalid file name."}), 400
    path = Path(SAVE_DIR) / safe
    if not path.is_file():
        return jsonify({"ok": False, "error": "File not found."}), 404
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return jsonify({"ok": False, "error": "File is not valid JSON."}), 400
    if not isinstance(data, dict) or data.get("kind") not in (None, "gambar-sumur"):
        # allow any object JSON for flexibility, but warn
        pass
    return jsonify({"ok": True, "name": safe, "data": data, "info": file_info(path)})


@app.post("/api/files")
def save_file():
    denied = require_auth()
    if denied:
        return denied
    body = request.get_json(silent=True) or {}
    name = body.get("name") or ""
    data = body.get("data")
    overwrite = bool(body.get("overwrite"))
    safe = safe_json_name(name)
    if not safe:
        return jsonify({"ok": False, "error": "Invalid file name. Use letters, numbers, space, . _ -"}), 400
    if data is None or not isinstance(data, (dict, list)):
        return jsonify({"ok": False, "error": "Body must include JSON object field 'data'."}), 400
    path = Path(SAVE_DIR) / safe
    if path.exists() and not overwrite:
        return jsonify({
            "ok": False,
            "error": "File already exists.",
            "exists": True,
            "name": safe,
        }), 409
    try:
        path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    except Exception as err:
        return jsonify({"ok": False, "error": f"Could not write file: {err}"}), 500
    return jsonify({"ok": True, "name": safe, "info": file_info(path)})


@app.get("/api/models")
def list_models():
    denied = require_auth()
    if denied:
        return denied
    root = Path(MODEL_DIR)
    files = []
    for p in root.glob("*.joblib"):
        meta_path = p.with_suffix(".json")
        meta = {}
        if meta_path.is_file():
            try:
                meta = json.loads(meta_path.read_text(encoding="utf-8"))
            except Exception:
                meta = {}
        info = file_info(p)
        info["task"] = meta.get("task")
        info["target"] = meta.get("target")
        info["created"] = meta.get("created") or info["modified"]
        files.append(info)
    files.sort(key=lambda x: x.get("created") or "", reverse=True)
    return jsonify({"ok": True, "files": files, "folder": MODEL_DIR})



@app.get("/api/models/<name>")
def automl_model_meta(name):
    """Return saved model metadata so the UI can jump to predict without retraining."""
    denied = require_auth()
    if denied:
        return denied
    safe = safe_model_name(name or "")
    if not safe:
        return jsonify({"ok": False, "error": "Invalid name."}), 400
    path = Path(MODEL_DIR) / safe
    if not path.is_file() and not str(safe).endswith(".joblib"):
        alt = Path(MODEL_DIR) / f"{safe}.joblib"
        if alt.is_file():
            path = alt
            safe = alt.name
    if not path.is_file():
        return jsonify({"ok": False, "error": "Model file not found."}), 404

    meta = {
        "ok": True,
        "model_file": path.name,
        "path": str(path),
    }
    # sidecar json written at train time
    side = path.with_suffix(".json")
    # also automl_<id>.json pattern next to automl_<id>.joblib
    if not side.is_file():
        stem = path.stem
        side2 = path.parent / f"{stem}.json"
        side = side2 if side2.is_file() else side
    if side.is_file():
        try:
            meta.update(json.loads(side.read_text(encoding="utf-8")))
        except Exception:
            pass
    # class_names / features from joblib if missing
    try:
        import joblib
        bundle = joblib.load(path)
        meta.setdefault("features", bundle.get("features"))
        meta.setdefault("target", bundle.get("target"))
        meta.setdefault("task", bundle.get("task"))
        meta.setdefault("class_names", bundle.get("class_names"))
        meta.setdefault("best_model_name", bundle.get("best_model_name"))
        meta.setdefault("metric", bundle.get("metric"))
        meta["kind"] = bundle.get("kind")
    except Exception as e:
        meta["bundle_warning"] = str(e)
    meta["ok"] = True
    meta["model_file"] = path.name
    return jsonify(meta)



@app.post("/api/automl/upload")
def automl_upload():
    denied = require_auth()
    if denied:
        return denied
    if "file" not in request.files:
        return jsonify({"ok": False, "error": "No file uploaded."}), 400
    f = request.files["file"]
    if not f.filename:
        return jsonify({"ok": False, "error": "Empty file name."}), 400
    # size check
    f.seek(0, os.SEEK_END)
    size = f.tell()
    f.seek(0)
    if size > MAX_UPLOAD_MB * 1024 * 1024:
        return jsonify({"ok": False, "error": f"File too large (max {MAX_UPLOAD_MB} MB)."}), 400
    job_id = uuid.uuid4().hex[:12]
    dest = Path(UPLOAD_DIR) / f"{job_id}.csv"
    f.save(dest)
    # preview with pandas
    try:
        import math
        import numpy as np
        import pandas as pd

        def clean(obj):
            """Make a structure safe for strict JSON (no NaN/Inf/numpy types)."""
            if obj is None:
                return None
            if isinstance(obj, dict):
                return {str(k): clean(v) for k, v in obj.items()}
            if isinstance(obj, (list, tuple)):
                return [clean(v) for v in obj]
            if isinstance(obj, (np.integer,)):
                return int(obj)
            if isinstance(obj, (np.floating, float)):
                v = float(obj)
                if math.isnan(v) or math.isinf(v):
                    return None
                return v
            if isinstance(obj, (np.bool_, bool)):
                return bool(obj)
            if isinstance(obj, (pd.Timestamp,)):
                return obj.isoformat()
            if isinstance(obj, (np.ndarray,)):
                return clean(obj.tolist())
            if pd.isna(obj):
                return None
            return obj

        # sep=None → python engine sniffs comma/semicolon/tab
        df = pd.read_csv(dest, sep=None, engine="python", encoding="utf-8-sig")
        df.columns = [str(c).replace("\ufeff", "").strip() for c in df.columns]
        cols = []
        for c in df.columns:
            s = df[c]
            missing = int(s.isna().sum())
            if pd.api.types.is_numeric_dtype(s):
                ctype = "numeric"
            else:
                ctype = "text"
            cols.append({"name": str(c), "type": ctype, "missing": missing})
        head = df.head(5).astype(object).where(pd.notnull(df.head(5)), None).to_dict(orient="records")
        tail = df.tail(5).astype(object).where(pd.notnull(df.tail(5)), None).to_dict(orient="records")
        payload = clean({
            "ok": True,
            "upload_id": job_id,
            "rows": int(len(df)),
            "cols": int(df.shape[1]),
            "columns": cols,
            "head": head,
            "tail": tail,
        })
        return app.response_class(
            response=json.dumps(payload, allow_nan=False),
            status=200,
            mimetype="application/json",
        )
    except Exception as err:
        return jsonify({"ok": False, "error": f"Could not read CSV: {err}"}), 400




@app.get("/api/automl/uploads")
def automl_list_uploads():
    """List CSV files already in the uploads data folder."""
    denied = require_auth()
    if denied:
        return denied
    root = Path(UPLOAD_DIR)
    files = []
    for p in sorted(root.glob("*.csv"), key=lambda x: x.stat().st_mtime, reverse=True):
        if not p.is_file():
            continue
        st = p.stat()
        files.append({
            "name": p.name,
            "stem": p.stem,
            "size": st.st_size,
            "modified": datetime.fromtimestamp(st.st_mtime, timezone.utc).isoformat(),
        })
    return jsonify({"ok": True, "files": files, "folder": str(root)})


@app.post("/api/automl/use-upload")
def automl_use_upload():
    """Register an existing file in uploads/ as the active CSV (preview like upload)."""
    denied = require_auth()
    if denied:
        return denied
    body = request.get_json(silent=True) or {}
    name = (body.get("name") or "").strip()
    if not name or ".." in name or "/" in name or "\\" in name:
        return jsonify({"ok": False, "error": "Invalid file name."}), 400
    if not name.lower().endswith(".csv"):
        name = name + ".csv"
    src = Path(UPLOAD_DIR) / name
    if not src.is_file():
        return jsonify({"ok": False, "error": f"File not found in uploads: {name}"}), 404
    # Use stem as upload_id if it looks like a prior upload id, else copy to new id
    stem = src.stem
    import re
    if re.match(r"^[a-f0-9]{8,}$", stem):
        job_id = stem
        dest = src
    else:
        job_id = uuid.uuid4().hex[:12]
        dest = Path(UPLOAD_DIR) / f"{job_id}.csv"
        if dest.resolve() != src.resolve():
            import shutil
            shutil.copy2(src, dest)
    try:
        import math
        import numpy as np
        import pandas as pd

        def clean(obj):
            if obj is None:
                return None
            if isinstance(obj, dict):
                return {str(k): clean(v) for k, v in obj.items()}
            if isinstance(obj, (list, tuple)):
                return [clean(v) for v in obj]
            if isinstance(obj, (np.integer,)):
                return int(obj)
            if isinstance(obj, (np.floating, float)):
                v = float(obj)
                if math.isnan(v) or math.isinf(v):
                    return None
                return v
            if isinstance(obj, (np.bool_, bool)):
                return bool(obj)
            if isinstance(obj, (pd.Timestamp,)):
                return obj.isoformat()
            if isinstance(obj, (np.ndarray,)):
                return clean(obj.tolist())
            try:
                if pd.isna(obj):
                    return None
            except Exception:
                pass
            return obj

        df = pd.read_csv(dest, sep=None, engine="python")
        cols = []
        for c in df.columns:
            s = df[c]
            missing = int(s.isna().sum())
            ctype = "numeric" if pd.api.types.is_numeric_dtype(s) else "text"
            cols.append({"name": str(c), "type": ctype, "missing": missing})
        head = df.head(5).astype(object).where(pd.notnull(df.head(5)), None).to_dict(orient="records")
        tail = df.tail(5).astype(object).where(pd.notnull(df.tail(5)), None).to_dict(orient="records")
        payload = clean({
            "ok": True,
            "upload_id": job_id,
            "source_name": name,
            "rows": int(len(df)),
            "cols": int(df.shape[1]),
            "columns": cols,
            "head": head,
            "tail": tail,
        })
        return app.response_class(
            response=json.dumps(payload, allow_nan=False),
            status=200,
            mimetype="application/json",
        )
    except Exception as err:
        return jsonify({"ok": False, "error": f"Could not read CSV: {err}"}), 400


@app.post("/api/automl/train")
def automl_train():
    denied = require_auth()
    if denied:
        return denied
    body = request.get_json(silent=True) or {}
    upload_id = body.get("upload_id")
    target = body.get("target")
    features = body.get("features") or []
    task = body.get("task")  # classification | regression
    test_size = float(body.get("test_size") or 0.2)
    random_state = int(body.get("random_state") or 42)
    timeout = int(body.get("timeout") or 300)
    models_names = body.get("models_names") or None
    force_classification = bool(body.get("force_classification"))

    if not upload_id or not SAFE_NAME.match(str(upload_id)):
        return jsonify({"ok": False, "error": "Invalid upload_id."}), 400
    csv_path = Path(UPLOAD_DIR) / f"{upload_id}.csv"
    if not csv_path.is_file():
        return jsonify({"ok": False, "error": "CSV not found. Upload again."}), 404
    if not target or not features:
        return jsonify({"ok": False, "error": "Choose target Y and at least one input X."}), 400

    job_id = uuid.uuid4().hex[:12]
    job = {
        "id": job_id,
        "status": "queued",
        "created": utc_now(),
        "progress": 0,
        "log": [],
        "result": None,
        "error": None,
        "cancel": False,
    }
    with JOB_LOCK:
        JOBS[job_id] = job

    cfg = {
        "job_id": job_id,
        "csv_path": str(csv_path),
        "target": target,
        "features": features,
        "task": task,
        "test_size": test_size,
        "random_state": random_state,
        "timeout": timeout,
        "models_names": models_names,
        "force_classification": force_classification,
        "max_rows": body.get("max_rows"),
        "max_cols": body.get("max_cols"),
        "model_dir": MODEL_DIR,
        "job_dir": JOB_DIR,
    }
    cfg_path = Path(JOB_DIR) / f"{job_id}.json"
    cfg_path.write_text(json.dumps(cfg), encoding="utf-8")

    def runner():
        try:
            py = find_python()
            worker = script_path("automl_worker.py")
            with JOB_LOCK:
                JOBS[job_id]["status"] = "running"
                JOBS[job_id]["log"].append(f"{utc_now()} Training started")
                JOBS[job_id]["log"].append(f"python: {py}")
                JOBS[job_id]["log"].append(f"worker: {worker}")
            env = dict(os.environ)
            env["PYTHONUNBUFFERED"] = "1"
            env["PYTHONIOENCODING"] = "utf-8"
            env["NO_COLOR"] = "1"
            env["LOGURU_COLORIZE"] = "false"
            proc = subprocess.Popen(
                [py, "-u", str(worker), str(cfg_path)],
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                encoding="utf-8",
                errors="replace",
                env=env,
                cwd=str(JOB_DIR),
                creationflags=_popen_flags(),
            )
            with JOB_LOCK:
                JOBS[job_id]["proc"] = proc
            for line in proc.stdout:
                line = ANSI_RE.sub("", line.rstrip())
                if not line:
                    continue
                with JOB_LOCK:
                    if JOBS[job_id].get("cancel"):
                        break
                    if line.startswith("PROGRESS "):
                        try:
                            JOBS[job_id]["progress"] = int(float(line.split()[1]))
                        except Exception:
                            pass
                        continue  # keep progress markers out of the visible log
                    if JOBS[job_id]["log"] and JOBS[job_id]["log"][-1] == line:
                        continue  # collapse repeated identical warnings
                    JOBS[job_id]["log"].append(line)
                    if len(JOBS[job_id]["log"]) > 600:
                        del JOBS[job_id]["log"][:200]
            code = proc.wait()
            with JOB_LOCK:
                cancelled = JOBS[job_id].get("cancel")
            if cancelled:
                with JOB_LOCK:
                    JOBS[job_id]["status"] = "cancelled"
                    JOBS[job_id]["log"].append(f"{utc_now()} Cancelled by user")
                return
            result_path = Path(JOB_DIR) / f"{job_id}_result.json"
            if code == 0 and result_path.is_file():
                result = json.loads(result_path.read_text(encoding="utf-8"))
                with JOB_LOCK:
                    JOBS[job_id]["status"] = "done"
                    JOBS[job_id]["progress"] = 100
                    JOBS[job_id]["result"] = result
                    JOBS[job_id]["log"].append(f"{utc_now()} Training finished")
            else:
                with JOB_LOCK:
                    tail = [l for l in JOBS[job_id]["log"] if l.strip()][-6:]
                    JOBS[job_id]["status"] = "error"
                    JOBS[job_id]["error"] = f"Worker exited with code {code}. " + " | ".join(tail)
        except Exception as err:
            with JOB_LOCK:
                JOBS[job_id]["status"] = "error"
                JOBS[job_id]["error"] = str(err)
                JOBS[job_id]["log"].append(traceback.format_exc())
        finally:
            with JOB_LOCK:
                JOBS.get(job_id, {}).pop("proc", None)

    threading.Thread(target=runner, daemon=True).start()
    return jsonify({"ok": True, "job_id": job_id})


@app.get("/api/automl/jobs/<job_id>")
def automl_job(job_id):
    denied = require_auth()
    if denied:
        return denied
    with JOB_LOCK:
        job = JOBS.get(job_id)
        if not job:
            # try load result from disk
            result_path = Path(JOB_DIR) / f"{job_id}_result.json"
            if result_path.is_file():
                return jsonify({
                    "ok": True,
                    "job": {
                        "id": job_id,
                        "status": "done",
                        "progress": 100,
                        "result": json.loads(result_path.read_text(encoding="utf-8")),
                        "log": [],
                    },
                })
            return jsonify({"ok": False, "error": "Job not found."}), 404
        pub = {k: v for k, v in job.items() if k != "proc"}
        return jsonify({"ok": True, "job": pub})


@app.post("/api/automl/jobs/<job_id>/cancel")
def automl_cancel(job_id):
    denied = require_auth()
    if denied:
        return denied
    with JOB_LOCK:
        job = JOBS.get(job_id)
        if not job:
            return jsonify({"ok": False, "error": "Job not found."}), 404
        job["cancel"] = True
        proc = job.get("proc")
    if proc is not None:
        try:
            if os.name == "nt":
                subprocess.run(["taskkill", "/F", "/T", "/PID", str(proc.pid)],
                               capture_output=True, creationflags=_popen_flags())
            else:
                proc.terminate()
        except Exception:
            pass
    return jsonify({"ok": True})


@app.post("/api/automl/predict")
def automl_predict():
    """Predict rows. Small batches run in-process (fast); large ones use worker subprocess."""
    denied = require_auth()
    if denied:
        return denied
    body = request.get_json(silent=True) or {}
    model_name = body.get("model_name")
    rows = body.get("rows")  # list of dicts
    mode = (body.get("mode") or "predict").strip()  # predict | optimize
    safe = safe_model_name(model_name or "")
    if not safe:
        return jsonify({"ok": False, "error": "Invalid model_name."}), 400
    path = Path(MODEL_DIR) / safe
    if not path.is_file():
        # allow name without .joblib
        if not str(safe).endswith(".joblib"):
            path = Path(MODEL_DIR) / f"{safe}.joblib"
        if not path.is_file():
            return jsonify({"ok": False, "error": f"Model not found: {safe}"}), 404
    if not isinstance(rows, list) or not rows:
        return jsonify({"ok": False, "error": "rows must be a non-empty list of objects."}), 400

    # --- fast path (same process) ---
    try:
        import numpy as np
        import pandas as pd
        import joblib
        bundle = joblib.load(path)
        features = list(bundle.get("features") or [])
        target = bundle.get("target")
        task = bundle.get("task") or "regression"
        class_names = bundle.get("class_names")
        safe_names = bundle.get("safe_names") or {}
        # drop target if client sent it
        clean_rows = []
        for r in rows:
            if not isinstance(r, dict):
                continue
            rr = {k: v for k, v in r.items() if k != target and k in features}
            # fill missing features with None
            for f in features:
                if f not in rr:
                    rr[f] = None
            clean_rows.append(rr)
        if not clean_rows:
            return jsonify({"ok": False, "error": "No valid feature rows."}), 400
        df = pd.DataFrame(clean_rows)
        # rename to safe internal names if needed
        if safe_names:
            df = df.rename(columns=safe_names)
            feat_cols = [safe_names.get(f, f) for f in features]
        else:
            feat_cols = features
        missing = [c for c in feat_cols if c not in df.columns]
        if missing:
            return jsonify({"ok": False, "error": f"Missing columns: {missing}"}), 400
        X = df[feat_cols].copy()
        for c in X.columns:
            if pd.api.types.is_numeric_dtype(X[c]):
                X[c] = pd.to_numeric(X[c], errors="coerce")
            else:
                X[c] = X[c].astype(object)

        if bundle.get("kind") == "multiclass_lgbm":
            pipe = bundle["pipeline"]
            proba = pipe.predict_proba(X)
            labs = proba.argmax(axis=1)
            names = class_names or [str(i) for i in range(proba.shape[1])]
            preds = [names[int(i)] for i in labs]
            out = {
                "ok": True,
                "predictions": preds,
                "probabilities": proba.tolist(),
                "class_names": names,
                "target": target,
                "features": features,
                "task": task,
            }
            return jsonify(out)

        model = bundle.get("model")
        de = bundle.get("data_prepare")
        if de is not None:
            try:
                Xp = de.transform(X)
            except Exception:
                Xp = X
        else:
            Xp = X
        cols = bundle.get("prepared_columns")
        if cols:
            Xp = Xp.reindex(columns=cols, fill_value=0)
        p = np.asarray(model.predict(Xp)).reshape(-1)
        if task == "classification":
            # scores may be proba for positive class
            if p.ndim > 1:
                p = p[:, -1]
            lab = (p >= 0.5).astype(int)
            names = class_names or ["0", "1"]
            preds = [names[int(i)] if int(i) < len(names) else str(i) for i in lab]
            out = {
                "ok": True,
                "predictions": preds,
                "probabilities": [[float(1 - v), float(v)] for v in p],
                "class_names": names,
                "target": target,
                "features": features,
                "task": task,
            }
        else:
            out = {
                "ok": True,
                "predictions": [float(v) for v in p],
                "target": target,
                "features": features,
                "task": task,
            }
        return jsonify(out)
    except Exception as err:
        # fallback to worker for awkward models
        try:
            py = find_python()
            worker = script_path("automl_predict_worker.py")
            with tempfile.TemporaryDirectory() as td:
                rp = Path(td) / "rows.json"
                op = Path(td) / "out.json"
                rp.write_text(json.dumps(rows), encoding="utf-8")
                proc = subprocess.run(
                    [py, str(worker), str(path), str(rp), str(op)],
                    capture_output=True,
                    text=True,
                    timeout=120,
                    creationflags=_popen_flags(),
                )
                if op.is_file():
                    data = json.loads(op.read_text(encoding="utf-8"))
                    return jsonify(data)
                return jsonify({
                    "ok": False,
                    "error": (proc.stderr or proc.stdout or str(err))[:500],
                }), 500
        except Exception as err2:
            return jsonify({"ok": False, "error": f"{type(err).__name__}: {err} | fallback: {err2}"}), 500


@app.post("/api/automl/optimize-inputs")
def automl_optimize_inputs():
    """Search input values X so predicted Y matches a goal (min / max / target).
    Uses Nevergrad when installed; otherwise random search. Does not retrain the model.
    """
    denied = require_auth()
    if denied:
        return denied
    body = request.get_json(silent=True) or {}
    model_name = body.get("model_name")
    safe = safe_model_name(model_name or "")
    if not safe:
        return jsonify({"ok": False, "error": "Invalid model_name."}), 400
    path = Path(MODEL_DIR) / safe
    if not path.is_file() and not str(safe).endswith(".joblib"):
        path = Path(MODEL_DIR) / f"{safe}.joblib"
    if not path.is_file():
        return jsonify({"ok": False, "error": f"Model not found: {safe}"}), 404

    goal = (body.get("goal") or "minimize").strip().lower()
    # regression: minimize | maximize | target
    # classification: max_class_proba | min_class_proba (class_name = original label)
    target_value = body.get("target_value")
    class_name = body.get("class_name")  # original label string for classification
    budget = int(body.get("budget") or 80)
    budget = max(10, min(budget, 500))
    # variables: [{name, min, max, enabled}]
    variables = body.get("variables") or []
    fixed = body.get("fixed") or {}  # name -> value for features not optimized
    cost_weights = body.get("cost_weights") or {}  # name -> weight >= 0
    cost_strength = float(body.get("cost_strength") or 0.0)

    if goal == "target" and target_value is None:
        return jsonify({"ok": False, "error": "target_value required when goal=target"}), 400

    try:
        import numpy as np
        import pandas as pd
        import joblib

        bundle = joblib.load(path)
        features = list(bundle.get("features") or [])
        target = bundle.get("target")
        task = bundle.get("task") or "regression"
        class_names = bundle.get("class_names")
        safe_names = bundle.get("safe_names") or {}

        # only numeric free variables
        free = []
        for v in variables:
            name = v.get("name")
            if not name or name not in features or name == target:
                continue
            if not v.get("enabled", True):
                continue
            try:
                lo = float(v["min"])
                hi = float(v["max"])
            except Exception:
                continue
            if hi < lo:
                lo, hi = hi, lo
            free.append({"name": name, "min": lo, "max": hi})
        if not free:
            return jsonify({"ok": False, "error": "Enable at least one numeric input with min and max."}), 400

        def predict_one(xdict):
            """Returns (score_for_objective, display_y, proba_or_none)."""
            row = dict(fixed)
            row.update(xdict)
            data = {f: row.get(f) for f in features}
            df = pd.DataFrame([data])
            if safe_names:
                df = df.rename(columns=safe_names)
                cols = [safe_names.get(f, f) for f in features]
            else:
                cols = features
            X = df[cols].copy()
            for c in X.columns:
                if pd.api.types.is_numeric_dtype(X[c]):
                    X[c] = pd.to_numeric(X[c], errors="coerce")
                else:
                    X[c] = X[c].astype(object)

            if bundle.get("kind") == "multiclass_lgbm":
                pipe = bundle["pipeline"]
                proba = np.asarray(pipe.predict_proba(X)[0], dtype=float)
                names = list(class_names) if class_names else [str(i) for i in range(len(proba))]
                pred_label = names[int(np.argmax(proba))]
                return proba, pred_label, names

            model = bundle.get("model")
            de = bundle.get("data_prepare")
            Xp = de.transform(X) if de is not None else X
            prep = bundle.get("prepared_columns")
            if prep:
                Xp = Xp.reindex(columns=prep, fill_value=0)
            p = np.asarray(model.predict(Xp)).reshape(-1)
            # Binary AutoML-Alex: predict often returns positive-class score
            if task == "classification":
                score = float(p[0])
                names = list(class_names) if class_names else ["0", "1"]
                # map score to 2-class proba when possible
                if len(names) == 2:
                    proba = np.array([1.0 - score, score], dtype=float)
                else:
                    proba = None
                pred_label = names[1] if score >= 0.5 and len(names) > 1 else names[0]
                return proba if proba is not None else np.array([score]), pred_label, names
            return float(p[0]), float(p[0]), None

        def class_index(names, wanted):
            if not names or wanted is None:
                return None
            w = str(wanted)
            for i, n in enumerate(names):
                if str(n) == w:
                    return i
            try:
                return int(w)
            except Exception:
                return None

        def objective_scalar(xdict):
            out = predict_one(xdict)
            if task == "classification":
                proba, pred_label, names = out
                proba = np.asarray(proba, dtype=float).reshape(-1)
                # classification goals use original class names only
                if goal in ("max_class_proba", "maximize", "min_class_proba", "minimize"):
                    idx = class_index(names, class_name)
                    if idx is None:
                        idx = int(np.argmax(proba))
                    p_cls = float(proba[idx]) if idx < len(proba) else float(np.max(proba))
                    if goal in ("max_class_proba", "maximize"):
                        loss = -p_cls  # maximize probability
                    else:
                        loss = p_cls   # minimize probability
                    yhat = p_cls
                    display = {"class": names[idx] if idx < len(names) else str(idx), "probability": p_cls, "pred_label": pred_label}
                elif goal == "target":
                    # target_value = desired probability for selected class
                    idx = class_index(names, class_name)
                    if idx is None:
                        idx = 0
                    p_cls = float(proba[idx]) if idx < len(proba) else 0.0
                    loss = abs(p_cls - float(target_value or 0))
                    yhat = p_cls
                    display = {"class": names[idx] if names else str(idx), "probability": p_cls, "pred_label": pred_label}
                else:
                    loss = -float(np.max(proba))
                    yhat = float(np.max(proba))
                    display = {"pred_label": pred_label, "probability": yhat}
            else:
                yhat = float(out[0]) if not isinstance(out[0], (list, np.ndarray)) else float(out[0])
                # unpack regression: predict_one returns (float, float, None)
                if isinstance(out, tuple) and len(out) == 3 and not isinstance(out[0], np.ndarray):
                    yhat = float(out[0])
                elif isinstance(out, tuple):
                    yhat = float(out[0]) if np.isscalar(out[0]) else float(np.asarray(out[0]).reshape(-1)[0])
                if goal == "minimize":
                    loss = yhat
                elif goal == "maximize":
                    loss = -yhat
                else:
                    loss = abs(yhat - float(target_value))
                display = yhat

            if cost_strength > 0 and cost_weights:
                c = 0.0
                for v in free:
                    n = v["name"]
                    w = float(cost_weights.get(n) or 0.0)
                    if w <= 0:
                        continue
                    span = v["max"] - v["min"] or 1.0
                    c += w * ((float(xdict[n]) - v["min"]) / span)
                loss = loss + cost_strength * c
            return float(loss), yhat, display

        names = [v["name"] for v in free]
        bounds_lo = np.array([v["min"] for v in free], dtype=float)
        bounds_hi = np.array([v["max"] for v in free], dtype=float)

        best_x = None
        best_loss = float("inf")
        best_y = None
        best_display = None
        history = []
        engine = "random"

        try:
            import nevergrad as ng
            engine = "nevergrad"
            instr = ng.p.Instrumentation(
                **{
                    v["name"]: ng.p.Scalar(lower=v["min"], upper=v["max"])
                    for v in free
                }
            )
            opt = ng.optimizers.NGOpt(parametrization=instr, budget=budget)
            for i in range(budget):
                cand = opt.ask()
                # cand.kwargs or cand.value depending on version
                if hasattr(cand, "kwargs") and cand.kwargs:
                    xdict = dict(cand.kwargs)
                else:
                    val = cand.value
                    if isinstance(val, dict):
                        xdict = dict(val)
                    else:
                        # positional
                        xdict = {names[j]: float(val[j]) for j in range(len(names))}
                loss, yhat, display = objective_scalar(xdict)
                opt.tell(cand, loss)
                history.append({"loss": loss, "y": yhat, "display": display})
                if loss < best_loss:
                    best_loss, best_y, best_x = loss, yhat, xdict
                    best_display = display
        except Exception as ng_err:
            engine = "random"
            rng = np.random.default_rng(42)
            for i in range(budget):
                xdict = {
                    v["name"]: float(rng.uniform(v["min"], v["max"]))
                    for v in free
                }
                loss, yhat, display = objective_scalar(xdict)
                history.append({"loss": loss, "y": yhat, "display": display})
                if loss < best_loss:
                    best_loss, best_y, best_x = loss, yhat, xdict
                    best_display = display

        # merge fixed + best
        full = dict(fixed)
        full.update(best_x or {})
        return jsonify({
            "ok": True,
            "engine": engine,
            "goal": goal,
            "target_value": target_value,
            "best_inputs": best_x,
            "best_inputs_full": full,
            "predicted_y": best_y,
            "predicted_display": best_display,
            "class_name": class_name,
            "objective_loss": best_loss,
            "budget": budget,
            "history": history[-50:],
            "target_name": target,
            "task": task,
            "features": features,
        })
    except Exception as err:
        return jsonify({"ok": False, "error": f"{type(err).__name__}: {err}"}), 500


