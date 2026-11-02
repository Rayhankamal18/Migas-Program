#!/usr/bin/env bash
# Run as root on the VPS. Makes API reachable for the browser.
set -euo pipefail

echo "=== A) Is API up on localhost? ==="
systemctl is-active migas-api || true
curl -sS http://127.0.0.1:5055/api/health || { echo "API not running on 127.0.0.1:5055 — fix service first"; exit 1; }
echo ""

echo "=== B) Bind gunicorn to 0.0.0.0 (all interfaces) + open firewall ==="
# Update unit: listen on 0.0.0.0:5055 so public IP works
if [ -f /etc/systemd/system/migas-api.service ]; then
  sed -i 's/-b 127.0.0.1:5055/-b 0.0.0.0:5055/g' /etc/systemd/system/migas-api.service
  systemctl daemon-reload
  systemctl restart migas-api
  sleep 1
  systemctl status migas-api --no-pager | head -20
fi

# Firewall (ufw if present)
if command -v ufw >/dev/null 2>&1; then
  ufw allow 5055/tcp || true
  ufw status | head -20 || true
fi
# Also try firewalld
if command -v firewall-cmd >/dev/null 2>&1; then
  firewall-cmd --add-port=5055/tcp --permanent || true
  firewall-cmd --reload || true
fi

echo ""
echo "=== C) Nginx /api proxy (recommended, port 80) ==="
# Detect site config
NGX=""
for f in /etc/nginx/sites-enabled/default /etc/nginx/sites-enabled/* /etc/nginx/conf.d/*.conf; do
  [ -f "$f" ] || continue
  NGX="$f"
  break
done
echo "Nginx site file (check manually): ${NGX:-not found}"

if ! grep -rq "location /api/" /etc/nginx/sites-enabled/ /etc/nginx/conf.d/ 2>/dev/null; then
  echo "No location /api/ found. Add this inside your server { } block:"
  cat <<'NGX'
    location /api/ {
        proxy_pass http://127.0.0.1:5055/api/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        client_max_body_size 50m;
        proxy_read_timeout 3600s;
    }
NGX
  echo "Then: nginx -t && systemctl reload nginx"
else
  echo "location /api/ already present."
  nginx -t && systemctl reload nginx || true
fi

echo ""
echo "=== D) Tests ==="
echo "Local:"
curl -sS http://127.0.0.1:5055/api/health || true
echo ""
echo "Public IP (from this server):"
curl -sS --max-time 5 http://43.133.153.116:5055/api/health || echo "Direct :5055 still blocked (cloud security group?)"
echo ""
echo "Via nginx port 80:"
curl -sS --max-time 5 http://127.0.0.1/api/health || echo "nginx /api not ready"
curl -sS --max-time 5 http://43.133.153.116/api/health || echo "public :80 /api failed"
echo ""
echo "In the app Settings:"
echo "  - Prefer API base URL EMPTY and open http://43.133.153.116/migas/ (or your path)"
echo "  - Or set API base to http://43.133.153.116:5055 only if curl to :5055 works above"
