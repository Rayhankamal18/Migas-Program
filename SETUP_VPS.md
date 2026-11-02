# Migas VPS setup (Feature A + AutoML)

## Backup first

```bash
ts=$(date +%Y%m%d-%H%M%S)
tar czf /root/migas-backup-$ts.tgz /var/www/html/migas /root/migas_savefile 2>/dev/null || true
ls -lh /root/migas-backup-$ts.tgz
```

## Copy this project to the VPS

```bash
# from your PC, example:
# scp -r migas-program/* user@VPS:/var/www/html/migas/
```

## Run setup

```bash
sudo bash /var/www/html/migas/scripts/setup_vps.sh
```

### Expected checks

```bash
curl -s http://127.0.0.1:5055/api/health
# {"ok": true, ...}

ls /root/migas_savefile
```

## Folder permissions (security)

`/root` is private. We only grant the web user access to `/root/migas_savefile` (and `ml model` inside).

Trade-off: the web process can read/write project JSON and models in that folder, but not the rest of `/root`. Prefer a strong `MIGAS_API_TOKEN` and HTTPS.

## Frontend Settings

1. Open the app → **⚙ Settings**
2. **API base URL**: `http://YOUR_VPS_IP:5055` (or `https://your.domain` if nginx proxies `/api`)
3. Optional **API token** if you set `MIGAS_API_TOKEN` on the server
4. Save

## Feature A test

1. **Save / Load** → Save to VPS with a name
2. On phone: same Settings API URL → Load from VPS → same project

## Feature B test

1. Box & Whisker → **Add new plot**
2. Paste data into the new plot
3. Switch plots — old data remains
4. Save / Load — all plots restore

## AutoML test

1. AutoML tab → upload CSV → choose Y/X → Next through steps → Start training
2. Wait until status is `done` → see scores → Predict

## Rollback

```bash
systemctl stop migas-api
# restore tarball
tar xzf /root/migas-backup-YYYYMMDD-HHMMSS.tgz -C /
```

## Troubleshooting "Failed to fetch"

1. **Do not open `Migas Program.html` as a file** (`file://...`). Serve it from the VPS:
   ```bash
   # site should be http://YOUR_VPS/.../migas/
   ```

2. **API service running?**
   ```bash
   systemctl status migas-api --no-pager
   curl -sS http://127.0.0.1:5055/api/health
   ```

3. **Nginx must proxy `/api/`** (same host as the website). Copy `scripts/nginx-migas-api.conf` into your site config, then:
   ```bash
   nginx -t && systemctl reload nginx
   curl -sS http://YOUR_DOMAIN/api/health
   ```

4. **Settings → Test API connection**  
   - Leave API base URL **empty** when using nginx proxy (same origin).  
   - Or set `http://YOUR_IP:5055` only if you expose that port.

5. **Firewall** (if using port 5055 directly):
   ```bash
   ufw allow 5055/tcp
   ```

6. **Permissions on save folder**
   ```bash
   ls -la /root/migas_savefile
   # web user must own it (setup script uses www-data)
   ```
