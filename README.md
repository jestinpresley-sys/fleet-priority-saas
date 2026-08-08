# Fleet Priority — SaaS edition

Multi-tenant version of Fleet Priority: users sign up, subscribe to a Basic or
Pro plan via Stripe, and log in to manage their own fleet. Each account's
vehicles are private to that account.

This is a real, runnable app, but nothing is deployed for you — you'll need
to supply your own Stripe account, environment variables, and hosting. Budget
20–30 minutes for first-time setup.

## What's included

- Email/password signup & login (JWT session cookie)
- Stripe Checkout for two subscription tiers (Basic / Pro)
- Stripe Customer Portal for self-serve plan management/cancellation
- Stripe webhook handling to keep subscription status in sync
- Per-plan vehicle limits (Basic: 10 vehicles, Pro: unlimited — edit in `server/fleet.js`)
- The Fleet Priority UI (cards, search/filter, the offline assistant) wired to a per-account API instead of localStorage
- Vehicle photos: upload/replace/remove a photo per vehicle (JPG/PNG/WEBP/GIF, 5MB max), shown on the fleet card and in the edit modal. Files live on disk under `data/uploads` and are only ever served back to the vehicle's owner (`GET /api/vehicles/:id/image` checks ownership — it's not a public static folder).

## What's *not* included (by design, for a first version)

- Email verification / password reset
- Team seats (one login = one account, no multi-user sharing yet)
- A production-grade database — see **Data storage** below

## 1. Set up Stripe

1. Create a [Stripe account](https://dashboard.stripe.com/register) if you don't have one (test mode is fine to start).
2. **Products & Prices**: Dashboard → Product catalog → *+ Add product*. Create two products, each with one **recurring** price:
   - "Fleet Priority Basic" — e.g. $19/month
   - "Fleet Priority Pro" — e.g. $49/month
   
   Copy each price's ID (starts with `price_`, *not* the product ID `prod_`).
3. **API keys**: Dashboard → Developers → API keys. Copy the **Secret key** (starts with `sk_test_` in test mode).
4. **Webhook**: Dashboard → Developers → Webhooks → *+ Add endpoint*.
   - Endpoint URL: `https://YOUR_DOMAIN/api/billing/webhook`
   - Events to send: `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`
   - Copy the **Signing secret** (starts with `whsec_`).

   For local testing before you have a domain, use the [Stripe CLI](https://docs.stripe.com/stripe-cli) instead:
   ```
   stripe listen --forward-to localhost:3000/api/billing/webhook
   ```
   It prints a `whsec_...` value — use that locally.

## 2. Configure the app

```
cp .env.example .env
```

Fill in `.env`:
- `JWT_SECRET` — any long random string (`node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`)
- `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` — from step 1
- `STRIPE_PRICE_BASIC`, `STRIPE_PRICE_PRO` — the two price IDs from step 1
- `APP_URL` — `http://localhost:3000` locally, or your real domain in production

## 3. Run it

```
npm install
npm start
```

Visit `http://localhost:3000` → redirects to `/login.html`. Sign up, pick a
plan, and use Stripe's test card `4242 4242 4242 4242` (any future expiry,
any CVC) to complete checkout.

## Data storage

Vehicles and accounts are stored in a single JSON file at `data/db.json`,
written with a serialized-write queue so concurrent requests don't corrupt
it. This has zero setup and no native dependencies, which makes it easy to
get running today — but it has real limits:

- It reads/writes the whole file on every request, so it won't scale much past a small number of accounts.
- It needs a **persistent disk**. Serverless platforms (Vercel functions, most "edge" hosts) wipe the filesystem between requests, so deploy to something with a real, persistent filesystem: Render, Railway, Fly.io, a plain VPS, etc.
- No backups/replication.

Uploaded vehicle photos live alongside it at `data/uploads/` and have the same persistent-disk requirement. Before real scale, plan to move both onto a real database plus object storage (e.g. Postgres + S3/R2) — swap `server/db.js` for the DB, and point the upload destination in `server/fleet.js` at the object store instead of local disk.

Before you have real paying customers depending on this, swap `server/db.js`
for a real database (Postgres is the standard choice — e.g. via `pg` or an
ORM like Prisma). The rest of the app only calls the functions exported from
`db.js`, so that's the one file to replace.

## Adjusting plans

- Prices are set in Stripe, not in code — change them in the Stripe Dashboard and the app picks them up automatically via the price IDs in `.env`.
- Vehicle limits per plan live in `server/fleet.js` (`PLAN_LIMITS`).
- Plan names/marketing copy live in `public/pricing.html`.

## Deploying

Any Node host with a persistent disk works (Render, Railway, Fly.io, a VPS).
General steps:
1. Push this project to your host.
2. Set the same environment variables from `.env` in the host's dashboard.
3. Attach a persistent disk/volume and set `DATA_DIR` to its mount path (e.g. `/data`) — otherwise uploaded photos and the database won't survive a redeploy.
4. Set `NODE_ENV=production` so session cookies are marked `secure`.
5. Point your Stripe webhook at the real deployed URL (update the endpoint you created earlier, or add a second one for production alongside your test one).
6. Switch Stripe to live mode (new live API keys, live price IDs, live webhook secret) once you're ready to charge real cards.

### Deploying to Render (step by step)

1. Push this project to a GitHub repo.
2. In Render: **New +** → **Web Service** → connect the repo. If the repo contains more than just this project, set **Root Directory** to `fleet-priority-saas`.
3. Build command: `npm install`. Start command: `npm start`.
4. Under **Environment**, add every variable from `.env` (including `NODE_ENV=production`).
5. Under **Disks**, add a disk (e.g. 1GB), mount path `/data`. Set the `DATA_DIR` env var to `/data` to match.
6. Deploy. Render gives you a URL like `https://fleet-priority.onrender.com` — set `APP_URL` to that and redeploy.
7. Back in Stripe, add/update the webhook endpoint to `https://YOUR-RENDER-URL/api/billing/webhook`, copy its signing secret into `STRIPE_WEBHOOK_SECRET`, and redeploy once more.

Render's free web service tier works for testing but spins down after inactivity (slow first load) and doesn't support persistent disks — disks require a paid plan, currently around $7/month for the service plus $0.25/GB/month for the disk. Railway is a comparable alternative (usage-based, roughly $5+/month) with the same disk-pricing model. Neither has a truly free option that includes persistent storage.
