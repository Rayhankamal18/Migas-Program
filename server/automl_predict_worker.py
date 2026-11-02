#!/usr/bin/env python3
"""Predict with a saved AutoML bundle. Runs in the project's .venv python (the portable .exe
does not contain automl_alex, so the API calls this script as a subprocess).

usage: automl_predict_worker.py <model.joblib> <rows.json> <out.json>
"""
import json
import os
import sys
import tempfile
import traceback
import warnings

warnings.filterwarnings("ignore")


def main(model_path, rows_path, out_path):
    model_path, rows_path, out_path = (os.path.abspath(p) for p in (model_path, rows_path, out_path))
    out = {"ok": False}
    try:
        import joblib
        import numpy as np
        import pandas as pd

        here = os.path.dirname(os.path.abspath(__file__))
        sys.path.insert(0, here)
        import automl_worker as W  # same compatibility shims as training

        import automl_alex
        from automl_alex import BestSingleModelClassifier, BestSingleModelRegressor

        W.patch_lightgbm()
        bundle = joblib.load(model_path)
        task0 = bundle.get("task")
        if bundle.get("kind") == "multiclass_lgbm":
            with open(rows_path, encoding="utf-8") as fh:
                rows = json.load(fh)
            df = pd.DataFrame(rows)
            df.columns = [str(c).replace("\ufeff", "").strip() for c in df.columns]
            missing = [c for c in bundle["features"] if c not in df.columns]
            if missing:
                out["error"] = "Missing columns: " + ", ".join(missing)
            else:
                X = df[bundle["features"]].rename(columns=bundle.get("safe_names") or {})
                for c in X.columns:
                    try:
                        X[c] = pd.to_numeric(X[c]).astype("float32")
                    except Exception:
                        pass
                proba = bundle["pipeline"].predict_proba(X)
                names = bundle["class_names"]
                out["predictions"] = [names[int(i)] for i in proba.argmax(axis=1)]
                out["probabilities"] = proba.tolist()
                out["class_names"] = names
                out["ok"] = True
            with open(out_path, "w", encoding="utf-8") as fh:
                fh.write(json.dumps(out))
            return
        cls = BestSingleModelClassifier if task0 == "classification" else BestSingleModelRegressor
        # automl-alex writes/reads scratch files in the CWD -> private temp dir
        scratch = tempfile.mkdtemp(prefix="migas_pred_")
        os.chdir(scratch)
        folder = os.path.dirname(os.path.abspath(model_path)) + os.sep
        model = cls().load(name=bundle["opt_zip"][:-4], folder=folder, verbose=0)
        from automl_alex import DataPrepare

        de = DataPrepare().load(name=bundle["de_zip"][:-4], folder=folder)
        features = bundle["features"]
        task = bundle.get("task")
        class_names = bundle.get("class_names")

        with open(rows_path, encoding="utf-8") as fh:
            rows = json.load(fh)
        df = pd.DataFrame(rows)
        df.columns = [str(c).replace("\ufeff", "").strip() for c in df.columns]
        missing = [c for c in features if c not in df.columns]
        if missing:
            out["error"] = "Missing columns: " + ", ".join(missing)
        else:
            X = df[features].copy()
            X = X.rename(columns=bundle.get("safe_names") or {})
            for c in X.columns:
                try:
                    X[c] = pd.to_numeric(X[c]).astype("float32")
                except Exception:
                    pass  # text column: leave as-is for the encoder
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
                names = class_names or ["0", "1"]
                out["predictions"] = [names[int(i)] for i in lab]
                out["probabilities"] = [[float(1 - v), float(v)] for v in p]
                out["class_names"] = names
            else:
                out["predictions"] = [float(v) for v in p]
            out["ok"] = True
    except Exception as e:
        out = {"ok": False, "error": f"{type(e).__name__}: {e}", "trace": traceback.format_exc()}
    with open(out_path, "w", encoding="utf-8") as fh:
        fh.write(json.dumps(out))


if __name__ == "__main__":
    main(*sys.argv[1:4])
