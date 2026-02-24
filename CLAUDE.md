# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

MailPilot AI — a full-stack Next.js 16 email management app with AI-powered classification. Users connect Gmail/Outlook accounts via OAuth, emails are synced and classified by OpenAI GPT-5.2, and a dashboard displays prioritized results.

## Commands

- `npm run dev` — Start dev server at http://localhost:3000
- `npm run build` — Production build
- `npm run lint` — ESLint
- `npx prisma generate` — Regenerate Prisma client after schema changes
- `npx prisma migrate dev` — Create and apply a migration
- `npx prisma migrate deploy` — Apply pending migrations (production)

## Architecture

**Core pipeline:** Sync → Classify → Store, orchestrated by the agent pipeline.

### Request Flow
```
Browser (React 19 + TanStack Query)
  → NextAuth v5 middleware (JWT auth)
  → Next.js API routes (thin wrappers)
  → Service layer in src/lib/
  → Prisma ORM → PostgreSQL
```

### Key Services (`src/lib/`)
- **agent-pipeline.ts** — Orchestrator: triggers sync, then classifies up to 500 unclassified emails. Runs fire-and-forget; API returns a `runId`, client polls `/api/agent/runs/{id}` at 2s intervals.
- **email-sync.ts** — Syncs all connected accounts. Handles token refresh (5-min buffer), incremental sync (Gmail historyId / Outlook deltaLink), and upserts to avoid duplicates.
- **gmail.ts / outlook.ts** — Provider-specific API clients. Gmail uses `googleapis`, Outlook uses `@microsoft/microsoft-graph-client` + MSAL.
- **classifier.ts** — Batches emails (15/batch) to GPT-5.2 via Responses API. 16-category classification (approval, reply-needed, task, meeting, fyi, personal, support, finance, travel, shipping, security, social, notification, newsletter, marketing, spam). Two-pass: low-confidence results re-classified with full body using per-category confidence thresholds. Post-processing overrides automated/noreply senders. Retries with exponential backoff.
- **category-colors.ts** — Shared category-to-Tailwind-color mapping used by email-list and email-detail components.
- **auth.ts** — NextAuth v5 config with Google + Microsoft Entra ID providers. JWT strategy. Auto-creates `EmailAccount` on sign-in.

### Frontend (`src/components/`, `src/hooks/`)
- Split-pane dashboard: virtualized email list + detail view with thread chain
- React Query hooks: `useEmails()` (cursor-paginated), `useEmailDetail()`, `useAgentRun()` (mutation + polling)
- Zustand for local UI state

### API Routes (`src/app/api/`)
- `emails/` — Cursor-paginated list + detail. Cursor is `receivedAt` ISO string, limit 1-100 (default 50).
- `agent/analyze/` — Triggers agent pipeline (fire-and-forget)
- `agent/runs/[id]/` — Poll run status
- `agent/cron/` — Daily cron trigger (protected by `CRON_SECRET` Bearer token)
- `accounts/` — Connected email account management

### Database (Prisma + PostgreSQL)
Schema at `prisma/schema.prisma`. Key models: `User`, `EmailAccount`, `Email` (unique on `accountId + externalId`), `Classification`, `AgentRun`, `Draft`, `SenderProfile`. Classifications upsert to enable re-runs.

## Auth & Middleware
- NextAuth v5 with JWT session strategy and Prisma adapter
- `src/middleware.ts` protects all routes except `/api/auth`, `/api/agent/cron`, `/login`
- OAuth scopes: Gmail (`gmail.readonly`, `gmail.send`), Outlook (`Mail.Read`, `Mail.Send`, `offline_access`)
- Access/refresh tokens stored in JWT; auto-refreshed in sync engine

## Key Patterns
- **Path alias:** `@/*` maps to `src/*`
- **UI components:** shadcn/ui (new-york style) in `src/components/ui/`
- **Email HTML safety:** sanitized with `dompurify`, rendered in sandboxed iframes
- **Zod validation** on OpenAI responses for type-safe classification results
- **Upsert-based sync** with compound unique constraints to handle duplicates

## Email Classification (16 Categories)
- **Action-required:** approval, reply-needed, task
- **Informational:** meeting, fyi, personal, support
- **Transactional:** finance, travel, shipping, security
- **Automated/Bulk:** social, notification, newsletter, marketing, spam

Priority levels P1 (Immediate) through P5 (Noise). Category stored as `String` in Prisma — no migration needed when adding/removing categories. The `EmailCategory` type union in `src/types/index.ts` is the source of truth for TypeScript.

## Environment Variables
`DATABASE_URL`, `NEXTAUTH_SECRET`, `NEXTAUTH_URL`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `OPENAI_API_KEY`, `CRON_SECRET`

## Deployment
Render blueprint in `render.yaml` — web service + PostgreSQL + daily cron job (8 AM UTC).
