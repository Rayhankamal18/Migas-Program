#!/usr/bin/env bash
# Run on the VPS as root — fixes Permission denied on /root/migas_savefile
set -euo pipefail

WEB_USER="${WEB_USER:-www-data}"
MIGAS_WEB="${MIGAS_WEB:-/var/www/html/migas}"
DATA_ROOT="/var/lib/migas"

echo "Creating data dirs under $DATA_ROOT ..."
mkdir -p "$DATA_ROOT/savefile" "$DATA_ROOT/ml_model" "$DATA_ROOT/jobs" "$DATA_ROOT/uploads"
chown -R "$WEB_USER:$WEB_USER" "$DATA_ROOT"
chmod -R 750 "$DATA_ROOT"

# migrate old files if any
if [ -d /root/migas_savefile ]; then
  cp -an /root/migas_savefile/. "$DATA_ROOT/savefile/" 2>/dev/null || true
  if [ -d "/root/migas_savefile/ml model" ]; then
    cp -an "/root/migas_savefile/ml model/." "$DATA_ROOT/ml_model/" 2>/dev/null || true
  fi
  echo "Migrated files from /root/migas_savefile"
fi

# Ensure project server code is readable
chown -R root:root "$MIGAS_WEB" 2>/dev/null || true
chmod -R a+rX "$MIGAS_WEB" 2>/dev/null || true

# Rewrite systemd unit with correct paths
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

# Copy updated config.py if present in deploy
if [ -f "$MIGAS_WEB/server/config.py" ]; then
  echo "Using $MIGAS_WEB/server/config.py"
fi

systemctl daemon-reload
systemctl restart migas-api
sleep 1
systemctl status migas-api --no-pager
echo "---"
curl -sS http://127.0.0.1:5055/api/health || true
echo ""
echo "If health OK, open the app in browser and Settings → Test API connection"
echo "Also test nginx: curl -sS http://127.0.0.1/api/health"
