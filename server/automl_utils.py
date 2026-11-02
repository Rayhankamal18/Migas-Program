"""Shared AutoML helpers: column profiling + problem-type inference (AutoGluon-style)."""
from __future__ import annotations

import re
from typing import Any, Dict, List, Optional, Tuple

# Mirrors AutoGluon tabular constants (approximate, for small/medium oil&gas CSVs)
MULTICLASS_UPPER_LIMIT = 1000
LARGE_DATA_THRESHOLD = 1000
REGRESS_THRESHOLD_LARGE = 0.05
REGRESS_THRESHOLD_SMALL = 0.10

# Name tokens that almost always mean a categorical input (not continuous)
_CAT_NAME_RE = re.compile(
    r"(^|_)(gender|sex|jenis.?kelamin|kategori|category|cat|status|tipe|type|class|"
    r"grade|zone|zona|lithology|litho|formation|formasi|fluid|fase|phase|flag|"
    r"yes.?no|true.?false|boolean|bool|code|kode|label|group|grup|cluster|"
    r"basin|cekungan|well.?type|completion|method|metode)(_|$)",
    re.I,
)


def _is_integer_like(series) -> bool:
    import numpy as np
    import pandas as pd

    s = pd.to_numeric(series, errors="coerce").dropna()
    if s.empty:
        return False
    vals = s.to_numpy(dtype=float)
    return bool(np.all(np.isfinite(vals) & np.isclose(vals, np.round(vals), atol=1e-8)))


def _jsonable_value(v):
    import math

    if v is None:
        return None
    if hasattr(v, "item"):
        try:
            v = v.item()
        except Exception:
            return str(v)
    if isinstance(v, float):
        if math.isnan(v) or math.isinf(v):
            return None
        if abs(v - round(v)) < 1e-9:
            return int(round(v))
        return float(v)
    if isinstance(v, (int, bool, str)):
        return v
    return str(v)


def _unique_values(series, limit: int = 64) -> List[Any]:
    import pandas as pd

    non_null = series.dropna()
    uniques = list(pd.unique(non_null))
    out = []
    for v in uniques[:limit]:
        jv = _jsonable_value(v)
        if jv is None:
            continue
        out.append(jv)
    # stable sort: numbers then strings
    try:
        out.sort(key=lambda x: (0, float(x)) if isinstance(x, (int, float)) else (1, str(x).lower()))
    except Exception:
        out = [str(x) for x in out]
        out.sort()
    return out


def infer_feature_kind(name: str, series, *, n_rows: Optional[int] = None) -> Tuple[str, str]:
    """Decide if an *input* feature is numeric or categorical.

    More aggressive than target inference: Gender/Sex/etc. and low-cardinality
    codes become categorical even when stored as 0/1 integers.
    """
    import pandas as pd

    s = pd.Series(series)
    non_null = s.dropna()
    n = int(n_rows if n_rows is not None else len(non_null))
    nunique = int(non_null.nunique()) if len(non_null) else 0
    name_l = str(name or "").strip().lower()
    name_hint = bool(_CAT_NAME_RE.search(name_l.replace(" ", "_")))

    # Explicit text / object / category
    if not pd.api.types.is_numeric_dtype(s):
        coerced = pd.to_numeric(non_null, errors="coerce")
        if len(non_null) == 0 or coerced.notna().mean() < 0.8:
            return "categorical", "Nilai teks/kategori."
        # Mostly numeric strings — fall through using coerced series
        s = coerced
        non_null = s.dropna()
        nunique = int(non_null.nunique()) if len(non_null) else 0

    if nunique <= 1:
        return "categorical", "Hanya 1 nilai unik → kategori konstan."

    uniq_ratio = nunique / max(n, 1)
    int_like = _is_integer_like(non_null)

    # Strong name hint (Gender, Sex, Status, …)
    if name_hint and nunique <= 50:
        return "categorical", f"Nama kolom '{name}' mengisyaratkan kategori ({nunique} nilai)."

    # Binary / ternary codes
    if nunique <= 3 and int_like:
        return "categorical", f"{nunique} kode bilangan bulat → kategori."

    # Low-cardinality integer / code columns
    if int_like and nunique <= 20 and uniq_ratio <= 0.25:
        return "categorical", f"{nunique} nilai bulat (rasio {uniq_ratio:.2f}) → kategori."

    if int_like and nunique <= 12 and uniq_ratio <= 0.4:
        return "categorical", f"Kardinalitas rendah ({nunique}) → kategori."

    return "numeric", "Numerik kontinu / banyak nilai unik."


def build_feature_schema(df, feature_names: Optional[List[str]] = None) -> Dict[str, Any]:
    """Per-feature schema for predict / optimize UI (original column names)."""
    import pandas as pd

    names = list(feature_names) if feature_names is not None else [str(c) for c in df.columns]
    schema: Dict[str, Any] = {}
    n_rows = int(len(df))
    for name in names:
        if name not in df.columns:
            continue
        s = df[name]
        kind, reason = infer_feature_kind(name, s, n_rows=n_rows)
        entry: Dict[str, Any] = {
            "name": str(name),
            "type": kind,
            "reason": reason,
            "n_unique": int(s.nunique(dropna=True)),
        }
        if kind == "categorical":
            cats = _unique_values(s, limit=64)
            entry["categories"] = cats
            if cats:
                entry["default"] = cats[0]
        else:
            num = pd.to_numeric(s, errors="coerce").dropna()
            if len(num):
                lo = float(num.min())
                hi = float(num.max())
                if lo == hi:
                    hi = lo + 1.0
                # soft padding so optimizer can explore slightly outside train range
                span = hi - lo
                pad = span * 0.05 if span > 0 else abs(lo) * 0.05 or 1.0
                entry["min"] = lo
                entry["max"] = hi
                entry["min_suggest"] = lo - pad
                entry["max_suggest"] = hi + pad
                entry["default"] = float(num.median())
            else:
                entry["min"] = 0.0
                entry["max"] = 1.0
                entry["min_suggest"] = 0.0
                entry["max_suggest"] = 1.0
                entry["default"] = 0.0
        schema[str(name)] = entry
    return schema


def training_curve_from_history(history, *, task: str = "regression") -> Optional[Dict[str, Any]]:
    """Build loss-vs-epoch/trial series from Optuna / AutoML history records."""
    if not history:
        return None
    epochs: List[int] = []
    metric_vals: List[float] = []
    for i, row in enumerate(history):
        if not isinstance(row, dict):
            continue
        raw = row.get("value")
        if raw is None:
            raw = row.get("user_attrs_score") or row.get("loss")
        try:
            v = float(raw)
        except Exception:
            continue
        if v != v:  # NaN
            continue
        ep = row.get("number")
        try:
            ep_i = int(ep) + 1 if ep is not None else len(epochs) + 1
        except Exception:
            ep_i = len(epochs) + 1
        epochs.append(ep_i)
        metric_vals.append(v)
    if not metric_vals:
        return None

    # Classification CV scores are usually maximize (ROC-AUC / balanced_acc ∈ [0,1])
    # Regression Optuna in automl-alex typically minimizes MSE.
    maximize = task == "classification"
    loss_vals: List[float] = []
    for v in metric_vals:
        if maximize:
            # map score→loss; keep in sensible range
            if 0.0 <= v <= 1.0:
                loss_vals.append(1.0 - v)
            else:
                loss_vals.append(-v)
        else:
            loss_vals.append(v)

    best_loss: List[float] = []
    cur = float("inf")
    for v in loss_vals:
        if v < cur:
            cur = v
        best_loss.append(cur)

    return {
        "epochs": epochs,
        "loss": loss_vals,
        "best_loss": best_loss,
        "metric": metric_vals,
        "metric_name": "cv_score" if maximize else "cv_mse",
        "maximize_metric": maximize,
        "x_label": "epoch / trial",
        "y_label_loss": "loss",
        "note": (
            "AutoML memakai trial hyperparameter (bukan epoch neural-net). "
            "Sumbu X = nomor trial; Y = loss (klasifikasi: 1 − skor CV)."
            if maximize
            else "AutoML memakai trial hyperparameter. Sumbu X = nomor trial; Y = loss (MSE CV)."
        ),
    }


def infer_problem_type(
    y,
    *,
    explicit_task: Optional[str] = None,
    force_classification: bool = False,
) -> Tuple[str, str]:
    """Return (task, reason) where task is classification|regression.

    Heuristic aligned with AutoGluon TabularPredictor problem-type inference:
    - non-numeric / object labels -> classification
    - exactly 2 unique values -> classification (binary)
    - numeric with few unique integer-like values -> multiclass classification
    - many unique numeric values -> regression
    """
    import pandas as pd

    if force_classification:
        return "classification", "Pengguna memaksa klasifikasi."
    if explicit_task in ("classification", "regression"):
        return explicit_task, "Dipilih manual oleh pengguna."

    s = pd.Series(y).dropna()
    n = len(s)
    if n == 0:
        return "regression", "Target kosong — default regresi."

    nunique = int(s.nunique(dropna=True))
    if nunique <= 1:
        return "classification", "Hanya satu nilai unik — tidak cukup untuk regresi."

    numeric = pd.api.types.is_numeric_dtype(s)
    if not numeric:
        # try coercing
        coerced = pd.to_numeric(s, errors="coerce")
        if coerced.notna().mean() < 0.8:
            return "classification", f"Target teks/kategori ({nunique} kelas)."
        s = coerced.dropna()
        n = len(s)
        nunique = int(s.nunique(dropna=True))
        numeric = True

    if nunique == 2:
        return "classification", "Tepat 2 nilai unik → klasifikasi biner (standar AutoML)."

    if nunique > MULTICLASS_UPPER_LIMIT:
        return "regression", f"{nunique} nilai unik (> {MULTICLASS_UPPER_LIMIT}) → regresi."

    uniq_ratio = nunique / max(n, 1)
    thresh = REGRESS_THRESHOLD_LARGE if n >= LARGE_DATA_THRESHOLD else REGRESS_THRESHOLD_SMALL
    if uniq_ratio >= thresh and not _is_integer_like(s):
        return "regression", (
            f"Rasio unik {uniq_ratio:.2f} ≥ {thresh} dan bukan bilangan bulat → regresi."
        )
    if _is_integer_like(s) and nunique <= max(10, int(n * thresh)):
        return "classification", (
            f"{nunique} kelas bilangan bulat (rasio unik {uniq_ratio:.2f}) → klasifikasi."
        )
    if uniq_ratio < thresh:
        return "classification", f"Sedikit nilai unik ({nunique}, rasio {uniq_ratio:.2f}) → klasifikasi."
    return "regression", f"Numerik dengan {nunique} nilai unik → regresi."


def profile_dataframe(df) -> Dict[str, Any]:
    """Column meta for upload preview + suggested target task per column."""
    import pandas as pd

    cols = []
    for c in df.columns:
        s = df[c]
        missing = int(s.isna().sum())
        non_null = s.dropna()
        nunique = int(non_null.nunique()) if len(non_null) else 0
        n = int(len(non_null))
        if pd.api.types.is_numeric_dtype(s):
            ctype = "numeric"
        else:
            coerced = pd.to_numeric(non_null, errors="coerce")
            ctype = "numeric" if n and coerced.notna().mean() >= 0.8 else "text"
        uniq_ratio = (nunique / n) if n else 0.0
        samples = []
        for v in non_null.head(5).tolist():
            if hasattr(v, "item"):
                try:
                    v = v.item()
                except Exception:
                    v = str(v)
            samples.append(v if not isinstance(v, float) or v == v else None)
        task_if_target, reason = infer_problem_type(s)
        cols.append({
            "name": str(c),
            "type": ctype,
            "missing": missing,
            "n_unique": nunique,
            "unique_ratio": round(uniq_ratio, 4),
            "samples": samples,
            "suggested_task": task_if_target,
            "suggested_reason": reason,
        })
    return {"columns": cols, "rows": int(len(df)), "cols": int(df.shape[1])}
