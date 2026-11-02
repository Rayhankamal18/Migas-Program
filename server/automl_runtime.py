"""Load saved AutoML bundles (Alex zip + multiclass pipeline) for in-process predict."""
from __future__ import annotations

import os
import tempfile
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

import numpy as np
import pandas as pd

# Cache loaded Alex (model, de) by absolute joblib path
_ALEX_CACHE: Dict[str, Tuple[Any, Any, str]] = {}


def _prepare_frame(df: pd.DataFrame, features, safe_names) -> pd.DataFrame:
    X = df[[f for f in features if f in df.columns]].copy()
    for f in features:
        if f not in X.columns:
            X[f] = None
    X = X[features]
    if safe_names:
        X = X.rename(columns=safe_names)
    for c in X.columns:
        if pd.api.types.is_numeric_dtype(X[c]):
            X[c] = pd.to_numeric(X[c], errors="coerce").astype("float64")
        else:
            coerced = pd.to_numeric(X[c], errors="coerce")
            if coerced.notna().mean() >= 0.8:
                X[c] = coerced.astype("float64")
            else:
                X[c] = X[c].astype(object)
    return X


def load_alex(bundle: dict, model_path: str):
    """Load BestSingleModel + DataPrepare from opt_zip / de_zip next to the joblib."""
    key = str(Path(model_path).resolve())
    if key in _ALEX_CACHE:
        return _ALEX_CACHE[key]

    import automl_worker as W
    from automl_alex import BestSingleModelClassifier, BestSingleModelRegressor, DataPrepare

    W.patch_lightgbm()
    folder = str(Path(model_path).resolve().parent) + os.sep
    task = bundle.get("task")
    cls = BestSingleModelClassifier if task == "classification" else BestSingleModelRegressor
    opt_zip = bundle.get("opt_zip") or ""
    de_zip = bundle.get("de_zip") or ""
    if not opt_zip.endswith(".zip"):
        raise RuntimeError("Bundle missing opt_zip — retrain the model.")
    scratch = tempfile.mkdtemp(prefix="migas_alex_")
    prev = os.getcwd()
    try:
        os.chdir(scratch)
        model = cls().load(name=opt_zip[:-4], folder=folder, verbose=0)
        de = DataPrepare().load(name=de_zip[:-4], folder=folder) if de_zip.endswith(".zip") else None
    finally:
        os.chdir(prev)
    _ALEX_CACHE[key] = (model, de, scratch)
    return _ALEX_CACHE[key]


def predict_bundle(bundle: dict, model_path: str, rows: list) -> dict:
    """
    Predict from list-of-dicts using original feature names.
    Returns {ok, predictions, probabilities?, class_names?, task, target, features}.
    """
    features = list(bundle.get("features") or [])
    target = bundle.get("target")
    task = bundle.get("task") or "regression"
    class_names = bundle.get("class_names")
    safe_names = bundle.get("safe_names") or {}

    clean = []
    for r in rows:
        if not isinstance(r, dict):
            continue
        rr = {k: v for k, v in r.items() if k != target}
        for f in features:
            if f not in rr:
                rr[f] = None
        clean.append(rr)
    if not clean:
        return {"ok": False, "error": "No valid feature rows."}

    df = pd.DataFrame(clean)
    X = _prepare_frame(df, features, safe_names)

    if bundle.get("kind") == "multiclass_lgbm":
        pipe = bundle["pipeline"]
        proba = np.asarray(pipe.predict_proba(X))
        labs = proba.argmax(axis=1)
        names = list(class_names) if class_names else [str(i) for i in range(proba.shape[1])]
        return {
            "ok": True,
            "predictions": [names[int(i)] for i in labs],
            "probabilities": proba.tolist(),
            "class_names": names,
            "target": target,
            "features": features,
            "task": task,
        }

    if bundle.get("opt_zip"):
        model, de, _ = load_alex(bundle, model_path)
        Xp = de.transform(X) if de is not None else X
        cols = bundle.get("prepared_columns")
        if cols:
            Xp = Xp.reindex(columns=cols, fill_value=0)
        p = np.asarray(model.predict(Xp))
        if p.ndim == 2:
            p = p[:, -1] if p.shape[1] > 1 else p[:, 0]
        p = p.reshape(-1)
        if task == "classification":
            lab = (p >= 0.5).astype(int)
            names = list(class_names) if class_names else ["0", "1"]
            return {
                "ok": True,
                "predictions": [names[int(i)] if int(i) < len(names) else str(i) for i in lab],
                "probabilities": [[float(1 - v), float(v)] for v in p],
                "class_names": names,
                "target": target,
                "features": features,
                "task": task,
                "scores": [float(v) for v in p],
            }
        return {
            "ok": True,
            "predictions": [float(v) for v in p],
            "target": target,
            "features": features,
            "task": task,
        }

    # Legacy in-memory bundle
    model = bundle.get("model")
    de = bundle.get("data_prepare")
    if model is None:
        return {"ok": False, "error": "Model artifacts incomplete — retrain."}
    Xp = de.transform(X) if de is not None else X
    cols = bundle.get("prepared_columns")
    if cols:
        Xp = Xp.reindex(columns=cols, fill_value=0)
    p = np.asarray(model.predict(Xp)).reshape(-1)
    if task == "classification":
        lab = (p >= 0.5).astype(int)
        names = list(class_names) if class_names else ["0", "1"]
        return {
            "ok": True,
            "predictions": [names[int(i)] if int(i) < len(names) else str(i) for i in lab],
            "probabilities": [[float(1 - v), float(v)] for v in p],
            "class_names": names,
            "target": target,
            "features": features,
            "task": task,
            "scores": [float(v) for v in p],
        }
    return {
        "ok": True,
        "predictions": [float(v) for v in p],
        "target": target,
        "features": features,
        "task": task,
    }


def predict_one_score(bundle: dict, model_path: str, xdict: dict) -> Tuple[Optional[np.ndarray], Any, Optional[list]]:
    """
    For optimize-inputs: returns (proba_or_None, display_y, class_names_or_None).
    For regression: (None, float_y, None) — caller uses float.
    Actually returns same shape as previous app.py predict_one for classification:
      (proba, pred_label, names) or for regression we return (float, float, None) differently.

    Unified: always returns dict from predict_bundle for one row, caller extracts.
    """
    out = predict_bundle(bundle, model_path, [xdict])
    if not out.get("ok"):
        raise RuntimeError(out.get("error") or "predict failed")
    task = out.get("task")
    if task == "classification":
        proba = np.asarray(out["probabilities"][0], dtype=float)
        return proba, out["predictions"][0], out.get("class_names")
    # regression — also expose raw score if present
    y = float(out["predictions"][0])
    return y, y, None
