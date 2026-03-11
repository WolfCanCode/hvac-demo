# HVAC AI Engineer

Cloudflare-first MVP for HVAC drawing legend extraction, drawing MTO capture, 3D model import, reconciliation, and feedback-driven AI progress tracking.

## Stack

- `apps/web`: React + Vite frontend
- `apps/api`: Hono Worker API for Cloudflare Workers
- `packages/shared`: shared types and core extraction/reconciliation logic
- `migrations`: D1 schema

## Development

```bash
npm install
npm --workspace apps/api run d1:migrate
npm run dev:api
VITE_API_URL=http://localhost:8787 VITE_GOOGLE_CLIENT_ID=your-google-client-id.apps.googleusercontent.com npm --workspace apps/web run dev
```

## Cloudflare setup

1. Create a D1 database and an R2 bucket.
2. Update the IDs and placeholder vars in [`apps/api/wrangler.jsonc`](/Users/wolfcancode/Dev/hvac-ai-engineer/apps/api/wrangler.jsonc).
3. Apply the migration:

```bash
npm --workspace apps/api run d1:migrate
```

4. Deploy the Worker and the frontend when ready.

## Deployment

1. Authenticate Wrangler:

```bash
npx wrangler login
```

2. Set a real session secret for the Worker:

```bash
npx wrangler secret put SESSION_SECRET
```

3. Apply production D1 migrations:

```bash
npm --workspace apps/api run d1:migrate:remote
```

4. Deploy the API Worker:

```bash
npm run deploy:api
```

5. Create the Pages project once if it does not exist yet:

```bash
npx wrangler pages project create hvac-ai-engineer-web
```

6. Build and deploy the frontend:

```bash
cp apps/web/.env.production.example apps/web/.env.production
npm run deploy:web
```

7. Update `APP_ORIGIN` in [`apps/api/wrangler.jsonc`](/Users/wolfcancode/Dev/hvac-ai-engineer/apps/api/wrangler.jsonc) to your live Pages URL, redeploy the Worker, and add that same live URL to Google OAuth Authorized JavaScript origins.

## Google authentication

1. In Google Cloud Console, create a Web OAuth client.
2. Add `http://localhost:5173` to Authorized JavaScript origins for local development.
3. Set the same client ID in both places:
   - `apps/api/wrangler.jsonc` as `GOOGLE_CLIENT_ID`
   - frontend env as `VITE_GOOGLE_CLIENT_ID`
4. Replace `SESSION_SECRET` in [`apps/api/wrangler.jsonc`](/Users/wolfcancode/Dev/hvac-ai-engineer/apps/api/wrangler.jsonc) with a long random string before local auth testing.
5. Keep both frontend and API on the same hostname during development. Do not mix `localhost` and `127.0.0.1`, because the session cookie will stop being sent consistently.
6. Before production sign-in works, add your live Pages origin too, for example `https://hvac-ai-engineer-web.pages.dev`.
