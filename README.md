# HVAC AI Engineer

Cloudflare-first MVP for HVAC drawing legend extraction, drawing MTO capture, 3D model import, reconciliation, and feedback-driven AI progress tracking.

## What This App Uses

- `apps/web`: React + Vite frontend
- `apps/api`: Hono API running on Cloudflare Workers
- `packages/shared`: shared types and extraction/reconciliation logic
- `D1`: relational database
- `R2`: file storage for uploads

## Before You Start

You need these accounts/tools:

- Node.js and npm
- A Cloudflare account
- A Google Cloud account
- Wrangler CLI access through `npx wrangler`

## Step 1: Get the Code Ready

Run this once:

```bash
cd /Users/wolfcancode/Dev/hvac-ai-engineer
npm install
```

## Step 2: Create Google Login

This app uses one Google OAuth Web Client ID for both local and production.

### 2.1 Create the Google OAuth client

In Google Cloud Console:

1. Open Google Auth Platform.
2. Create an OAuth client.
3. Choose `Web application`.

### 2.2 Add local origin

Add this to `Authorized JavaScript origins`:

- `http://localhost:5173`

### 2.3 Put the client ID in the app

The repo already has your current client ID in:

- [apps/web/.env.local](/Users/wolfcancode/Dev/hvac-ai-engineer/apps/web/.env.local)
- [apps/api/wrangler.jsonc](/Users/wolfcancode/Dev/hvac-ai-engineer/apps/api/wrangler.jsonc)

If you ever change the Google OAuth client, update both places with the new client ID.

## Step 3: Run Locally

Follow this exactly if you are new to the stack.

### 3.1 Create the local Worker secret

Copy the example file:

```bash
cd /Users/wolfcancode/Dev/hvac-ai-engineer
cp apps/api/.dev.vars.example apps/api/.dev.vars
```

Then edit [apps/api/.dev.vars](/Users/wolfcancode/Dev/hvac-ai-engineer/apps/api/.dev.vars) and set:

```env
SESSION_SECRET=your-long-random-local-secret
```

Use any long random string.

### 3.2 Run local database migrations

```bash
cd /Users/wolfcancode/Dev/hvac-ai-engineer
npm --workspace apps/api run d1:migrate
```

### 3.3 Start the API

Open terminal 1:

```bash
cd /Users/wolfcancode/Dev/hvac-ai-engineer
npm run dev:api
```

### 3.4 Start the frontend

Open terminal 2:

```bash
cd /Users/wolfcancode/Dev/hvac-ai-engineer
npm --workspace apps/web run dev
```

### 3.5 Open the app

Open:

- `http://localhost:5173`

Important:

- Always use `localhost` locally.
- Do not switch between `localhost` and `127.0.0.1`.
- The login cookie will break if frontend and API use different hostnames.

### 3.6 Test the local flow

Do this after the app opens:

1. Sign in with Google.
2. Upload the legend PDF.
3. Upload the drawing PDF.
4. Upload the model XLS/XLSX/CSV.
5. Run reconciliation.
6. Refresh the page and confirm the session/workspace restores.

## Step 4: Prepare Cloudflare for Production

### 4.1 Log in to Cloudflare

```bash
cd /Users/wolfcancode/Dev/hvac-ai-engineer
npx wrangler login
```

### 4.2 Create production resources

Create these in Cloudflare:

- D1 database: `hvac_ai_engineer`
- R2 bucket: `hvac-ai-engineer-files`

Copy the D1 `database_id`.

### 4.3 Update Worker config

Open [apps/api/wrangler.jsonc](/Users/wolfcancode/Dev/hvac-ai-engineer/apps/api/wrangler.jsonc) and set:

- `database_id` to your real D1 id
- `APP_ORIGIN` to your live frontend URL later
- keep `GOOGLE_CLIENT_ID` correct

## Step 5: Deploy the API

### 5.1 Create the production secret

Run from the repo root:

```bash
cd /Users/wolfcancode/Dev/hvac-ai-engineer
npx wrangler secret put SESSION_SECRET --config apps/api/wrangler.jsonc
```

Paste a long random value when prompted.

### 5.2 Apply production database migrations

```bash
cd /Users/wolfcancode/Dev/hvac-ai-engineer
npm --workspace apps/api run d1:migrate:remote
```

### 5.3 Deploy the Worker

```bash
cd /Users/wolfcancode/Dev/hvac-ai-engineer
npm run deploy:api
```

After deploy, copy the Worker URL. It will look similar to:

- `https://hvac-ai-engineer-api.<your-subdomain>.workers.dev`

## Step 6: Deploy the Frontend

### 6.1 Create production frontend env

Copy the example file:

```bash
cd /Users/wolfcancode/Dev/hvac-ai-engineer
cp apps/web/.env.production.example apps/web/.env.production
```

Then edit [apps/web/.env.production](/Users/wolfcancode/Dev/hvac-ai-engineer/apps/web/.env.production) and set:

```env
VITE_API_URL=https://your-worker-url.workers.dev
VITE_GOOGLE_CLIENT_ID=890676547124-302d697n0esg78ud37lehv00bv8eui8b.apps.googleusercontent.com
```

Replace `VITE_API_URL` with your real deployed Worker URL from step 5.3.

### 6.2 Create the Pages project

Run this once:

```bash
cd /Users/wolfcancode/Dev/hvac-ai-engineer
npx wrangler pages project create hvac-ai-engineer-web
```

### 6.3 Deploy Pages

```bash
cd /Users/wolfcancode/Dev/hvac-ai-engineer
npm run deploy:web
```

After deploy, copy the Pages URL. It will look similar to:

- `https://hvac-ai-engineer-web.pages.dev`

## Step 7: Connect Frontend and Backend in Production

### 7.1 Update API allowed origin

Open [apps/api/wrangler.jsonc](/Users/wolfcancode/Dev/hvac-ai-engineer/apps/api/wrangler.jsonc) and set:

```json
"APP_ORIGIN": "https://hvac-ai-engineer-web.pages.dev"
```

### 7.2 Redeploy the Worker

```bash
cd /Users/wolfcancode/Dev/hvac-ai-engineer
npm run deploy:api
```

## Step 8: Finish Google Login for Production

In Google Cloud Console, add your live frontend URL to `Authorized JavaScript origins`.

Example:

- `https://hvac-ai-engineer-web.pages.dev`

Keep local too if you still develop locally:

- `http://localhost:5173`

## Step 9: Test Production

Open the live Pages URL and test:

1. Google sign in
2. Legend upload
3. Drawing upload
4. Model import
5. Reconciliation
6. Refresh page
7. Sign out and sign in again

## Useful Commands

From the repo root:

```bash
npm run dev:api
npm run build
npm run typecheck
npm run deploy:api
npm run deploy:web
```

## Common Mistakes

### Local login works, upload returns `401`

You are almost certainly mixing:

- `localhost`
- `127.0.0.1`

Use `localhost` only.

### Production login works, upload returns `401`

This is usually a cookie/origin mismatch:

- frontend URL is wrong in `APP_ORIGIN`
- Google origin is missing
- frontend is still pointing at the wrong `VITE_API_URL`

### Production API returns `500`

Check these first:

1. `SESSION_SECRET` is set in Cloudflare
2. D1 migrations were applied remotely
3. `database_id` in [apps/api/wrangler.jsonc](/Users/wolfcancode/Dev/hvac-ai-engineer/apps/api/wrangler.jsonc) is correct
4. the Worker was redeployed after config changes

## Security Notes

- The Google `client secret` is not used by this app.
- Do not put the Google client secret in the frontend.
- Do not commit `.dev.vars`, `.env.local`, or `.env.production` with real secrets.
