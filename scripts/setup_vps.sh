#!/usr/bin/env bash
# Migas VPS setup — run as root on Ubuntu
set -euo pipefail

echo "=== 0) Inspect system ==="
echo "Ubuntu:"; lsb_release -a 2>/dev/null || cat /etc/os-release
echo "Python:"; python3 --version
echo "RAM:"; free -h
echo "Disk:"; df -h /

WEB_USER="${WEB_USER:-www-data}"
MIGAS_WEB="${MIGAS_WEB:-/var/www/html/migas}"
DATA_ROOT="/var/lib/migas"

echo "=== 1) Data folders (NOT under /root — www-data cannot write there) ==="
mkdir -p "$DATA_ROOT/savefile" "$DATA_ROOT/ml_model" "$DATA_ROOT/jobs" "$DATA_ROOT/uploads"
chown -R "$WEB_USER:$WEB_USER" "$DATA_ROOT"
chmod -R 750 "$DATA_ROOT"
# Optional: migrate old /root path if it exists
if [ -d /root/migas_savefile ]; then
  cp -an /root/migas_savefile/. "$DATA_ROOT/savefile/" 2>/dev/null || true
  if [ -d "/root/migas_savefile/ml model" ]; then
    cp -an "/root/migas_savefile/ml model/." "$DATA_ROOT/ml_model/" 2>/dev/null || true
  fi
  echo "Copied any existing files from /root/migas_savefile into $DATA_ROOT"
fi

echo "=== 2) Python venv for AutoML (isolated) ==="
apt-get update -y
apt-get install -y python3-venv python3-dev build-essential
python3 -m venv /opt/migas-automl-venv
# shellcheck disable=SC1091
source /opt/migas-automl-venv/bin/activate
pip install -U pip wheel
if [ -f "$MIGAS_WEB/server/requirements.txt" ]; then
  pip install -r "$MIGAS_WEB/server/requirements.txt" || pip install flask flask-cors gunicorn pandas numpy scikit-learn joblib matplotlib automl-alex
else
  pip install flask flask-cors gunicorn pandas numpy scikit-learn joblib matplotlib automl-alex
fi
python -c "import flask; print('flask ok')"
python -c "import automl_alex; print('automl-alex', getattr(automl_alex,'__version__', '?'))" || echo "WARN: automl-alex not installed yet"
deactivate

echo "=== 3) Systemd service ==="
cat >/etc/systemd/system/migas-api.service <<UNIT
[Unit]
Description=Migas API (save/load + AutoML)
After=network.target

[Service]
Type=simple
User=${WEB_USER}
Group=${WEB_USER}
WorkingDirectory=${MIGAS_WEB}/server
Environment=MIGAS_SAVE_DIR=${DATA_ROOT}/savefile
Environment=MIGAS_MODEL_DIR=${DATA_ROOT}/ml_model
Environment=MIGAS_JOB_DIR=${DATA_ROOT}/jobs
Environment=MIGAS_UPLOAD_DIR=${DATA_ROOT}/uploads
Environment=MIGAS_PYTHON=/opt/migas-automl-venv/bin/python
Environment=MIGAS_API_TOKEN=
Environment=HOME=/var/lib/migas
RuntimeDirectory=migas-api
RuntimeDirectoryMode=0750
ExecStart=/opt/migas-automl-venv/bin/gunicorn -b 127.0.0.1:5055 -w 2 --chdir ${MIGAS_WEB}/server app:app
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable migas-api
systemctl restart migas-api
sleep 1
systemctl status migas-api --no-pager || true

echo "=== 4) Checks ==="
curl -sS http://127.0.0.1:5055/api/health || echo "API not responding yet"
ls -la "$DATA_ROOT"
echo ""
echo "Done. Next: add nginx location /api/ (see scripts/nginx-migas-api.conf)"
echo "Then: curl -sS http://127.0.0.1/api/health   # or your real domain/IP"
