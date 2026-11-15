# Team, customer pages and Testing Lab

## AI defaults

The built-in economy defaults were checked against the providers' official documentation on 2026-10-03:

| Provider | Default | Standard price per million input/output tokens |
| --- | --- | --- |
| Gemini | `gemini-3.5-flash-lite` | Free tier where eligible; paid $0.30 / $2.50 |
| OpenAI | `gpt-6-luna` | $0.10 / $0.50; API billing required |

The assistant also suggests Gemini 3.8 Flash and GPT-6.1 Sol. Custom model IDs remain editable. Only the former built-in defaults, Gemini 2.5 Flash and GPT-4.1 Mini, map to the new defaults; other saved selections are preserved. Provider calls require a valid operator key and eligible account. Availability, quotas and prices can change.

Sources: [Gemini pricing](https://ai.google.dev/gemini-api/docs/pricing), [Gemini Flash-Lite](https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash-lite), [OpenAI pricing](https://developers.openai.com/api/docs/pricing), [GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna).

## Team & Resellers

The owner creates **reseller**, **customer manager** or **server administrator** accounts. Resellers and customer managers see only customers they created, with owner-assigned inbound access, permissions and caps. They cannot open the server administration API by entering its URL. Server administrators manage clients and configurations on all saved servers (including future connections), or a selected server list. Connections, SSH bootstrap, replacement, team accounts, store credentials and AI keys remain owner-only.

Each account has an independent entry: `/resellers/<account UUID>` or `/admins/<account UUID>`. Use **Sign-in address** on its account card. The owner uses a persistent random `/owner/<opaque ID>` address. A generic `/sign-in` allows credential-based initial entry and redirects to the account's canonical address; it does not reveal the owner's path to anonymous visitors or members. Separate HttpOnly cookies and workspace-bound sessions prevent an account from using another role's entry. Scope/version changes revoke existing sessions. These are path-based workspaces; custom subdomain DNS is not configured by this change.

The anonymous production site shows a sign-in page, with no root dashboard. Localhost retains an owner UI preview for development. The private owner path is an additional separation measure; role and server permissions enforce access even if someone knows a URL.

- Account limits: customer count, GB per customer, duration, allocated quota, cumulative consumed traffic, IPs and devices per customer. Zero means unlimited.
- Permissions: create, edit/renew, delete and share customers.
- Customers: English/Persian names, granted inbound selection, enable/disable, explicit expiry renewal, traffic reset, app links/QR and online filters. Online status remains unknown when the server cannot provide verified results.
- IP/HWID viewing and clearing requires a supporting 3X-UI panel. Native cores reject nonzero IP/HWID limits because enforcement is not implemented.
- Archiving revokes sign-in, queues customer pauses and retains records/consumption. Review an archived account and save it to restore; enable it deliberately. Permission/password changes invalidate existing sessions.

Passwords use salted PBKDF2 hashes. A member session includes the account version and is checked against D1 on each API request. Customer writes reserve quota and commit the desired server profile in the same guarded D1 transaction, including allocations across different servers. Existing customer identities cannot be replaced through member input.

Owner edits in Clients are reflected in the member ledger during reconciliation. Removing or replacing a customer identity in the saved profile releases its allocation without refunding cumulative consumption. Allocation is issued quota. Cumulative consumption uses verified counter deltas, preferably unweighted raw bytes when the adapter provides them. Customer cards show current quota counters, which can include traffic multipliers. Reset and deletion do not refund account consumption. Traffic resets serialize against team polls. A consumed cap disables member subscriptions immediately after it is recorded and queues desired-state customer pauses on the server. Existing connections are stopped only after the server applies the revision.

Polling is bounded to 50 oldest customer checkpoints per pass, four at a time. Large accounts take several passes. Offline usage is unknown, and caps can overshoot between observations. This is periodic accounting, not a real-time billing meter. Direct counter resets outside this portal and usage after an unavailable VPS's last checkpoint cannot be reconstructed exactly.

## Subscription page templates

Open Subscriptions to select **Gaming, Nature, Tech or Candy**. The first visit to a server without a saved page design prompts selection. Customize title, subtitle, accent color, support HTTPS link and English/Persian language; preview before saving. Each logical server keeps its own versioned design in D1. Demo designs use a separate local preview setting and never store credentials.

**Subscriptions → Announcements** lets you add up to eight title/message notices, enable or disable each, and preview them on the customer page. Notices use the server’s selected theme and language; plaintext is escaped, and saving checks the current design version to preserve concurrent edits.

Create ordinary Worker subscription access, then share **Designed customer page** from Clients, Subscriptions or a member's customer links. The URL is `/sub/<secret>/page`; app URLs remain V2Ray, V2Box, Happ, sing-box and Clash. The page reads actual customer identity, usage, allowance and expiry. Only owner-enabled, service-allowed formats appear. Expired/depleted customers see renewal information. Rotated identities, revoked access and account restrictions also affect the page. Copy buttons have a manual-copy fallback.

Design text is escaped, colors are validated, support URLs must be HTTPS and scripts/styles use nonce-based CSP. A subscription URL is a bearer credential; keep it private. Transport support varies by app, and converters reject unsupported settings rather than inventing a working connection.

## Testing Lab

1. Connect a dedicated fresh VPS with full access and the native Xray adapter. Existing 3X-UI panel connections are currently outside this Lab deployment adapter.
2. Name an experiment, choose a budget from 1 to 1000, and select balanced coverage, all selected combinations capped by the budget, or a JSON list of inbound recipes.
3. Choose VLESS, VMess, Trojan, Shadowsocks, HTTP and/or SOCKS; RAW/TCP, mKCP, WebSocket, gRPC, HTTPUpgrade and/or XHTTP; compatible plain/TLS/REALITY modes. Supply REALITY SNI targets. Tick uTLS fingerprints, XHTTP modes/padding profiles, path/service presets and Shadowsocks ciphers. Custom HTTP paths and gRPC names are optional; REALITY SNI targets remain editable hostname lists. Fixed-value choices are also validated by the backend. TLS needs an actual certificate hostname and paths on the VPS.
4. Set the public proxy IP/domain, starting port, temporary duration (1–168 hours) and quota per test identity. Preview the compatible matrix, review coverage and deploy.
5. Follow synchronization. The generated subscription appears only after the applied revision is confirmed and experiment resources remain intact. Copy it to BenX-Tester and download the manifest.
6. Import tester results, compare reachability/latency/download/loss, then clean up the experiment.

HTTP/SOCKS test listeners use password authentication over RAW/TCP, with optional TLS and mandatory experiment expiry. Per-user traffic accounting is unavailable on these protocols, so generated identities have no traffic cap; the Lab explicitly labels that limit. Exported usernames match the agent’s deterministic account names. Empty/disabled identities stop their listeners, and compiled fallback credentials prevent an accidental open proxy. URI import support varies by app; sing-box rejects SOCKS with TLS because its [SOCKS outbound schema](https://sing-box.sagernet.org/configuration/outbound/socks/) does not include TLS; sing-box, Clash and Xray credential conversions are covered locally.

The uTLS presets follow [Xray’s preset table](https://github.com/XTLS/Xray-core/blob/main/transport/internet/tls/tls.go). HTTP/SOCKS settings follow the upstream [HTTP](https://github.com/XTLS/Xray-core/blob/main/proxy/http/config.proto) and [SOCKS](https://github.com/XTLS/Xray-core/blob/main/proxy/socks/config.proto) schemas.

Balanced sampling covers method families before additional combinations. Public plain VLESS/Trojan and incompatible REALITY transports are excluded. Xray SS2022 multi-user tests support AES-128/AES-256, not SS2022 ChaCha20. Recipe input must omit clients; BenX generates new credentials, ports and REALITY keys. Legacy Shadowsocks clients inherit their listener's cipher in the agent. See [Xray Shadowsocks](https://xtls.github.io/en/config/inbounds/shadowsocks.html) and [transport documentation](https://xtls.github.io/en/config/transport.html).

Experiments are saved as encrypted desired profiles and use the existing reconciliation, history and recovery pipeline. Ports already used by the saved profile are skipped; unrelated system listeners and provider firewall rules still need operator attention. The current agent runs one Xray service per listener. Budget according to VPS memory, file descriptors and the managed profile's 1000-inbound / 700-KB limits; 1000 is a ceiling, not a recommended batch size.

The public Lab subscription includes active temporary identities and requires an enabled server with confirmed deployment. Cleanup refuses edited resources, unrelated customer/service attachments or active team grants. Removing an experiment revokes its subscription immediately; stopping VPS listeners still follows synchronization.

The separate BenX-Tester is not implemented by this section. Measurements are imported, explicitly labeled as such, and apply to the tester's location/network/time. Generated configurations are not proof of reachability, speed, DPI resistance or availability inside Iran. OpenVPN/SSH/WireGuard use their own clients and are outside the V2Ray subscription matrix. Shadowsocks transport extensions and mKCP require compatible testers/apps.

Example report, using the exact variant keys from the manifest:

```json
{
  "measuredAt": "2026-10-03T00:00:00Z",
  "results": [
    {
      "key": "copy-the-exact-manifest-key",
      "reachable": true,
      "latencyMs": 180,
      "downloadMbps": 25,
      "lossPercent": 1
    }
  ]
}
```

Reports reject unrelated/duplicate keys, negative/nonfinite measurements and loss above 100%. Optional measurements can be omitted; no scores are filled with fabricated data.

## Installation and checks

Apply migrations `0017_team_pages_lab.sql` , `0018_team_archive.sql` and `0019_workspaces.sql` before serving this version. For local development run `npm run db:local`; a real deployment needs the corresponding remote migration and existing secrets. Backups must include team ledgers, page designs, experiments, managed histories and the original encryption key.

Local coverage includes scoped sessions/API isolation, cross-account access denial, cross-server quota races, archive/restore, reset accounting, real key generation, matrix bounds, experiment readiness/cleanup, report validation, template concurrency, HTML/CSP safety and the existing management adapters. Live VPS provisioning, real customer traffic and paid/free provider inference require operator credentials and remain separate verification steps.
