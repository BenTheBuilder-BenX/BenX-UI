# Easy installation · BenX 0.9

BenX runs on your Cloudflare Worker. Your VPS runs the VPN cores. You do not need another panel, a manually created database, a session secret or a password of your own choosing to get started.

## Install from GitHub

The public source is [BenTheBuilder-BenX/BenX-UI](https://github.com/BenTheBuilder-BenX/BenX-UI). Use the official **Deploy to Cloudflare** button in [README](../README.md). [راهنمای فارسی](guide.fa.md).

Install:

1. Open the BenX public GitHub repository and choose **Deploy to Cloudflare**.
2. Sign in to Cloudflare, connect your GitHub account and choose the account and Worker name. Cloudflare creates a copy in your Git account and provisions the private D1 database.
3. Keep **Build command: `npm run build`** and **Deploy command: `npm run deploy`**. The repository root is the project root. Use Node.js 24 where a version is requested. There are no required secret-value prompts in the supplied example file. Allow Cloudflare's requested account/resource authorization.
4. Wait for the deployment to finish. Open the **private one-use setup link** at the end of the deployment log. Choose **Create my login & sign in**.
5. Save the generated username/password using **Copy login details** or **Download login details**, then **Open my panel**. Future sign-in asks only for those two fields.

Cloudflare's official [Deploy-button workflow](https://developers.cloudflare.com/workers/platform/deploy-buttons/) supports public GitHub/GitLab repositories, account authorization, repository cloning and resource provisioning. BenX supplies the automatic secret/schema setup. This complete account flow still requires staging verification before release.

If the button is unavailable, Cloudflare → **Workers & Pages → Create → Import a repository** can connect your own clean BenX repository. Choose the same build/deploy commands. Create a **Worker**, with the included Wrangler configuration. Preserve its `DB` binding and generated resource IDs after deployment.

Keep deployment logs and setup links private. The ordinary panel address does not grant ownership. No public signup is enabled. The Cloudflare consent steps cannot safely be bypassed by the panel.

## Command-line fallback

Use a clean source checkout or the sanitized source kit. The kit's `wrangler.jsonc` includes only a `DB` binding; Wrangler creates the resource. Do not upload the original operational workspace or replace an existing production configuration with defaults.

```sh
npm ci
npx wrangler login
npm run deploy
```

Use the printed private setup link. You do not need `d1 create`, a database ID, SQL imports or `secret put`. The helper builds if necessary. Its first installation uses two deployments: one prepares and claims the empty database; the second adds generated secrets. This can take time and requires outbound HTTPS to the new workers.dev address.

An API-token-based installation needs authorization to deploy/manage the Worker and provision/bind D1 in the intended account. For manual database export/restore, additional D1 management authorization may be needed. Do not put an API token in GitHub source or browser storage.

## Change your login

Open **My account**. Enter your current password, edit the username and/or enter a new password, then **Save my login**. Leave the new password blank to change just the username. New passwords are 12–128 characters; usernames are 3–64 ASCII letters/numbers with dots, underscores, @ or hyphens.

Your current session stays open. Older sessions for the same account end. Team members can change their own login without changing their role or permissions. Changing the login does not rotate the installation encryption key or disconnect your VPSs.

The owner should also download **Private recovery information** with the current password and keep it securely beside a full D1 backup. The recovery file contains sensitive original installation keys. It is not a complete backup and does not contain the current login password. Never share it in an issue or support chat.

## Connect your VPS

Open **Getting started → Connect your VPS → Direct agent connection**. Follow the private installer instructions on your VPS. It checks authenticated HTTPS reachability before host changes. Wait for the agent to connect, verify setup, then add cores, inbounds, clients, subscriptions and tunnels as needed.

Installing a privileged agent still requires access to that VPS through SSH or your provider console. A Worker cannot silently take control of a VPS. Automatic SSH installation is an optional advanced path requiring your own relay. See [the full launch guide](launch-guide.md) for firewall, protocol, accounting, tunnel, domain and shop acceptance.

The workers.dev URL works for panel/subscriptions by default. A custom domain is optional. Manual Cloudflare DNS/domain setup is available; the panel-assisted domain tool requires an additional scoped Cloudflare API token, since deployment authorization is not exposed to the running panel.

## Updates and recovery

Normal deployments preserve existing keys and login. The built-in migration runner updates the database through its bound connection; it does not need a separate SQL-management token. Keep complete backups before updating.

| Situation | Action |
| --- | --- |
| First setup link was lost, login never created | Run `npm run setup:link`, or temporarily use that as the Cloudflare deploy command. Open the new private link, then restore `npm run deploy`. Already-created accounts cannot be replaced by this link. |
| Owner password was lost after activation | From the authorized Cloudflare build or clean checkout, run `npm run account:recover`. Open its private one-use recovery link, generate a new login and save it. Restore the normal deploy command afterward. Original installation keys remain intact. |
| First installation stopped before keys were uploaded | Stop **all** previous installation/build runs. Only for an empty, unconfigured installation, run `npm run setup:resume`. It explicitly replaces the initial database claim. Never run this while an earlier installer can still upload keys. |
| Some original installation keys are missing | Restore the **original** missing keys from your private recovery file. The helper refuses to generate replacements against a partial installation. Do not change the encryption key for an existing database. |
| Database setup says it is finishing | Wait briefly and refresh. Completed migration files are retained; an active migration lease or exhausted per-request setup budget returns a retryable response. The deploy helper retries the same initial claim. |
| Account authorization or resource provisioning fails | Check Cloudflare's build/account settings and permissions. The helper fails closed and preserves original secrets. Do not treat a failed deployment as success. |

Recovery commands require Cloudflare account control. They are not public password-reset endpoints. A stolen private activation/recovery link grants owner access until used; protect build access and rotate the link if exposed.

## Maintainer: attach the real deploy button

After the reviewed clean source is assigned its actual public repository URL, run:

```sh
npm run release:repository -- <actual-public-repository-url>
```

This updates package repository metadata and an idempotent official Deploy-button block in README. It does not create a repository, push, publish or deploy anything. Commit the result to that repository when publication is authorized. Cloudflare cannot deploy from this unpublished local directory by public-repository link.

Before launch, complete [release acceptance](release-acceptance.md), including a real fresh-account install and an existing-account upgrade. Local test results and deployment dry runs do not prove that account consent, provider authorization or live VPS traffic works.
