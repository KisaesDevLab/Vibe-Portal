# Code copied from Vibe Time & Billing

Vibe Portal copies parts of [Vibe-Time-Billing](https://github.com/KisaesDevLab/Vibe-Time-Billing)
rather than sharing packages with it (BUILD_PLAN.md D1, D12), so the two release on their own.
Each copied file's second line names its source path and TB commit. This file is the log.

| Field | Value |
|---|---|
| Source repo | `KisaesDevLab/Vibe-Time-Billing` |
| Last synced commit | `4b14d2f5` |

## Copied as-is

| Here | From TB | Notes |
|---|---|---|
| `packages/ui/src/**` | `packages/ui/src/**` | Whole design system; package name kept as `@vibe/ui` |
| `packages/crypto/src/**` | `packages/crypto/src/**` | Envelope encryption + firm key manager (P6); package name kept as `@vibe/crypto` |
| `.eslintrc.cjs`, `.prettierrc`, `.prettierignore`, `.editorconfig`, `.gitattributes`, `.nvmrc`, `.gitignore`, `LICENSE.md` | same | Tooling and licence |

## Based on (changed)

| Here | From TB | Changes |
|---|---|---|
| `apps/portal/vite.config.ts` | `apps/portal/vite.config.ts` | No PWA plugin; port 5197; API on 3101 |
| `apps/portal/src/main.tsx` | `apps/portal/src/main.tsx` | No service worker |
| `tsconfig.base.json` | `tsconfig.base.json` | Paths for this repo's packages |
| `packages/db/src/migrations.ts` | `packages/db/src/scripts/migrate.ts` | Runner split from the connection so tests use pglite |
| `apps/api/src/lib/contact.ts` | `packages/core/src/auth/{sms-otp,email}.ts` | Same normalisation; adds `maskContact` |
| `apps/api/src/auth/*`, `portal/*` | `apps/api/src/auth/portal-routes.ts`, `portal-invites/grant.ts`, `portal-access-requests/` | Same flow and endpoint shapes, rewritten for Postgres sessions and limits (no Redis, no JWT) |

## Log

| Date | TB commit | What |
|---|---|---|
| 2026-11-09 | `4b14d2f5` | Phase 1: ui, crypto, tooling, portal shell |
| 2026-11-09 | `4b14d2f5` | Phase 2: contact helpers; sign-in, invitations and access requests modelled on TB |
