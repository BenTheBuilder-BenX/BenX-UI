# BenX 0.9 · installation and launch guide

This is a local source candidate. Publishing, GitHub creation and real VPS acceptance are separate steps. Start with one spare VPS and a staging Worker. BenX is the panel; an installed third-party panel is optional.

## 1. Prepare your own Cloudflare installation

Requirements: Node.js 24, Python 3.11+ for agent tests/source packaging, a Cloudflare account with Workers and D1, and a fresh supported Linux VPS. The panel and subscriptions live on the Worker; packet processing stays on the VPS.

Follow [easy installation](easy-install.md). The preferred path is the official Deploy to Cloudflare button on the future public GitHub repository. It clones the source into your account, provisions D1 and runs the build/deployment helper. No download, manual database ID or secret choices are required. The public repository has not been created yet; the button is attached only when its actual URL exists.

For command-line installation, use a clean checkout or the source kit, which includes sanitized `wrangler.jsonc` defaults. Do not upload the original operational workspace. When using the original workspace, copy `wrangler.example.jsonc` into a **separate staging checkout** first; never overwrite a live configuration accidentally.

```sh
npm ci
npx wrangler login
npm run deploy
```

The helper builds when needed, creates/binds D1, claims the first installation before uploading generated keys, and prints a private one-use setup link. Open it and choose **Create my login & sign in**. Save the generated username/password; change either later in **My account**. Download the private recovery file there using your current password, and keep it with a complete database backup. Normal updates preserve login and encryption keys. Never regenerate an encryption key against existing encrypted data.

The database initializes all migrations automatically, including `0025_owner_account.sql`. Existing installations keep their original secrets and login until the owner changes it in My account. Optional `db:local`/`db:remote` commands remain for experienced operators; they are not installation requirements. Outbound agent mode needs no SSH relay variables.

The local development preview uses explicit sample data and cannot enroll a VPS through loopback. For authenticated local API development, run `npm run setup:local`, then `npm run worker:dev` and `npm run dev` in separate terminals. Open the printed private setup link; local tables initialize automatically.

## 2. Connect the first VPS

Use **Getting started → Connect your VPS → Direct agent connection**. Give it a name and location; start with native Xray and add other cores only when needed. Download the private installer. It expires after twenty minutes and contains a pairing secret.

Review the script, transfer it to the VPS using your provider console or an existing SSH session, then run:

```sh
sudo sh benx-connect.sh
```

The script checks root privileges, systemd, the supported OS/architecture and authenticated HTTPS reachability **before changing the host**. It requires curl and trusted CA certificates for that first check. It refuses an existing BenX agent/environment file. Base packages are then installed, the complete agent is written to `/opt/benx-agent`, and the service starts on loopback. Selected core installation runs as a separate serialized setup job; a started systemd service is not proof those jobs succeeded.

Supported fresh-install targets: Debian 12/13 and Ubuntu 24.04/26.04, x86-64 or ARM64. Outbound HTTPS to the Worker, correct system time, apt repositories and upstream release downloads must work. Review minimum OS support when upgrading pinned releases. The agent remains privileged.

Return to the panel. Wait for **Agent connected**, choose **Verify agent & setup**, and review every setup step. Retry failed core choices from **Cores → Server setup** after fixing the cause. Keep the connection dialog closed if desired; the agent continues. Delete the installer after pairing.

If pairing expires, use **Renew private installer** while the dialog is open, or **Servers → Repair agent pairing** later. Run the newly downloaded installer on the same VPS. It checks authenticated reachability, verifies the existing enrollment ID, preserves the generated node token/cores/configuration and restarts the agent. It refuses an unrelated installation. Reissue invalidates the previous installer secret; download again. A lost node identity cannot be silently reassigned to another machine; use a new target and a reviewed restore/cutover.

Set optional Worker variable AGENT_POLL_SECONDS to 1–10 for your latency/request-budget preference; the default is 3. Direct mode polls for commands every three seconds when idle and immediately drains additional work after each result. A command normally responds within one polling interval plus execution/network time. Offline agents fail clearly; claimed actions are not blindly retried. This is not a zero-latency transport. Each idle server makes approximately 28,800 channel requests/day, plus D1 reads/writes and work requests; choose a Cloudflare plan for your fleet. No unlimited/free fleet claim is made.

**Alternative paths:** HTTPS agent mode can use your trusted reverse proxy/Cloudflare Tunnel. Automatic SSH setup requires your **own** authenticated HTTPS relay running `relay/server.mjs`; Worker SSH currently uses that transport. A standard Worker cannot receive the agent on an arbitrary inbound TCP port or carry every VPN protocol. Direct mode removes the relay requirement from normal operation.

The outbound channel accepts JSON commands/results up to about 700 KB; the agent bounds generated result envelopes to 650 KB. Very large whole-profile/list responses need a protected HTTPS agent or smaller profiles. The Worker saved-configuration backup remains available independently. This mode is not an unlimited bulk transport. Capacity-test your intended customer count.

## 3. Create usable access

1. On **Cores**, read each core's **Capabilities & limitations**. Detection, provisioning, accounting and shop delivery are different capabilities. sing-box and standalone Hysteria 2 stay unavailable for native provisioning.
2. Create an inbound on an installed core. Set the actual public host and port, TLS/REALITY where appropriate and a compatible client transport. Apply the saved batch and confirm the applied revision.
3. Open the selected listener in both the provider firewall and the host firewall. VPN cores may also need TUN, forwarding and NAT; these are explicit host settings.
4. Create a client with supported limits. Use **Share** for profiles, QR and private Worker subscription links. Unsupported native formats are not generated.
5. On a separate real client/network, import the profile, browse through it, verify counters, expiry and disable/re-enable behavior. Do not interpret agent health or a running service as VPN acceptance.

Native weighted quotas and first-use expiry cover the implemented measured Xray proxy protocols and native WireGuard. OpenVPN, ocserv and SSH have fixed expiry but no per-user traffic quota/first-use metering adapter. MasterDnsVPN standalone is unmetered; the optional private VLESS backend meters authenticated **inner payload**, excluding DNS overhead and retransmissions. Read `docs/masterdnsvpn-shared.md` before using it. Native IP/HWID limits are unavailable.

## 4. Domains and subscriptions

The public HTTPS Worker URL is the default panel/subscription address. Customer subscription URLs are private access credentials; test the actual intended app format before distributing them.

**Manual VPS hostname:** create a DNS-only A/AAAA record pointing to its public IP, then set that hostname as the inbound public host. Ordinary Cloudflare HTTP proxying does not proxy arbitrary SSH/UDP/WireGuard traffic.

**Manual Worker domain:** Cloudflare → Workers & Pages → BenX Worker → Settings → Domains & Routes → Add custom domain. Use an unused hostname in an active zone. Wait for HTTPS, verify sign-in and a private subscription before moving customers. Adding a Worker domain does not rewrite existing subscription links, agent origins or server addresses. Keep old origins alive during migration.

**Optional panel-assisted setup:** set `CF_ACCOUNT_ID` and `CF_WORKER_NAME` as Worker variables, and `CF_API_TOKEN` as a Worker secret. The token needs Zone Read, DNS Edit and Workers Scripts Write for the intended account/zones. **Domains & Worker** loads available active zones, previews an exact A/AAAA record or Worker-domain mapping and signs that preview for five minutes. Apply revalidates the account/zone and refuses conflicting DNS or another Worker service. Only the owner can use it. Never put the token in browser storage or a repository. API confirmation is not propagation/TLS/client verification.

**MasterDNS:** create a dedicated DNS-only nameserver A/AAAA, an NS delegation for the chosen subdomain, and permit the listener, normally UDP 53. A VPS A/AAAA record alone does not delegate DNS. This specialized setup remains operator-reviewed.

## 5. Pair servers through a tunnel

Use two connected native servers with current agents. Enter the actual public endpoint addresses; the outbound agent ID is not a VPN address. Choose WireGuard for a UDP private link, SSH direct/reverse for limited TCP forwarding, or FRP TLS/WSS for reverse forwarding over TCP. Required tools install automatically on both endpoints; first installation may take several retries and minutes.

Use a distinct port and unused private /30 subnet. The receiver is committed first; partial failures attempt cleanup and retain retryable status. **Configured** means service configuration succeeded. Check status/handshake and use **Compare tunnels** for bounded traffic measurements, then test your actual service. SSH running-state checks do not prove the forwarded destination accepts traffic. Forwarding listeners bind to loopback; explicitly connect routing/public listeners when needed. No global default route, firewall or NAT change is silently applied.

GRE/IPIP, unencrypted Backhaul and experimental Phormal/Hedioum recipes are retired from **new** setup and comparisons. Their existing records/adapters remain so operators can inspect, migrate and clean up historical deployments.

## 6. Shops and resellers

Create Services, assign supported inbounds and quota policy, then configure Team & Resellers and the Telegram shop. Automatic native shop delivery is limited to the supported VLESS, VMess, Trojan and Shadowsocks products; other cores remain manual profile workflows. All advertised restrictions must be enforceable by that adapter.

Use a staging bot and conduct a real buyer checkout, duplicate-payment handling, delivery retry, customer retrieval, quota/expiry and refund test. Card receipts require a human bank-deposit check. A mocked provider response is not a live payment test. The `/telegram/webhook` route needs public reachability and its own webhook-secret authentication.

## 7. Back up, migrate and restore

- Export each portable saved configuration from **Backup & restore**. Treat credentials, PKI and profile exports as private.
- Export **the entire D1 database**, including `owner_account`, and download **My account → Private recovery information**. It retains the original encryption/session seeds; it does not replace a database backup or contain your current login password. Also retain required Worker variables and optional integration secrets. Saved profiles alone do not include orders, staff, subscription identity or every account-wide table.
- D1 contains pairing identities and encrypted pending command data. Back up its new agent tables too. Never restore an old database with active nodes/jobs still writing: pause the shop, disable connections, snapshot current state, restore into staging and review queues before re-enabling.
- Import existing 3X-UI through its separate compatibility workspace. API-exportable data can be migrated between compatible panel versions. This does **not** convert arbitrary panel databases into native BenX listeners. Other panel import adapters are unavailable.
- Existing native replacement/standby workflows preserve supported saved profiles and credentials. Automatic replacement still uses SSH setup; outbound-agent reassignment/cutover to an existing logical server ID is not implemented. For a fresh outbound target, use portable export/import and manually verify DNS/customer identity implications before cutover. Do not claim subscription continuity for a newly created logical server.
- Test recovery on a spare VPS. Verify client credentials, accounting checkpoint, certificates, DNS, subscription identity and tunnel endpoints before retiring the old host. Recovery is not an OS image, firewall clone or complete host backup. Usage since the last confirmed checkpoint on a lost VPS cannot be recovered.

## 8. Prepare GitHub without publishing

Run `npm run release:check`, then `npm run release:package`. The latter creates a clean allowlisted source folder and ZIP under `test-results/release/` with SHA-256 sums and sanitized Cloudflare defaults. It excludes private runtime files, live scripts, account IDs, original font binaries, local caches and deployment state. Review `SOURCE-KIT.txt` and the archive before creating any repository.

The included GitHub workflow runs tests/build/package; it never deploys. No repository, remote, commit, push, release or deployment is created by source packaging. For later publication, initialize Git **inside the clean source folder**, inspect the file list and create the repository only when explicitly requested. Attach its actual URL with `npm run release:repository -- <actual-public-repository-url>`, then commit that change. The official Deploy button can then install into each user's own Cloudflare account. GPL-3.0 and upstream notices remain; review third-party asset licenses before redistribution.
