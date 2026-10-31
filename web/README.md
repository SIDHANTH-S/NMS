# AssureNet dashboard

React, Vite, TypeScript, and Recharts frontend for the telecom assurance lab.
It reads live data from `api.py`; it does not create monitoring data.

## Start on Kali

Install Node.js 20.19+ and npm if they are not already present:

```bash
sudo apt update
sudo apt install -y nodejs npm
```

Then, in separate terminals:

```bash
cd ~/telecom-assurance-lab
source venv/bin/activate
python -m uvicorn api:app --host 0.0.0.0 --port 8000
```

```bash
cd ~/telecom-assurance-lab/web
npm install
npm run dev -- --host 0.0.0.0
```

Open `http://127.0.0.1:5173`. If the browser runs on the Windows host, forward both Kali ports from PowerShell with:

```powershell
ssh -N -L 5173:127.0.0.1:5173 -L 8000:127.0.0.1:8000 -p 2222 kali@127.0.0.1
```

Then open `http://127.0.0.1:5173` on Windows. Keep the SSH forwarding window open.

## Configure the API address

The default is `http://127.0.0.1:8000`, which works from a local browser and with the SSH port forwarding above. To use a different address, copy `.env.example` to `.env.local` and set `VITE_API_BASE_URL` to the browser-reachable FastAPI origin. That origin must be allowed by the API CORS configuration in `api.py`.

## Data behavior

The dashboard refreshes all views every five seconds and retains the last successful snapshot during temporary API errors. Empty database results are shown as empty states. Network addresses and interface names match `setup_lab.sh` and the SNMP collector. The topology view labels reachability as inferred because the API does not expose live namespace link state.
