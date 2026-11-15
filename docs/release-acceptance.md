# Release acceptance · 0.9 source candidate

Local checks and real acceptance have different meanings. There is no automatic “production ready” badge. Complete the checks below against an isolated Worker and spare VPSs before release.

| Check | Required evidence |
| --- | --- |
| Reproducible source | `npm ci`, release checks and sanitized source kit from a clean folder; no runtime secrets or supplied unlicensed fonts |
| Direct installation | Actual public-repository Deploy button; fresh Cloudflare Free/Paid accounts, default build authorization, automatic D1 binding/schema, private activation link, no manual secret prompts |
| Installation interruption | Stop/overlap initial builds; only one first-install claim wins, no competing encryption key is uploaded; explicit stopped-run resume and lost activation/recovery links |
| Account | Generated owner login, username/password-only sign-in, old seed login disabled, current-password changes, session revocation, staff isolation, one-use recovery and private recovery download |
| Database upgrade | Automatic migrations through 0025 applied to a copy of existing D1; atomic interruption/resume, Free-plan query budget, preserve original keys/login and verify old connections/orders |
| Pairing | Supported OS/architecture, valid HTTPS/NTP, expired/wrong/replayed token rejection, distinct identities cannot take over |
| Install | Reachability failure changes no host files; each selected core installs; interrupted base/core installation has a documented recovery path |
| Agent outage | Stop/restart the agent and interrupt HTTPS; saved commands expire safely, claimed actions are not replayed and results drain after reconnect |
| Worker restart | Queued requests and reconciliation survive isolate replacement; late results do not overwrite unrelated jobs |
| Native protocols | Separate real client acceptance for every advertised core/protocol/transport; certificates/REALITY, disable, expiry, quota/reset and restart |
| MasterDNS | Standalone is explicitly unmetered; shared backend enforces each UUID, expiry/revocation and measured inner-payload quota; overhead is excluded |
| Tunnels | Both directions, handshake/payload, reboot/reconnect, port collision, occupied subnet, partial install and cleanup with one endpoint offline |
| DNS | Scoped token, wrong account/zone, conflicting names, exact preview expiry/tamper, IPv4/IPv6, DNS-only, Worker TLS and manual setup |
| Subscriptions | All supported apps, revoked/rotated/deleted identities, custom host proof, stale/changed Worker origin and account isolation |
| Shop | Actual payment amount/currency/buyer validation, duplicate update, delivery timeout, retry/refund, disabled customer and reseller scope |
| Restore | Export/import on spare VPS, credentials/PKI, D1 restore plus encryption key, subscription identity, usage checkpoint and DNS cutover |
| Browser | Desktop, narrow screen, mobile and Persian RTL; sign-in, errors, keyboard access and disabled unsupported options |
| Capacity | Measure actual fleet requests, D1 operations, memory/CPU, queue age and remote action timeouts at expected concurrency |

Outbound mode is new in this candidate and is not VPS-accepted merely because unit tests pass. It uses three-second idle polling and a 25-second response deadline; a slow or claimed command can have an uncertain outcome. Check actual state before retrying. It does not promise exactly-once distributed execution or zero latency.

Known incomplete capabilities: standalone sing-box/Hysteria 2 provisioning; general native IP/HWID enforcement; native first-use/quota enforcement for unmetered cores; arbitrary third-party panel import; automatic outbound logical-ID replacement; automatic MasterDNS delegation; full OS/network cloning. These must stay explicit rather than appearing as completed features.
