# Vibe Portal

A client file portal for firms that run **Vibe Files** but not **Vibe Practice Management**.
Staff share files with clients from Vibe Files; clients sign in to download them and to upload
documents, which come back into Vibe Files' Intake. Installed as an app on the Vibe Appliance.

See [BUILD_PLAN.md](BUILD_PLAN.md) for the design and phases, and [QUESTIONS.md](QUESTIONS.md)
for decisions.

## Develop

Node 24, pnpm 9, and Docker for the database.

```sh
pnpm install
cp .env.example .env
pnpm docker:up        # Postgres on localhost:5433
pnpm dev              # API on :3101 (applies migrations), portal on :5197
pnpm gate             # typecheck, lint, format, headers, tests, build
```

Licence: PolyForm Small Business 1.0.0 (see `LICENSE.md`). Parts are copied from Vibe Time &
Billing; see [VENDORED.md](VENDORED.md).
