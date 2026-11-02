import os
import sys

def _app_root():
    """Folder that contains the app (next to exe when frozen)."""
    if getattr(sys, "frozen", False):
        return os.path.dirname(sys.executable)
    # server/ is inside project; project root is parent of server/
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

APP_ROOT = _app_root()

# Portable default: <app>/migas_data/  (editable via env or Settings API)
_default_data = os.path.join(APP_ROOT, "migas_data")
SAVE_DIR = os.environ.get("MIGAS_SAVE_DIR", os.path.join(_default_data, "savefile"))
MODEL_DIR = os.environ.get("MIGAS_MODEL_DIR", os.path.join(_default_data, "ml_model"))
JOB_DIR = os.environ.get("MIGAS_JOB_DIR", os.path.join(_default_data, "jobs"))
UPLOAD_DIR = os.environ.get("MIGAS_UPLOAD_DIR", os.path.join(_default_data, "uploads"))
# Default 500 MB — CSV train/test migas sering > 50 MB. Override: MIGAS_MAX_UPLOAD_MB
MAX_UPLOAD_MB = int(os.environ.get("MIGAS_MAX_UPLOAD_MB", "500"))
API_TOKEN = os.environ.get("MIGAS_API_TOKEN", "")  # empty = no auth for portable

for d in (SAVE_DIR, MODEL_DIR, JOB_DIR, UPLOAD_DIR):
    try:
        os.makedirs(d, exist_ok=True)
    except OSError:
        pass
