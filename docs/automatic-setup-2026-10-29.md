# Automatic setup and account changes · 29 October 2026

BenX 0.9 prepares a minimal-input self-hosted installation. Publication remains on hold. No repository, Cloudflare deployment, live database or VPS was created or changed while implementing this work.

## User-visible behavior

- The intended primary flow is public GitHub → official Deploy to Cloudflare → private setup link → generated username/password → signed-in panel. No manual password, session secret, encryption key, database ID or schema import is required for a fresh install.
- Normal login has only username/password. My account lets the owner, administrators and resellers change their own login with their current password. Older sessions for that account end; installation encryption remains unchanged.
- First activation/recovery shows the generated password once, with copy/download and an explicit Open my panel action. The fragment is removed from history when opened. The public address cannot claim an uninitialized owner account.
- An owner-only, current-password-protected recovery download retains original installation key seeds. A complete D1 backup, including owner_account, is still required. Optional Cloudflare API/domain integration tokens are excluded.
- English and Persian cover the new setup/account interface. Other existing languages fall back to English for new messages.

## Deployment and data safety

The example Wrangler configuration uses a binding-only D1 declaration. Wrangler's automatic provisioning creates or inherits the database; the helper preserves actual existing IDs/configuration. A comment-only .dev.vars.example avoids Cloudflare turning internal values into manual form prompts. Local setup creates private values once and preserves existing files.

The helper reads secret **names**, never secret values. Authorization/metadata failures and partial key sets abort. An update sends no replacement core keys. Cloudflare documents that secrets omitted from a [deployment secrets file](https://developers.cloudflare.com/workers/configuration/secrets/) remain configured.

Fresh installation has a two-phase handshake: deploy a random installation proof; initialize schema through the bound D1 database; atomically acquire a permanent first-install claim; then generate/upload the core keys and print the private setup link. Losing simultaneous builds cannot upload competing encryption keys. Claims do not expire and silently reset keys. Explicit resume is restricted to an empty/unconfigured database and requires stopping all earlier installers.

The runtime migration bundle is generated from the repository SQL files. Per-file statements and migration markers run atomically, under a renewable cross-isolate lease. Completed files survive interruption. The runner budgets binding calls below Cloudflare's [Free-plan per-invocation limit](https://developers.cloudflare.com/d1/platform/limits/); batch calls count once. More work or a busy lease returns 503 for a later retry. Separate management-API SQL permissions are not required to initialize through the bound DB.

Owner passwords use salted PBKDF2-SHA256 hashes. Versioned owner sessions prevent a previous login from remaining valid after a change. Once the database owner exists, the environment seed password is not a fallback login. Cloudflare-issued account recovery rotates only owner credentials and persists a consumed-token hash to reject replay, including after later account changes.

## Validation and release limits

Validation passed: 423 application tests, 116 agent tests, TypeScript/ESLint, the production build and the deployment-helper dry run. Initial JavaScript is about 78.4 KB compressed and production sample-fixture exclusion passes. Browser inspection confirmed the two-field sign-in, account form, setup action, and English/Persian setup layout.

Application tests cover generated activation, concurrent activation, seed-login rejection, credential changes, session invalidation, staff scope, private recovery, token replay, first-install ownership, interrupted migrations and install-helper behavior. SQLite-backed schema tests initialize all migrations without a database-management token and check the binding-call budget. Installer tests use synthetic accounts and mocked Cloudflare commands; no remote deployment is performed.

`npm run test:install` additionally bundles the actual Worker and runs it in Cloudflare's local workerd runtime with a new D1 database. It passed automatic initialization, first-install claim, activation, generated login, hidden-seed rejection, current-password account changes, old-session revocation and preservation of recovery keys. This check is included in release:check. It writes only local test state and uses synthetic credentials.

The official [Deploy-button documentation](https://developers.cloudflare.com/workers/platform/deploy-buttons/) supports public repositories and resource provisioning. The real public URL does not exist yet; a repository-metadata helper attaches the official button once it does. No deploy.json mechanism or fake repository has been introduced.

Live fresh-account Deploy-button acceptance, default build-token authorization, simultaneous remote builds, update/recovery and real VPS/client/payment acceptance remain release gates. The main launch guide and release checklist describe them. This candidate must not be advertised as fully production-accepted based on local checks alone.
