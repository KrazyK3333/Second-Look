# Second Look — scam checker

A simple site: paste a suspicious message, get "Looks safe", "Be careful", or "Likely a scam" in plain words.

## Files
- `index.html` — the page people see
- `api/check.js` — the server function that calls the Claude API (your key lives here, safely)

## Run it on your computer
1. Install Node.js (18 or newer) and the Vercel CLI: `npm i -g vercel`
2. In this folder, create a file named `.env.local` containing:
   `ANTHROPIC_API_KEY=your-key-here`
3. Run `vercel dev` and open http://localhost:3000

## Put it online
1. Push this folder to a GitHub repo (the `.gitignore` keeps your key out of it).
2. On vercel.com, import the repo.
3. In Project → Settings → Environment Variables, add `ANTHROPIC_API_KEY`.
4. Deploy. You get a free `.vercel.app` link, and you can add your own domain later.

## Taking payments (Family Plan)
1. With a parent, create a Stripe account and make a **Payment Link** for a $5/month subscription.
2. Paste the link into `STRIPE_LINK` at the top of the script in `index.html`.
3. When someone subscribes, Stripe emails you. Make them a family code (like `SMITH-4821`), email it to them, and add it to the `FAMILY_CODES` environment variable in Vercel (comma-separated), then redeploy.
4. If someone cancels, remove their code from `FAMILY_CODES`.

This is manual on purpose: it's fine for your first 50 or so customers. Later you can automate it with Stripe webhooks.

## Free limit (required setup)
People get 3 free checks a day, counted on the server by internet address, so clearing the browser doesn't reset it.
1. Create a free database at upstash.com (Redis) or through Vercel → Storage → Upstash.
2. Add `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` in Vercel's environment variables.
3. Redeploy.

Until the database is connected, free checks are turned off and only family codes work, so nobody gets unlimited free use by accident. If a check fails because of an error, it isn't counted.

To change the number of free checks, edit `FREE_PER_DAY` in `api/check.js`.

## Before sharing widely
- Set a monthly spend limit in the Anthropic Console so a flood of traffic can't run up the bill.
- Add rate limiting (for example Vercel's firewall rules or Upstash) once real users show up.
