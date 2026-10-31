# ASSURENET dashboard

React, Vite, TypeScript, and Recharts frontend for the telecom assurance lab. It reads real monitoring data from FastAPI and does not create monitoring data.

## Start on Kali

Use the project launcher to start the network lab, collectors, API, and dashboard together:

```bash
cd ~/telecom-assurance-lab
./start.sh
```

The dashboard is available inside Kali Firefox at <http://localhost:5173>. FastAPI runs on Kali loopback at port 8000. Vite forwards `/api/*` and `/restconf/*` requests to FastAPI, so browser requests stay on the dashboard origin and do not need a separate API tunnel or permissive CORS settings.

## Open from Windows

After `./start.sh` is running in Kali, paste the command printed by the launcher into Windows PowerShell:

```powershell
ssh -i "$env:USERPROFILE\.ssh\id_ed25519" `
  -L 5173:127.0.0.1:5173 `
  kali@127.0.0.1 -p 2222
```

Keep the PowerShell SSH session open while using the dashboard. Then open <http://localhost:5173> in Chrome or Edge. The dashboard's API requests go through Vite over this same tunnel.

For optional direct FastAPI documentation from Windows, add `-L 8001:127.0.0.1:8000` to the SSH command and open <http://localhost:8001/docs>. The dashboard itself does not use port 8001.

## Development proxy

The frontend uses relative API paths. `vite.config.ts` proxies `/api` and `/restconf` to `http://127.0.0.1:8000` from within Kali. Do not set a browser-facing API host for the dashboard; this keeps Kali Firefox and Windows browsers on the same configuration.

## Data behavior

The dashboard refreshes all views every five seconds and retains the last successful snapshot during temporary API errors. Empty database results are shown as empty states. Network addresses and interface names match `setup_lab.sh` and the SNMP collector. The topology view labels reachability as inferred because the API does not expose live namespace link state.
