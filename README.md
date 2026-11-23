# BenX-UI

**A Cloudflare Worker VPN control panel — built by Ben the Builder.**

**[Download the illustrated panel handbook](https://github.com/BenTheBuilder-BenX/BenX-UI/raw/refs/heads/main/docs/panel-guide.zip)** · Unzip and open `BenX-UI-guide.html` in your browser. Includes English and فارسی, a setup checklist, searchable sections and step-by-step instructions. [View the HTML file](docs/panel-guide.html)

[فارسی](README.fa.md) · [Operator guide](docs/operator-guide.md) · [راهنمای همهٔ بخش‌ها](docs/operator-guide.fa.md) · [Installation](docs/easy-install.md) · [Cloudflare operations](docs/cloudflare.md)

**[v0.9.0-preview.3](https://github.com/BenTheBuilder-BenX/BenX-UI/releases/tag/v0.9.0-preview.3)** adds metered MasterDNS subscriptions, Telegram purchase delivery for DNS plans, and English and Persian guides inside the panel. [Release notes](docs/release-2026-11-22.md)

<!-- BENX_DEPLOY_BUTTON -->
[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https%3A%2F%2Fgithub.com%2FBenTheBuilder-BenX%2FBenX-UI)
<!-- /BENX_DEPLOY_BUTTON -->

BenX separates management from VPN traffic. The React interface and API run on Cloudflare Workers, private state lives in D1, and a privileged Linux agent runs the actual cores on your VPS. The Worker is not a VPN endpoint and does not carry clients’ VPN traffic.

**Version 0.9: public source preview.** Automated checks cover the application, agent and fresh installation in Cloudflare’s local runtime. Real Cloudflare account installation, Linux packages, VPN clients, tunnels and payments still require staging acceptance. Passing tests cannot establish that software has no bugs.

## Why it is different

| Design | What it changes for you |
| --- | --- |
| Worker API + D1 + Static Assets | Host the panel without maintaining a separate panel web server. VPSs are still required for VPN traffic. |
| Outbound HTTPS agent | Normal native management needs no publicly exposed agent port or shared SSH relay. |
| Native mode and optional 3X-UI compatibility | Use included native adapters or connect a supported existing panel; their capabilities differ. |
| Saved desired configuration | Keep reviewed profiles and revisions centrally. Unsupported changes fail explicitly. |
| Durable encrypted commands | Per-node authentication, encrypted requests/results, timeouts and acknowledgement journals. Claimed privileged work is not blindly replayed. |
| Owner, administrator and reseller workspaces | Scope server access, customer allocation, subscriptions and optional Telegram sales. |
| Persian RTL and English | Responsive navigation, light/dark themes and bilingual setup guides. |

BenX is independently developed. It does not promise every upstream feature, faster VPN traffic by moving management to Cloudflare, or freedom from Linux administration.

## Install on Cloudflare

1. Click **Deploy to Cloudflare** and authorize your own GitHub/Cloudflare account. It copies this repository into your account and provisions the `DB` D1 binding.
2. Use repository root, Node.js **24**, build **`npm run build`**, deploy **`npm run deploy`**. Create a Worker using the included Wrangler configuration.
3. Wait for completion, then open the **private one-use setup link** at the end of the Cloudflare deployment log.
4. Choose **Create my login & sign in**, save the generated username/password, then open the panel. There is no public signup.
5. Open **Getting started → Connect your VPS → Direct agent connection**. Review the private installer and run it as root on your own supported VPS. Verify agent/core status.
6. Create a test inbound/customer and verify real client traffic, expiry and revocation before serving customers.

The helper creates installation keys and initializes tables. Updates preserve keys and login. The workers.dev address works for panel/subscriptions; a custom domain is optional. Keep build logs, setup links and recovery files private. The complete account authorization/provisioning flow requires your own live verification.

If the button is unavailable, use **Workers & Pages → Create → Import a repository**, with the same commands and your own clean repository copy.

```sh
git clone https://github.com/BenTheBuilder-BenX/BenX-UI.git
cd BenX-UI
npm ci
npx wrangler login
npm run deploy
```

See [English setup](docs/easy-install.md), [فارسی](docs/guide.fa.md) and [VPS launch guide](docs/launch-guide.md). Never replace an existing installation’s encryption key with a newly generated key.

## Common tasks

| Task | Walkthrough |
| --- | --- |
| Offer a limited-data DNS subscription | [Pair MasterDNS with private VLESS](docs/operator-guide.md#masterdns) · [Create the external A/AAAA and NS records](docs/operator-guide.md#dns) |
| Sell and deliver a plan in Telegram | [Configure the bot, payments and order recovery](docs/operator-guide.md#telegram) · [Build the service](docs/operator-guide.md#services) |
| Connect a VPN client or link two VPSs | [Native client setup](docs/operator-guide.md#native) · [Compare the five tunnels](docs/operator-guide.md#tunneling) |
| Run the panel day to day | [Team access](docs/operator-guide.md#team) · [Customer management](docs/operator-guide.md#clients) · [Subscription links](docs/operator-guide.md#subscriptions) · [All sections](docs/operator-guide.md) |

## Features and known limits

- Native Xray, OpenVPN, ocserv/OpenConnect, OpenSSH, WireGuard, DNS resolver and MasterDnsVPN adapters. Provisioning/accounting varies by core.
- Inbounds, customers, services, measured quotas/expiry, QR/profile sharing and Worker subscriptions.
- Reviewed WireGuard, SSH direct/reverse and FRP TLS/WSS tunnels, with separate status/traffic checks and cleanup.
- Supported 3X-UI compatibility, portable saved profiles, standby and recovery workflows.
- Optional owner-only DNS-only A/AAAA records and Worker custom domains, with your own scoped token and signed previews.
- Optional Telegram shop, Stars and seller-reviewed transfers; actual payments need live acceptance. Optional AI assistance needs your own provider configuration.

Standalone sing-box/Hysteria 2 provisioning, general native IP/HWID enforcement, arbitrary panel conversion, automatic outbound logical-ID replacement, complete OS cloning and native online presence are not implemented. Quotas/first-use expiry require a measured adapter. Standalone MasterDnsVPN is unmetered; its shared VLESS backend counts inner payload, excluding DNS overhead/retransmissions.

Agents poll every three seconds by default. The 25-second response deadline can leave an uncertain outcome; inspect actual state before retrying privileged work. Automatic SSH installation requires your own HTTPS relay; direct native enrollment does not. The installer targets Debian 12/13 or Ubuntu 24.04/26.04, x86-64/ARM64, systemd and working HTTPS. Firewall, forwarding, NAT and actual client traffic remain host acceptance tasks.

Read [feature coverage](docs/feature-matrix.md), [release acceptance](docs/release-acceptance.md) and [capacity guidance](docs/cloudflare.md).

## Develop and verify

Use Node.js 24 and Python 3.11+.

```sh
npm ci
npm run setup:local
npm run worker:dev
```

In another terminal run `npm run dev` and open the private setup link printed by the local helper. Existing `.dev.vars` are preserved. Sample workspaces are explicit and excluded from production builds.

```sh
npm run release:check
npm run release:package
```

Checks include types/lint, application/agent tests, production build, sample exclusion, initial JavaScript budget and a local workerd/D1 installation smoke test. Packaging creates an allowlisted clean folder and ZIP with checksums under `test-results/release/`; runtime credentials, live scripts, workspace account/database IDs, supplied font binaries and logs are excluded. GitHub CI checks source and does not deploy your panel.

| Folder | Purpose |
| --- | --- |
| `src/` | React interface and language catalogs |
| `worker/` | API, authentication, subscriptions and orchestration |
| `agent/` | Privileged Linux companion and reviewed adapters |
| `shared/` | Contracts and validation |
| `migrations/` | D1 schema changes |
| `tests/`, `agent/tests/` | Application and agent tests |
| `relay/` | Optional private SSH transport |

## Security and license

Read [SECURITY.md](SECURITY.md). Never post tokens, setup links, profiles, client exports or database backups in public issues. No personal contact address or runtime credential is required in source.

GPL-3.0-only; see [LICENSE](LICENSE). The reviewed API registry and vendored installer retain attribution to [3X-UI](https://github.com/MHSanaei/3x-ui). Native adapters use their respective upstream projects. BenX is not affiliated with Cloudflare or these projects. Supplied Yekan Bakh font binaries are excluded because redistribution rights are unverified; public builds use system fallbacks.
