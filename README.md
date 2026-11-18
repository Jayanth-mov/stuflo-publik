# StuFlo

StuFlo is an academic assistant that combines course material, a student's
preferences, and their calendar to answer questions with sources and help
plan their work. The hosted app is at [app.stuflo.com](https://app.stuflo.com).

I started building StuFlo in a private, closed-source repository in summer
2026 and have been working on it for months. I copied the code into this
new public repository to release the same project as open source.

- `dashboard/`: Next.js and React web app, with OpenNext support on Cloudflare.
- `apps/worker-api/`: TypeScript API and one persistent Cloudflare Durable
  Object agent per student. The model uses tools to query course and calendar
  data; Canvas access is read-only.
- `packages/`: shared authentication, billing, calendar, Canvas, crypto,
  Postgres migrations, and usage accounting.
- `extensions/canvas-connector/`: optional Manifest V3 Canvas connector.
  The included manifest targets the official hosted StuFlo app. Forks that
  use it must update its app origins and browser permissions for their host.

## Run locally

Use Node.js 22 or newer, npm, and a disposable PostgreSQL database. Do not point
development or tests at real student accounts or a production database.

```sh
npm ci
```

1. Copy `apps/worker-api/.dev.vars.example` to `apps/worker-api/.dev.vars`.
   Set `DATABASE_URL` to your development database and supply a fresh random
   `AUTH_SECRET` of at least 32 characters. Use your own provider configuration
   for the features you want to exercise. Email sign-in requires Resend, and
   Google sign-in or Calendar access requires your own OAuth client and
   consent-screen settings. Keep the private file out of Git.
2. Apply the checked-in schema with `npm run db:migrate` after setting
   `DATABASE_URL` in your shell to the same development database.
3. Copy `dashboard/.env.example` to `dashboard/.env.local`. The example points
   to the local API on port 8787.
4. Run these in separate terminals and open `http://localhost:3000`:

   ```sh
   npm run dev:api
   npm run dev:dashboard
   ```

Run `npm run verify` for type checking, tests, lint, and the dashboard build.
The repository includes no production credentials. Self-hosted deployments
must supply their own origins, Cloudflare bindings, and service credentials.
The example sets Stripe's test mode; use test keys for local development.

## Publik

The hosted integration is opt-in for forks. Leave `PUBLIK_ENABLED` unset
to develop with the normal StuFlo sign-in flow. To enable it on your own
host, register your application with [Publik](https://publikhq.com), enable
`PUBLIK_ENABLED=true` on your API Worker, and configure your own
`PUBLIK_APP_TOKEN` and `PUBLIK_INSTALL_SECRET` as Worker secrets. Never use
production tokens, student keys, or the official app's install configuration
to test a fork.

## License

The source code is available under the [MIT License](LICENSE). The StuFlo
name, logo, avatar, and extension artwork identify the official product;
the source license does not grant permission to use StuFlo branding. Replace
these assets when distributing a fork under your own brand. Third-party
dependencies keep their respective licenses.
