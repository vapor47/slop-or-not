# Slop or Not

Invite-based photo guessing game. One owner creates up to ten questions; guests pick the AI-generated image without an account. Games expire seven days after publication; their images are deleted, while generation analytics are kept (see [Analytics and retention](#analytics-and-retention)).

Uploaded originals are assumed authentic; this MVP does not detect AI-generated uploads.

## Run

Requires Node.js 24+ and a persistent local volume for SQLite. Images live in a private S3-compatible bucket, not on the application disk.

```sh
npm install
cp .env.example .env
node scripts/setup-owner.mjs
# Enter and confirm a strong password; input is hidden.
# The helper writes OWNER_PASSWORD_HASH to .env automatically.
npm start
```

The owner setup helper hides input and saves only a salted password hash (do not put the password in command-line arguments). Set the remaining variables in `.env` using your local editor or secret manager. Open `http://localhost:3000/create`. Guests receive `/g/<invite>` links.

Without credentials, the app can serve its UI and owner drafts, but uploads are blocked. There is no production mock model or default owner password.

## Required configuration

- `OWNER_PASSWORD_HASH`: single-owner password hash; no recovery or additional accounts.
- `APP_ORIGIN`: exact browser-facing origin, including port for local use. Production requires HTTPS. This is the CSRF allowlist; configure it correctly behind a proxy.
- `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`: private bucket and server-only credentials limited to object get/put/delete in `slop/`.
- `S3_ENDPOINT`: S3-compatible endpoint (for example your R2 endpoint). Omit for AWS S3; set its actual `S3_REGION`. R2 uses `auto`. Some compatible services require `S3_FORCE_PATH_STYLE=true`.
- `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`: an account token with Workers AI access.
- `DESCRIPTOR_TERMS_ACCEPTED`: set `true` after accepting the descriptor model’s terms in Cloudflare. Cloudflare documents an initial request with `{"prompt":"agree"}` to the Llama model endpoint. The app does not accept terms automatically. See [the model documentation](https://developers.cloudflare.com/workers-ai/models/llama-3.2-11b-vision-instruct/).

Keep the S3 bucket private, disable public bucket access, and avoid public signed URLs. Guests fetch server-authorized, neutrally named image URLs; originals and generated images are normalized identically. Recommended storage backstop: configure an object lifecycle rule deleting `slop/` objects after **15 days**, and disable object versioning or expire noncurrent versions too. The application normally deletes expired images within a minute while running; the lifecycle rule handles prolonged downtime. A draft can be almost seven days old when published, so a seven-day object lifecycle would delete live game images prematurely.

## Independent model steps

The approved defaults are:

1. Descriptor: `@cf/meta/llama-3.2-11b-vision-instruct`
2. Generator: `@cf/black-forest-labs/flux-1-schnell`, four steps

`ImageDescriptor` and `ImageGenerator` in `src/types.ts` are independent interfaces. `CloudflareDescriptor` and `CloudflareGenerator` implement them separately; the pipeline accepts each independently. The generator receives only saved description text, never the original image. No combined multimodal call or automatic provider switching is used.

Both prompts live in the versioned `prompt_templates` table, seeded from `src/prompts.ts`: the descriptor instruction, and the generator prefix (`A natural, realistic photograph. `) that is followed directly by the saved description. Templates are immutable. Changing a default in `src/prompts.ts` to text not seen before adds a new active version on the next start, and `Repository.addTemplate` does the same at runtime. Restarts never re-add text that already exists, so a runtime edit is not reverted. Old versions stay for attribution: deactivate them, never edit or delete them (database triggers enforce this). Each upload snapshots the active template versions, just as it snapshots model ids.

Change `DESCRIPTOR_MODEL` and `GENERATOR_MODEL` independently for compatible Cloudflare models/version names. New uploads snapshot both model identifiers and their budget assumptions; changing settings does not change models for pending questions. Model aliases are only as stable as the provider makes them: use explicit snapshot identifiers when available. A different AI product requires implementing just its descriptor or generator adapter and changing the composition in `src/main.ts`. Adjust the adapter’s request schema and response parsing for that product; changing a model identifier alone cannot make unrelated APIs compatible. Existing queued questions should be drained before switching providers, or the replacement adapter must route their stored model identifiers.

A successful description is persisted before generation is queued. Temporary errors get **three automatic retries after the initial attempt** per step. Permanent access/validation failures fail immediately. Manual retry resumes the failed step and is limited to two retry cycles per question. A process crash after a provider has completed but before a checkpoint is persisted can repeat that call: provider-side exactly-once billing is not guaranteed.

## Budget enforcement

SQLite `BEGIN IMMEDIATE` transactions reserve capacity before upload bodies are accepted. Each question reserves four calls per step, initially **1,040 units**: four times `(200 descriptor + 60 generator)`. These conservative per-call estimates are configurable independently with `DESCRIPTOR_NEURON_RESERVATION` and `GENERATOR_NEURON_RESERVATION`. The default app daily budget is **9,000 units**, leaving headroom under Cloudflare’s 10,000-neuron allowance. Reservations permit eight new questions per day with default settings; a ten-question game can be assembled across days. Unused successful-generation reservations are intentionally retained for the day rather than optimistic refunds. Invalid/interrupted uploads refund unused reservations.

Retries reserve another bounded cycle; queued work crossing midnight UTC must reserve capacity for the new day before making calls. The app cannot observe other applications consuming the same Cloudflare account allowance, nor enforce actual provider charges from estimates. Use a Workers Free account, verify actual neuron usage on the sample, and set the application budget below the account allowance after accounting for any other uses. Changing models or parameters requires revalidating the per-call estimates. Requests fail gracefully if Cloudflare returns exhausted capacity.

[Cloudflare pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/)

## Analytics and retention

The app records metadata about every question and model call so that we can later analyse how descriptor prompts, providers, models and model versions affect how often guests are fooled. These tables are append-only and live in the same SQLite file:

- `prompt_templates`: every prompt version ever used (`step`, `name`, `version`, `text`, `created_at`, `active`).
- `generation_runs`: one row per provider call attempt, whether it succeeded or failed. Each row records `provider` (the AI application, e.g. `cloudflare-workers-ai`) and `model_id` exactly as sent. `model_version` is filled only if the provider reports one; Workers AI does not, so it is null. Each row also records the prompt template, the exact `prompt_text` sent, `params_json` (e.g. `steps`, `temperature`, `max_tokens`), the full untruncated descriptor `output_text`, provider `usage_json` when returned, the start/finish timestamps and latency, the attempt number and manual retry cycle, `status` and `error_kind` (`temporary`/`permanent`), the reserved units, and `app_version` (package version plus git SHA; set `GIT_SHA` or `APP_VERSION` where `.git` is unavailable, e.g. `docker build --build-arg GIT_SHA=$(git rev-parse HEAD)`). A call interrupted by a crash or restart stays `running` until its lease expires and the question is next picked up, then it is finalised as `failed`/`temporary` with error `interrupted` (`latency_ms` stays null).
- `question_analytics`: one row per uploaded question. It holds the created, uploaded, described, ready, failed and removed timestamps (`failed_at` is cleared by a manual retry; every failed attempt stays in `generation_runs`), the snapshotted template ids, the ids of the successful describe and generate runs, and the dHash Hamming distance between the original and the generated image.
- `image_metrics`: per question, for both the original and the generated image (both already normalized). It holds the SHA-256, bytes, width and height, a 64-bit dHash, mean brightness, contrast (greyscale standard deviation), sharpness (Laplacian variance) and colorfulness.

**Retention.** Images and live game state are deleted on the existing schedule. At expiry, image objects are deleted and the `questions` and `plays` rows are removed; the `games` row is kept and marked deleted. The four analytics tables are never touched by expiry or by game deletion, and are **kept indefinitely**. Pixel-derived metrics are therefore computed in the pipeline while the images still exist, because they cannot be recomputed later. A question removed by the owner keeps its analytics rows (marked `removed_at`), since its provider calls really happened. An upload cancelled before it completed made no provider calls, and its row is dropped.

The descriptor `output_text` is text derived from the owner's photo, and it is kept indefinitely so that prompt effects can be studied after the image is gone. It describes visible content only: the descriptor prompt forbids inferring identities, and EXIF is stripped before anything is stored. The analytics tables hold no guest data. Guess outcomes are still deleted with `plays` at expiry until guess telemetry is added.

## Validate the sample before release

```sh
npm run sample -- /path/to/photo1.jpg /path/to/photo2.png
```

This explicitly makes two live model calls per sample (one to each model, no retries), for one to five photos. It saves normalized image pairs, descriptions, model identifiers and timings under ignored `data/sample/`. Compare likeness, plausible photographic quality, and guessing difficulty. Record account neuron usage before and after in Cloudflare to validate costs and free-tier capacity; the script does not invent cost measurements. Samples are local review artifacts, never a published game.

## Verification

```sh
npm run verify
```

Tests cover prompt template seeding and immutable versioning, generation-run recording on success and temporary/permanent failure, image metrics, analytics surviving expiry, migration of an existing database, score correctness, repeated answer/Next requests, persistence across reopening SQLite, independent randomized playthroughs, publication freezing, question limits, budget reservations from two database connections, daily rollover, bounded step retries, crash leases, expiration and deletion, late image writes, model separation, upload-content validation and stripped metadata. Route integration uses the real request handler with in-process streams so it can run without opening a port. It uses injected fake storage/models and does not claim to verify Cloudflare or S3.

Image tests require Sharp to be installed and do not skip security checks. TypeScript checks and all image tests must pass with dependencies installed. Browser verification should cover a mobile viewport, image failures and retry, refreshing during feedback, resuming later, double-clicking Next, replay, login failure and expired links.

## Deployment

The Dockerfile supports a Node host with a persistent volume. Set `NODE_ENV=production`, `HOST=0.0.0.0`, `APP_ORIGIN=https://your-domain`, and `DATA_DIR=/data`; mount persistent storage at `/data`. Put HTTPS in front of the container and supply secrets at runtime. Keep one active application replica with this SQLite volume; do not use disposable container storage or independent SQLite copies across replicas. Back up the database together with its WAL using SQLite’s backup facilities.

Generation jobs are database-backed and survive restarts. The service polls work every second and runs expiration/deletion every minute. Keep the process running for scheduled deletion; startup also expires stale games. Durable deletion tombstones retry S3 failures and survive restarts. Public links stop working immediately at expiry even if object deletion is delayed.

Structured server logs report processing, worker, request and cleanup failures without provider credentials or descriptions. Collect stderr in the hosting platform and alert on recurring failures; `/health` reports whether generation and storage are configured. This repository does not provision an external monitoring account.

This app uses Node.js, Sharp and persistent SQLite, so the Cloudflare Workers runtime used by Sites is not a drop-in deployment target. A container or equivalent Node host is needed. Hosting, bucket creation and provider credentials have not been provisioned in this workspace.

## Current verification in this environment

Implemented creator and guest flows, S3 and Cloudflare adapters, normalization, durable processing, budgets, cleanup, and container configuration. After dependencies were installed from the owner's terminal, `npm run verify` passes: TypeScript, JavaScript syntax and all tests, including Sharp image security checks, with no skips. The owner confirmed Llama activation, a successful R2 upload/read/delete check and the 15-day lifecycle rule. Package downloads and npm audit requests from the agent environment still fail with `ENOTFOUND registry.npmjs.org`; local port binding is also denied (`EPERM`). Sharp has been upgraded and pinned to 0.35.5; the owner-generated audit report now lists zero vulnerabilities, and all verification checks pass with the upgraded version. Live generation quality/speed/cost checks, browser checks and production deployment remain pending.
