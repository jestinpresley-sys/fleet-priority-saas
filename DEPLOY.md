# Deploying Fleet Priority to AWS Lightsail

This app is a single Node/Express process with a JSON-file database and local
photo uploads — it needs a host with a **persistent disk**, not serverless
compute. Lightsail (a plain VM with a boot disk) matches that with zero code
changes. This guide deploys it on Ubuntu 22.04.

Total cost: ~$5–10/mo for the instance, plus whatever a domain costs if you
don't already have one. HTTPS via Let's Encrypt is free.

## Prerequisites

- An AWS account with Lightsail access
- A domain name you can point DNS for (**required** — Stripe webhooks only
  accept HTTPS, and you can't get a cert without a domain)
- This repo pushed to GitHub
- A live-mode Stripe account with the Basic/Pro products and prices created
  (mirror whatever you set up in test mode)

## 1. Create the instance

1. Lightsail console → **Create instance**
2. Platform: Linux/Unix → **OS Only** → Ubuntu 22.04 LTS
   (skip the Node.js "Bitnami" blueprint — it uses non-standard paths that
   make the steps below harder to follow)
3. Plan: at least the $10/mo (2 GB RAM) tier. The $5/mo tier works but leaves
   little headroom once Node, nginx, and your data are all loaded.
4. Name it (e.g. `fleet-priority`), create it, wait for it to boot.

## 2. Attach a static IP

Do this before DNS/certbot so the IP doesn't change later.

Instance → **Networking** tab → **Create static IP** → attach to the instance.

## 3. Server setup

SSH in (browser-based SSH button, or your downloaded key), then:

```bash
sudo apt update && sudo apt upgrade -y
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs nginx git
node -v          # confirm v20.x
sudo npm install -g pm2
```

## 4. Get the code

```bash
git clone https://github.com/<your-username>/fleet-priority-saas.git
cd fleet-priority-saas
npm install
```

## 5. Configure environment

```bash
cp .env.example .env
nano .env
```

Fill in:

| Variable | Value |
|---|---|
| `PORT` | `3000` |
| `APP_URL` | `https://yourdomain.com` |
| `NODE_ENV` | `production` |
| `JWT_SECRET` | Generate with `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` |
| `STRIPE_SECRET_KEY` | Your **live** secret key (`sk_live_...`) — not the test key from development |
| `STRIPE_WEBHOOK_SECRET` | Leave blank for now — filled in at step 9 |
| `STRIPE_PRICE_BASIC` / `STRIPE_PRICE_PRO` | Live-mode price IDs |
| `DATA_DIR` | Leave blank — defaults to `./data` on this instance's persistent disk |

## 6. First run

```bash
pm2 start server/index.js --name fleet-priority
pm2 status
curl -o /dev/null -w "%{http_code}\n" http://localhost:3000/login.html   # expect 200
pm2 save
pm2 startup   # run the sudo command it prints, so the app survives a reboot
```

## 7. nginx reverse proxy

```bash
sudo nano /etc/nginx/sites-available/fleet-priority
```

```nginx
server {
    listen 80;
    server_name yourdomain.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/fleet-priority /etc/nginx/sites-enabled/
sudo rm /etc/nginx/sites-enabled/default   # avoid a conflicting default page
sudo nginx -t
sudo systemctl restart nginx
```

## 8. Lightsail firewall

Instance → **Networking** tab → Firewall rules:
- Allow **HTTP (80)** and **HTTPS (443)**
- Don't expose port 3000 publicly — nginx is the only public entry point

## 9. DNS

At your domain registrar, create an **A record**: `yourdomain.com` →
`<Lightsail static IP>`. Wait for propagation (`dig yourdomain.com` to check).

## 10. HTTPS via certbot

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d yourdomain.com
```

Follow the prompts — certbot rewrites the nginx config for HTTPS and sets up
auto-renewal on its own.

## 11. Stripe live webhook

1. Stripe Dashboard (make sure you're in **live mode**, top-left toggle) →
   Developers → Webhooks → **Add endpoint**
2. URL: `https://yourdomain.com/api/billing/webhook`
3. Events to send — this app only listens for:
   - `checkout.session.completed`
   - `customer.subscription.created`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
4. Copy the signing secret it gives you, then back on the server:

```bash
nano .env   # paste it into STRIPE_WEBHOOK_SECRET
pm2 restart fleet-priority
```

## 12. Verify end-to-end

- Visit `https://yourdomain.com` — should redirect to `/login.html` with a
  valid padlock
- Sign up a real account and run through Checkout
- In the Stripe Dashboard, confirm the webhook shows a **Succeeded** delivery
- Confirm the account's plan/status updated (check `/api/auth/me` or just
  that you land on the dashboard instead of the pricing page)

## 13. Backups

Instance → **Snapshots** tab → enable **automatic daily snapshots**.

This is the only redundancy for `data/db.json` and the uploaded photos —
there's no replication or off-instance backup otherwise, so don't skip it.

## 14. Deploying future updates

```bash
ssh <your-instance>
cd fleet-priority-saas
git pull
npm install        # only needed if package.json changed
pm2 restart fleet-priority
```

## 15. Comping an account (bypassing the paywall)

For a client, demo, or anyone else who shouldn't have to pay — no Stripe
subscription involved.

1. Have them sign up normally at `https://yourdomain.com/signup.html`
   (or sign up on their behalf), so they set their own password.
2. SSH in, then **stop the app first**:
   ```bash
   pm2 stop fleet-priority
   ```
   This step isn't optional. `server/db.js` keeps the whole database in
   memory once the app has loaded it and only ever writes that in-memory
   copy back to disk — so if the app is left running while you edit
   `data/db.json` directly, the next time it writes anything at all (any
   request, from any user), it silently overwrites your edit with its own
   stale copy. The script below refuses to run if it detects the app is
   still up, for exactly this reason.
3. Run the comp script:
   ```bash
   npm run comp-account -- client@example.com pro
   ```
   (`pro` or `basic` — whichever plan they should have.)
4. Start the app again:
   ```bash
   pm2 start fleet-priority
   ```

They can now log in and land straight on the dashboard, no checkout.
