#!/usr/bin/env python3
"""Background AutoML worker (AutoML-Alex) — works with automl-alex 1.6.x AND 2023.x.

Why this file exists / what it fixes
------------------------------------
* automl-alex 1.6.x DataPrepare() generates ~700 interaction columns by default and
  BestSingleModel.opt() runs 10 *mandatory* CV trials with NO timeout. On a few hundred
  thousand rows that looks like a freeze at 40% (it was working, just extremely slowly,
  with zero output). We now: sample rows, cap columns, turn interaction features off,
  cap step-1 with a timeout, and print a heartbeat + per-trial lines so you can SEE it work.
* optuna >= 3 removed Study.set_system_attr (automl-alex still calls it) -> shimmed.
* Classifier .predict() returns probabilities (not labels) -> handled properly.
* Study object holds a sqlite storage that breaks/bloats pickling -> dropped before save.
"""
from __future__ import annotations

import inspect
import json
import os
import sys
import threading
import time
import traceback
import warnings
from pathlib import Path

warnings.filterwarnings("ignore")


def log(msg: str):
    print(msg, flush=True)


def progress(n: int):
    print(f"PROGRESS {int(n)}", flush=True)


def ram_text() -> str:
    try:
        import psutil

        p = psutil.Process(os.getpid())
        rss = p.memory_info().rss / 1024**3
        tot = psutil.virtual_memory()
        return f"RAM worker {rss:.1f} GB | system free {tot.available / 1024**3:.1f} GB"
    except Exception:
        return "RAM n/a"


def filter_kwargs(callable_, **kwargs):
    """Pass only the kwargs that the installed automl-alex version understands."""
    try:
        params = inspect.signature(callable_).parameters
        if any(p.kind == inspect.Parameter.VAR_KEYWORD for p in params.values()):
            return kwargs
        dropped = [k for k in kwargs if k not in params]
        if dropped:
            log(f"(note) {getattr(callable_, '__name__', callable_)}: ignoring unsupported options {dropped}")
        return {k: v for k, v in kwargs.items() if k in params}
    except Exception:
        return kwargs


class Heartbeat:
    """Prints a line every few seconds and advances the progress bar 40 -> 75 while opt() runs."""

    def __init__(self, timeout: int, start_pct=40, end_pct=75, every=5):
        self.timeout = max(1, timeout)
        self.start_pct, self.end_pct, self.every = start_pct, end_pct, every
        self.t0 = time.time()
        self.stop_evt = threading.Event()
        self.phase = "optimizing"
        self.trials = 0
        self.best = None
        self.th = threading.Thread(target=self._run, daemon=True)

    def _run(self):
        while not self.stop_evt.wait(self.every):
            el = time.time() - self.t0
            frac = min(1.0, el / self.timeout)
            pct = self.start_pct + (self.end_pct - self.start_pct) * frac
            progress(min(self.end_pct - 1, pct))
            log(
                f"[alive] {self.phase}: {el:.0f}s / ~{self.timeout}s | trials done: {self.trials}"
                f" | best: {self.best} | {ram_text()}"
            )

    def __enter__(self):
        self.th.start()
        return self

    def __exit__(self, *a):
        self.stop_evt.set()


def patch_optuna(hb: Heartbeat, timeout: int):
    """Shims + live trial logging + a time limit on automl-alex's un-timed 'step 1'."""
    try:
        import optuna

        optuna.logging.set_verbosity(optuna.logging.WARNING)
        S = optuna.study.Study
        if not hasattr(S, "set_system_attr"):

            def _set_system_attr(self, key, value):
                try:
                    self.set_user_attr(str(key), value)
                except Exception:
                    pass

            S.set_system_attr = _set_system_attr  # type: ignore
            log("Patched optuna Study.set_system_attr (needed by AutoML-Alex)")

        orig_optimize = S.optimize

        def _cb(study, trial):
            hb.trials += 1
            try:
                hb.best = round(float(study.best_value), 5)
            except Exception:
                pass
            log(f"  trial #{trial.number} finished  value={trial.value}  best={hb.best}")

        def optimize(self, func, n_trials=None, timeout_=None, **kw):
            # automl-alex step 1: n_trials=10 and NO timeout -> can run for hours on big data.
            kw_timeout = kw.get("timeout")
            if n_trials is not None and kw_timeout is None:
                kw["timeout"] = max(20.0, timeout * 0.35)
                hb.phase = "step 1 (calibration trials)"
            else:
                hb.phase = "step 2 (tuning)"
            cbs = list(kw.get("callbacks") or []) + [_cb]
            kw["callbacks"] = cbs
            kw.setdefault("gc_after_trial", True)
            # Failed trials (e.g. XGBoost logistic on regression y) must not kill the study.
            # Optuna: catch=(Exception,) records the trial as FAIL and continues.
            kw["catch"] = (Exception,)
            return orig_optimize(self, func, n_trials=n_trials, **kw)

        S.optimize = optimize  # type: ignore
    except Exception as e:  # never fatal
        log(f"optuna patch skipped: {e}")


def patch_lightgbm():
    """LightGBM >= 4 removed lgb.train(categorical_feature=...) which automl-alex still passes."""
    try:
        import lightgbm as lgb

        if getattr(lgb.train, "_migas_patched", False):
            return
        orig = lgb.train

        def train(params, train_set, *a, categorical_feature=None, **kw):
            if categorical_feature not in (None, "auto"):
                try:
                    train_set.set_categorical_feature(categorical_feature)
                except Exception:
                    pass
            params = dict(params)
            params.setdefault("verbosity", -1)
            return orig(params, train_set, *a, **kw)

        train._migas_patched = True  # type: ignore
        lgb.train = train
        log(f"Patched lightgbm {lgb.__version__} train() for AutoML-Alex")
    except Exception as e:
        log(f"lightgbm patch skipped: {e}")



def build_eval_plots(task, y_test, y_pred, y_proba, class_names, feature_importance=None):
    """Evaluation curves via sklearn.metrics (standard); importance from model when provided."""
    import numpy as np
    from sklearn import metrics as skm
    plots = {"feature_importance": feature_importance, "roc_curves": None, "pr_curves": None}
    try:
        if task != "classification" or y_proba is None:
            return plots
        proba = np.asarray(y_proba)
        if proba.ndim == 1:
            proba = np.column_stack([1.0 - proba, proba])
        y_test = np.asarray(y_test)
        if class_names:
            name_to_i = {str(c): i for i, c in enumerate(class_names)}
            y_idx = np.array([
                name_to_i[str(v)] if str(v) in name_to_i else int(v)
                for v in y_test
            ])
        else:
            y_idx = y_test.astype(int)
        roc_curves, pr_curves = [], []
        for k in range(proba.shape[1]):
            y_bin = (y_idx == k).astype(int)
            if y_bin.min() == y_bin.max():
                continue
            fpr, tpr, _ = skm.roc_curve(y_bin, proba[:, k])
            prec, rec, _ = skm.precision_recall_curve(y_bin, proba[:, k])
            try:
                auc = float(skm.roc_auc_score(y_bin, proba[:, k]))
            except Exception:
                auc = None
            label = class_names[k] if class_names and k < len(class_names) else str(k)
            roc_curves.append({"class": label, "fpr": fpr.tolist(), "tpr": tpr.tolist(), "auc": auc})
            pr_curves.append({"class": label, "precision": prec.tolist(), "recall": rec.tolist()})
        plots["roc_curves"] = roc_curves
        plots["pr_curves"] = pr_curves
    except Exception as e:
        log(f"build_eval_plots: {e}")
    return plots



def run_multiclass(ctx):
    """Multi-class path: LightGBM tuned with Optuna inside the time budget. Same logging/progress."""
    import numpy as np
    import pandas as pd
    import joblib
    import optuna
    from lightgbm import LGBMClassifier
    from sklearn import metrics
    from sklearn.compose import ColumnTransformer
    from sklearn.model_selection import StratifiedKFold, cross_val_score
    from sklearn.pipeline import Pipeline
    from sklearn.preprocessing import OrdinalEncoder

    X_train, X_test, y_train, y_test = ctx["X_train"], ctx["X_test"], ctx["y_train"], ctx["y_test"]
    class_names, timeout, rs, hb = ctx["class_names"], ctx["timeout"], ctx["random_state"], ctx["hb"]
    job_id, model_dir, job_dir = ctx["job_id"], ctx["model_dir"], ctx["job_dir"]
    n_classes = len(class_names)

    cat_cols = [c for c in X_train.columns if not pd.api.types.is_numeric_dtype(X_train[c])]
    num_cols = [c for c in X_train.columns if c not in cat_cols]
    pre = ColumnTransformer(
        [("cat", OrdinalEncoder(handle_unknown="use_encoded_value", unknown_value=-1), cat_cols)],
        remainder="passthrough",
    )
    # classes with <3 samples cannot be cross-validated -> use fewer folds
    min_count = int(pd.Series(y_train).value_counts().min())
    folds = max(2, min(3, min_count))
    log(f"Multi-class: {n_classes} classes, rarest class has {min_count} training rows, cv folds={folds}")

    optuna.logging.set_verbosity(optuna.logging.WARNING)
    study = optuna.create_study(direction="maximize", sampler=optuna.samplers.TPESampler(seed=rs))

    def make(params):
        return Pipeline([
            ("pre", pre),
            ("clf", LGBMClassifier(objective="multiclass", num_class=n_classes, random_state=rs,
                                   verbosity=-1, class_weight="balanced", **params)),
        ])

    def objective(trial):
        params = dict(
            n_estimators=trial.suggest_int("n_estimators", 100, 600),
            learning_rate=trial.suggest_float("learning_rate", 0.02, 0.3, log=True),
            num_leaves=trial.suggest_int("num_leaves", 4, 64, log=True),
            min_child_samples=trial.suggest_int("min_child_samples", 2, 40),
            subsample=trial.suggest_float("subsample", 0.6, 1.0),
            subsample_freq=1,
            colsample_bytree=trial.suggest_float("colsample_bytree", 0.5, 1.0),
            reg_lambda=trial.suggest_float("reg_lambda", 1e-3, 10.0, log=True),
        )
        cv = StratifiedKFold(n_splits=folds, shuffle=True, random_state=rs)
        # balanced accuracy: fair when some classes are very rare
        return float(cross_val_score(make(params), X_train, y_train, cv=cv,
                                     scoring="balanced_accuracy").mean())

    log(f"Starting optimisation: timeout={timeout}s (LightGBM multi-class)")
    log("You will see '[alive]' lines every 5s and 'trial #N' lines — if they appear, it is working.")
    progress(40)
    hb.t0 = time.time()
    hb.phase = "tuning (multi-class)"
    with hb:
        study.optimize(objective, timeout=max(15, timeout * 0.85), gc_after_trial=True, catch=(Exception,))
        if len(study.trials) == 0 or all(t.value is None for t in study.trials):
            raise RuntimeError("No tuning trial finished - check your data.")
        log("Fitting best model on the full training set ...")
        best = make({**study.best_params, "subsample_freq": 1})
        best.fit(X_train, y_train)
    progress(75)

    proba_te = best.predict_proba(X_test)
    lab_te = proba_te.argmax(axis=1)
    lab_tr = best.predict(X_train)
    scores = {
        "accuracy_train": float(metrics.accuracy_score(y_train, lab_tr)),
        "accuracy_test": float(metrics.accuracy_score(y_test, lab_te)),
        "balanced_accuracy_test": float(metrics.balanced_accuracy_score(y_test, lab_te)),
        "f1_macro_test": float(metrics.f1_score(y_test, lab_te, average="macro", zero_division=0)),
        "f1_weighted_test": float(metrics.f1_score(y_test, lab_te, average="weighted", zero_division=0)),
    }
    labels = list(range(n_classes))
    scores["classification_report"] = metrics.classification_report(
        y_test, lab_te, labels=labels, target_names=class_names, output_dict=True, zero_division=0)
    scores["confusion_matrix"] = metrics.confusion_matrix(y_test, lab_te, labels=labels).tolist()
    log("Scores: " + str({k: round(v, 4) for k, v in scores.items() if not isinstance(v, (dict, list))}))

    model_name = f"automl_{job_id}.joblib"
    bundle = {
        "kind": "multiclass_lgbm",
        "pipeline": best,
        "features": ctx["features"], "safe_names": ctx["safe_names"],
        "target": ctx["target"], "task": "classification",
        "metric": "balanced_accuracy", "best_model_name": "LightGBM (multi-class)",
        "best_model_param": study.best_params, "scores": scores, "class_names": class_names,
        "library_version": ctx["lib_version"],
    }
    joblib.dump(bundle, model_dir / model_name)
    simple = {k: v for k, v in scores.items() if not isinstance(v, (dict, list))}
    (model_dir / f"automl_{job_id}.json").write_text(json.dumps({
        "created": pd.Timestamp.now("UTC").isoformat(), "task": "classification",
        "target": ctx["target"], "features": ctx["features"], "model_file": model_name,
        "best_model_name": "LightGBM (multi-class)", "scores": simple,
        "library_version": ctx["lib_version"]}, indent=2), encoding="utf-8")
    log(f"Saved model {model_dir / model_name}")
    progress(95)
    hist = None
    try:
        hist = json.loads(study.trials_dataframe().to_json(orient="records", date_format="iso"))
    except Exception:
        pass
    fi = None
    try:
        clf = best.named_steps.get("clf") if hasattr(best, "named_steps") else None
        if clf is not None and hasattr(clf, "feature_importances_"):
            names = list(X_test.columns)
            imp = clf.feature_importances_
            order = list(np.argsort(imp)[::-1][:30])
            fi = [{"feature": str(names[i]), "importance": float(imp[i])} for i in order]
    except Exception as e:
        log(f"LGBM feature_importances_: {e}")
    plots = build_eval_plots("classification", y_test, lab_te, proba_te, class_names, feature_importance=fi)
    result = {
        "task": "classification", "target": ctx["target"], "features": ctx["features"],
        "best_model_name": "LightGBM (multi-class)", "best_model_param": study.best_params,
        "metric": "balanced_accuracy", "scores": scores, "history": hist, "model_file": model_name,
        "y_test": [class_names[int(v)] for v in np.asarray(y_test)],
        "y_pred_test": [class_names[int(v)] for v in lab_te],
        "y_proba_test": proba_te.tolist() if proba_te is not None else None,
        "class_names": class_names, "train_shape": list(X_train.shape), "test_shape": list(X_test.shape),
        "library_version": ctx["lib_version"],
        "plots": plots,
    }
    (job_dir / f"{job_id}_result.json").write_text(json.dumps(result, default=str), encoding="utf-8")
    progress(100)
    log("DONE")


def main(cfg_path: str):
    cfg = json.loads(Path(cfg_path).read_text(encoding="utf-8"))
    job_id = cfg["job_id"]
    job_dir = Path(cfg["job_dir"])
    model_dir = Path(cfg["model_dir"])
    model_dir.mkdir(parents=True, exist_ok=True)
    job_dir.mkdir(parents=True, exist_ok=True)

    # automl-alex writes db.sqlite3 and .automl-alex_tmp/ into the CWD -> use a private folder
    work = job_dir / f"{job_id}_work"
    work.mkdir(parents=True, exist_ok=True)
    os.chdir(work)

    timeout = int(cfg.get("timeout") or 300)
    hb = Heartbeat(timeout)

    try:
        log(f"Python {sys.version.split()[0]} | worker pid {os.getpid()}")
        import numpy as np
        import pandas as pd
        import joblib
        from sklearn import metrics
        from sklearn.model_selection import train_test_split
        from sklearn.preprocessing import LabelEncoder

        import automl_alex
        from automl_alex import DataPrepare, BestSingleModelClassifier, BestSingleModelRegressor

        lib_version = getattr(automl_alex, "__version__", "unknown")
        log(f"automl-alex version: {lib_version}")
        patch_optuna(hb, timeout)
        patch_lightgbm()
        progress(5)

        # ---------------------------------------------------------------- data
        def clean_name(c):
            return str(c).replace("\ufeff", "").strip()

        try:  # same reader as the upload preview (auto-detects , ; tab) and strips the BOM
            df = pd.read_csv(cfg["csv_path"], sep=None, engine="python", encoding="utf-8-sig")
        except UnicodeDecodeError:
            df = pd.read_csv(cfg["csv_path"], sep=None, engine="python", encoding="latin-1")
        df.columns = [clean_name(c) for c in df.columns]
        target = clean_name(cfg["target"])
        features = [clean_name(f) for f in cfg["features"]]
        for col in features + [target]:
            if col not in df.columns:
                raise ValueError(f"Column not found: {col}")
        if target in features:
            features.remove(target)
        if not features:
            raise ValueError("No input columns left after removing the target.")

        before = len(df)
        df = df.dropna(subset=[target]).copy()
        log(f"CSV rows: {before} (dropped {before - len(df)} with missing target) | columns: {df.shape[1]}")

        y = df[target]
        X = df[features].copy()

        force_cls = bool(cfg.get("force_classification"))
        if force_cls:
            task = "classification"
        elif cfg.get("task") in ("classification", "regression"):
            task = cfg["task"]
        else:
            task = "regression" if pd.api.types.is_numeric_dtype(y) else "classification"
        log(f"Task: {task}")

        random_state = int(cfg.get("random_state") or 42)

        # ------------------------------------------------------- memory / time guard
        max_rows = int(cfg.get("max_rows") or 20000)
        if len(X) > max_rows:
            log(f"Large dataset: using a {max_rows}-row sample of {len(X)} (set max_rows to change). "
                f"Full data would make every trial take minutes.")
            if task == "classification":
                tmp = X.copy()
                tmp["__y__"] = y.values
                parts = []
                for _, g in tmp.groupby("__y__", group_keys=False):
                    n = max(1, int(round(max_rows * len(g) / len(tmp))))
                    parts.append(g.sample(n=min(n, len(g)), random_state=random_state))
                tmp = pd.concat(parts, axis=0)
                if len(tmp) > max_rows:
                    tmp = tmp.sample(n=max_rows, random_state=random_state)
                y = tmp["__y__"]
                X = tmp.drop(columns=["__y__"])
            else:
                idx = X.sample(n=max_rows, random_state=random_state).index
                X = X.loc[idx]
                y = y.loc[idx]
            log(f"Sample shape: {X.shape}")

        max_cols = int(cfg.get("max_cols") or 60)
        if X.shape[1] > max_cols:
            num_cols = [c for c in X.columns if pd.api.types.is_numeric_dtype(X[c])]
            other = [c for c in X.columns if c not in num_cols]
            var = X[num_cols].var(numeric_only=True).sort_values(ascending=False) if num_cols else []
            keep_num = list(var.index[: max(1, max_cols - len(other))]) if num_cols else []
            keep = (other + keep_num)[:max_cols]
            X = X[keep]
            features = list(X.columns)
            log(f"Limited to {len(features)} input columns")

        # LightGBM/XGBoost reject names with [ ] < , : " { } etc. (e.g. "Air temperature [K]").
        # Train on safe internal names; remember the mapping so predict accepts the original names.
        import re as _re

        safe_names, used = {}, set()
        for orig in X.columns:
            sn = _re.sub(r"[^0-9A-Za-z_]+", "_", str(orig)).strip("_") or "col"
            base_sn, k = sn, 2
            while sn in used:
                sn = f"{base_sn}_{k}"
                k += 1
            used.add(sn)
            safe_names[orig] = sn
        if any(o != n for o, n in safe_names.items()):
            log("Renamed columns for the model: " + ", ".join(f"{o}->{n}" for o, n in safe_names.items() if o != n))
        X = X.rename(columns=safe_names)

        # AutoML_Alex DataPrepare only treats dtypes object|category as categorical
        # (data_prepare.py). pandas StringDtype is missed, then data.median() crashes.
        cat_cols = []
        for col in list(X.columns):
            if pd.api.types.is_numeric_dtype(X[col]):
                X[col] = pd.to_numeric(X[col], errors="coerce").astype("float64")
            else:
                X[col] = X[col].astype(object)
                cat_cols.append(col)
        if cat_cols:
            log(f"Categorical (object) columns for DataPrepare: {cat_cols}")

        # ----------------------------------------------------------- target
        label_encoder = None
        class_names = None
        if task == "classification":
            y = y.astype(str)
            label_encoder = LabelEncoder()
            y = pd.Series(label_encoder.fit_transform(y), name=target)
            class_names = [str(c) for c in label_encoder.classes_]
            log(f"Classes: {class_names}")
            if len(class_names) < 2:
                raise ValueError("Target has only one class — nothing to classify.")
            if len(class_names) > 2:
                log(f"{len(class_names)} classes -> multi-class mode (LightGBM + Optuna tuning). "
                    "AutoML-Alex itself only does binary targets.")
        else:
            y = pd.to_numeric(y, errors="coerce")
            ok = y.notna().values
            if not ok.all():
                log(f"Dropping {int((~ok).sum())} rows where target is not numeric")
                X, y = X.loc[ok], y.loc[ok]
        progress(10)

        test_size = float(cfg.get("test_size") or 0.2)
        strat = y if task == "classification" else None
        try:
            X_train, X_test, y_train, y_test = train_test_split(
                X, y, test_size=test_size, random_state=random_state, stratify=strat
            )
        except Exception:
            X_train, X_test, y_train, y_test = train_test_split(
                X, y, test_size=test_size, random_state=random_state
            )
        X_train = X_train.reset_index(drop=True)
        X_test = X_test.reset_index(drop=True)
        y_train = pd.Series(y_train).reset_index(drop=True)
        y_test = pd.Series(y_test).reset_index(drop=True)
        log(f"Train {X_train.shape} | Test {X_test.shape} | {ram_text()}")
        progress(20)

        if task == "classification" and len(class_names) > 2:
            run_multiclass(dict(
                X_train=X_train, X_test=X_test, y_train=y_train, y_test=y_test,
                class_names=class_names, timeout=timeout, random_state=random_state, hb=hb,
                job_id=job_id, model_dir=model_dir, job_dir=job_dir, features=features,
                safe_names=safe_names, target=target, lib_version=lib_version))
            return

        # ------------------------------------------------------------ data prepare
        # Re-assert object dtype on train/test (split can preserve string dtype)
        for frame in (X_train, X_test):
            for col in list(frame.columns):
                if not pd.api.types.is_numeric_dtype(frame[col]):
                    frame[col] = frame[col].astype(object)
        train_cats = [c for c in X_train.columns if not pd.api.types.is_numeric_dtype(X_train[c])]
        de_kwargs = filter_kwargs(
            DataPrepare.__init__,
            cat_features=train_cats if train_cats else None,
            cat_encoder_names=["OneHotEncoder", "CountEncoder"],
            clean_outliers=False,
            num_generator_features=False,  # <-- 1.6.x default True => ~700 extra columns
            drop_invariant=True,
            reduce_memory=True,
            random_state=random_state,
            verbose=1,
        )
        de_kwargs.pop("self", None)
        de = DataPrepare(**de_kwargs)
        t0 = time.time()
        log(f"DataPrepare cat_features={train_cats}")
        X_train_p = de.fit_transform(X_train).copy()
        X_test_p = de.transform(X_test).copy()
        log(f"DataPrepare done in {time.time() - t0:.1f}s -> train {X_train_p.shape}, test {X_test_p.shape}")
        progress(35)

        # ---------------------------------------------------------------- model
        try:
            available = list(automl_alex.models.all_models.keys())
        except Exception:
            available = []
        models_names = cfg.get("models_names") or ["LightGBM", "LinearModel"]
        if available:
            ok_models = [m for m in models_names if m in available]
            if len(ok_models) != len(models_names):
                log(f"Models not available in this automl-alex build, skipped: "
                    f"{[m for m in models_names if m not in available]} (available: {available})")
            models_names = ok_models or [m for m in ("LightGBM", "LinearModel") if m in available] or available[:1]
        # Regression + XGBoost in automl-alex 1.6.x can trial logistic loss (needs y in (0,1)).
        # Keep it listed but failed trials are caught; prefer stable defaults first.
        if task == "regression" and "XGBoost" in models_names:
            log("Note: XGBoost trials that use logistic loss will be skipped (Optuna catch); "
                "LightGBM/LinearModel continue.")

        cls = BestSingleModelClassifier if task == "classification" else BestSingleModelRegressor
        bm_kwargs = filter_kwargs(
            cls.__init__,
            models_names=models_names,
            clean_and_encod_data=False,  # we already ran DataPrepare above
            opt_data_prepare=False,
            # 1.6.x tries WOEEncoder, which only accepts a binary target -> crash for regression
            target_encoders_names=(
                ["TargetEncoder", "JamesSteinEncoder", "CatBoostEncoder"]
                if task != "classification"
                else ["TargetEncoder", "JamesSteinEncoder", "CatBoostEncoder", "WOEEncoder"]
            ),
            folds=3,
            score_folds=1,
            cold_start=8,
            early_stoping=30,
            feature_selection=False,
            random_state=random_state,
            verbose=1,
        )
        bm_kwargs.pop("self", None)
        model = cls(**bm_kwargs)
        metric_name = "roc_auc_score" if task == "classification" else "mean_squared_error"

        log(f"Starting optimisation: timeout={timeout}s models={models_names}")
        log("You will see '[alive]' lines every 5s and 'trial #N' lines — if they appear, it is working.")
        progress(40)
        hb.t0 = time.time()
        history = None
        with hb:
            try:
                history = model.opt(X_train_p, y_train, timeout=timeout, verbose=1)
            except Exception as opt_err:
                # Some builds re-raise the last failed trial even with catch=; keep best if any
                log(f"opt() raised after some trials: {type(opt_err).__name__}: {opt_err}")
                if getattr(model, "best_model_param", None) is None and getattr(model, "study", None) is not None:
                    try:
                        model.get_model_from_iter(X_train_p, y_train, model.study.best_params)
                        model.best_model_name = getattr(
                            getattr(model, "cv_model", None), "estimator", model
                        ).__class__.__name__
                        model.best_model_param = model.study.best_params
                        log("Recovered best params from study after opt() error")
                    except Exception as e2:
                        log(f"Could not recover study best: {e2}")
                        raise opt_err
                elif getattr(model, "best_model_param", None) is None:
                    raise opt_err
                else:
                    log("Continuing with best_model_param already set")
                try:
                    if history is None and getattr(model, "study", None) is not None:
                        history = model.study.trials_dataframe()
                except Exception:
                    pass
        progress(75)
        log("Optimisation finished, evaluating ...")

        # ------------------------------------------------------------- evaluate
        def to_1d(a):
            a = np.asarray(a)
            if a.ndim == 2:
                a = a[:, -1] if a.shape[1] > 1 else a[:, 0]
            return a.reshape(-1)

        p_train = to_1d(model.predict(X_train_p))
        p_test = to_1d(model.predict(X_test_p))

        scores = {}
        if task == "classification":
            lab_train = (p_train >= 0.5).astype(int)
            lab_test = (p_test >= 0.5).astype(int)
            scores["accuracy_train"] = float(metrics.accuracy_score(y_train, lab_train))
            scores["accuracy_test"] = float(metrics.accuracy_score(y_test, lab_test))
            try:
                scores["roc_auc_train"] = float(metrics.roc_auc_score(y_train, p_train))
                scores["roc_auc_test"] = float(metrics.roc_auc_score(y_test, p_test))
            except Exception as e:
                log(f"roc_auc error: {e}")
            try:
                scores["classification_report"] = metrics.classification_report(
                    y_test, lab_test, output_dict=True, zero_division=0,
                    target_names=class_names,
                )
                scores["confusion_matrix"] = metrics.confusion_matrix(y_test, lab_test).tolist()
            except Exception as e:
                log(f"report error: {e}")
            y_pred_out = [class_names[int(v)] for v in lab_test]
            y_true_out = [class_names[int(v)] for v in np.asarray(y_test)]
        else:
            scores["r2_train"] = float(metrics.r2_score(y_train, p_train))
            scores["r2_test"] = float(metrics.r2_score(y_test, p_test))
            scores["mae_test"] = float(metrics.mean_absolute_error(y_test, p_test))
            scores["mse_test"] = float(metrics.mean_squared_error(y_test, p_test))
            scores["rmse_test"] = float(np.sqrt(scores["mse_test"]))
            yt = np.asarray(y_test, dtype=float)
            if not np.any(yt == 0):
                scores["mape_test"] = float(np.mean(np.abs((yt - p_test) / yt)) * 100)
            y_pred_out = [float(v) for v in p_test]
            y_true_out = [float(v) for v in yt]
        log(f"Scores: { {k: v for k, v in scores.items() if not isinstance(v, (dict, list))} }")

        best_name = getattr(model, "best_model_name", None)
        best_param = getattr(model, "best_model_param", None)
        if best_param is not None and not isinstance(best_param, (dict, list, str, int, float, bool)):
            best_param = str(best_param)

        # ----------------------------------------------------------------- save
        try:  # the optuna study (sqlite storage) is not needed for prediction and may not pickle
            model.study = None
        except Exception:
            pass
        # automl-alex keeps the fitted fold models in a class-level dict that pickle does NOT
        # capture -> use the library's own save() (zip) and reload it with load() when predicting.
        opt_zip_base = f"automl_{job_id}_opt"
        model.save(name=opt_zip_base, folder=str(model_dir) + os.sep, verbose=0)
        if not (model_dir / (opt_zip_base + ".zip")).is_file():
            raise RuntimeError("automl-alex did not write the model archive")
        de_zip_base = f"automl_{job_id}_dp"
        de.save(name=de_zip_base, folder=str(model_dir) + os.sep)  # keeps fitted encoders
        model_name = f"automl_{job_id}.joblib"
        model_path = model_dir / model_name
        bundle = {
            "opt_zip": opt_zip_base + ".zip",
            "de_zip": de_zip_base + ".zip",
            "features": features,
            "safe_names": safe_names,
            "target": target,
            "task": task,
            "metric": metric_name,
            "best_model_name": str(best_name) if best_name is not None else None,
            "best_model_param": best_param,
            "scores": scores,
            "class_names": class_names,
            "label_encoder": label_encoder,
            "library_version": lib_version,
            "prepared_columns": list(X_train_p.columns),
        }
        joblib.dump(bundle, model_path)
        meta = {
            "created": pd.Timestamp.now("UTC").isoformat(),
            "task": task,
            "target": target,
            "features": features,
            "model_file": model_name,
            "best_model_name": str(best_name) if best_name is not None else None,
            "scores": {k: v for k, v in scores.items() if not isinstance(v, (dict, list))},
            "library_version": lib_version,
        }
        (model_dir / f"automl_{job_id}.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
        log(f"Saved model {model_path}")
        progress(95)

        hist = None
        try:
            if history is not None and hasattr(history, "to_dict"):
                hist = json.loads(history.to_json(orient="records", date_format="iso"))
        except Exception:
            hist = None

        # Feature importance via AutoML-Alex CV API when available (_base / cross_validation)
        fi = None
        try:
            cv = getattr(model, "cv_model", None)
            if cv is not None and hasattr(cv, "get_feature_importance"):
                fi_df = cv.get_feature_importance(X_train_p)
                if fi_df is not None and hasattr(fi_df, "columns") and "value" in fi_df.columns:
                    s = fi_df["value"].sort_values(ascending=False).head(30)
                    fi = [{"feature": str(i), "importance": float(v)} for i, v in s.items()]
        except Exception as e:
            log(f"get_feature_importance: {e}")
        # README: predicts = model.predict(X_test); binary AUC uses those scores as y_score
        proba_2d = None
        if task == "classification" and p_test is not None:
            pt = np.asarray(p_test, dtype=float).reshape(-1)
            proba_2d = np.column_stack([1.0 - pt, pt])
        plots = build_eval_plots(
            task,
            y_true_out,
            y_pred_out,
            proba_2d,
            class_names,
            feature_importance=fi,
        )
        result = {
            "task": task,
            "target": target,
            "features": features,
            "best_model_name": str(best_name) if best_name is not None else None,
            "best_model_param": best_param,
            "metric": metric_name,
            "scores": scores,
            "history": hist,
            "model_file": model_name,
            "y_test": y_true_out,
            "y_pred_test": y_pred_out,
            "y_proba_test": (p_test.tolist() if task == "classification" and p_test is not None else None),
            "class_names": class_names,
            "train_shape": list(X_train_p.shape),
            "test_shape": list(X_test_p.shape),
            "library_version": lib_version,
            "plots": plots,
        }
        (job_dir / f"{job_id}_result.json").write_text(json.dumps(result, default=str), encoding="utf-8")
        progress(100)
        log("DONE")
    except Exception:
        hb.stop_evt.set()
        log("ERROR")
        log(traceback.format_exc())
        sys.exit(1)


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: automl_worker.py config.json")
        sys.exit(2)
    main(sys.argv[1])
