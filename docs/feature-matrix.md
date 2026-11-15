# Feature coverage

“Remote” means that an action reaches the selected panel over HTTPS. Native enforcement happens there, not in the Worker. “Console” means the feature is exposed through versioned request/response forms; it does not imply a duplicate of every upstream visual wizard.

| Feature | BenX-UI interface | 3.x | 2.8 family |
| --- | --- | --- | --- |
| Multiple independent panels | Server connection manager and selector | Remote | Remote |
| CPU/RAM/swap/disk/network/sockets/uptime | Overview and collected charts | Remote | Remote |
| Persisted monitoring | Worker cron, D1 health API | Included | Included |
| Inbound CRUD, enable, cloning, quota, expiry | Dedicated tables and editor | Remote | Remote |
| VLESS, VMess, Trojan, Shadowsocks | Current upstream protocol option forms plus full JSON | Remote | Remote |
| WireGuard, AmneziaWG, Hysteria2, TUIC, MTProto, HTTP, SOCKS, Mixed, Tunnel, TUN | Protocol selection, current upstream field forms, and full JSON configuration | Release-dependent | Release-dependent |
| TCP/Raw, mKCP, WS, gRPC, HTTPUpgrade, XHTTP | Transport option forms and full JSON | Remote | Remote |
| TLS/REALITY, fallbacks, sniffing, socket options | Dedicated protocol, transport/security, sniffing and advanced option forms; full JSON retained | Remote | Remote |
| 3X-style inbound editor and certificate/key helpers | Six familiar tabs, no presets, unused ports, X25519 generation, TLS certificate reuse, protocol/security forms and JSON | Included | Included; certificate lookup through panel settings |
| ECH and PQ tools | API console | Release-dependent | Reviewed endpoints only |
| Clients, UUIDs/passwords, enabled state, quotas, expiry, IP limits | Dedicated editor/table | Remote | Remote |
| Client attachment to multiple inbounds | Creation and editing forms with inbound attach/detach | Remote | Add per inbound |
| HWID limits, renewal, advanced client options | Credentials, Renewal, External links, HWID and JSON tabs; API tools | Remote | Release-dependent |
| Online status, IP records, traffic resets | Client screens | Remote | Remote |
| Bulk client changes/import/export | UI reset/delete; remaining native bulk tools in console | Remote | UI loop for reset/delete, native subset in console |
| Sharing and QR | Native link generation on 3.x; local common-protocol link builder on 2.x | Remote | Common protocols |
| Raw/JSON/Clash subscription URLs | Subscription screen using actual configured URLs | Remote delivery | Remote delivery |
| Subscription templates, HWID negotiation, app detection, subscription balancers | Settings JSON and console | Remote | Release-dependent settings |
| Nodes, cloning/sync/probes/mTLS/history | Native resource screen and API tools | Remote | Not exposed in reviewed legacy API |
| Hosts and client groups | Native resource screen and API tools | Remote | Not exposed in reviewed legacy API |
| Outbound CRUD and routing | Draft editors plus complete Xray JSON | Remote | Remote |
| DNS, policy, logging, balancers, proxy chaining | Complete Xray config editor | Remote | Remote |
| WARP/NordVPN/PIA, outbound subscriptions/tests/stats | API console | Remote | Reviewed subset including WARP |
| Geodata, route tests, observatory, Xray metrics | API console | Remote | Reviewed subset |
| Xray restart/stop/version installation/geodata updates | Toolbar and console | Remote | Remote |
| Panel updates/restart/account changes/scoped tokens | API console | Release-dependent | Reviewed subset |
| Telegram/Discord/SMTP/LDAP | Dynamic settings and console | Release-dependent | Exposed settings only |
| Telegram sale bot | Personalized storefront, service products, Stars checkout, seller-reviewed toman/rial transfers, encrypted credentials, durable paid orders, private app subscriptions, retry/refund | Automatic common-protocol delivery | Not supported for store delivery |
| Panel/Xray/system logs | Dedicated log viewer | Remote | Remote |
| Database download/restore | Dedicated screen, streamed downloads, uploads capped at 20 MB | DB and native dump; host settings preserved | SQLite backup |
| PostgreSQL-backed panel operations | Forwarded through native API; migration download/restore through console | Remote | Panel-dependent |
| BenX-UI administrator login, encrypted storage, rate limiting, audit | Worker/D1 | Included | Included |
| Dark/light themes and responsive UI | BenX-UI UI | Included | Included |
| Every upstream localized UI / PWA / upstream visual wizard | Not replicated in this first version | Not included | Not included |
| Xray executable, sidecars, packet processing, Linux services, Fail2ban firewall enforcement | Stay on remote host | Managed through exposed API | Managed through exposed API |
| Full-access server agent | Included Python/Linux companion; separate server mode | Independent native adapters | Independent native adapters |

## Full-access server mode

The native-first Cloudflare panel connects to the included privileged Linux agent through outbound HTTPS, protected HTTPS origin, or configured private SSH relay. See [launch guide](launch-guide.md) for setup and unverified acceptance. This mode has its own capabilities and limits:

| Feature | Coverage |
| --- | --- |
| Core installation | Pinned checksum-verified Xray and DNS resolver; OpenVPN, ocserv/OpenCisco, OpenSSH, native WireGuard through Debian/Ubuntu packages; official pinned MasterDnsVPN release with SHA-256 verification |
| Xray | Pinned official installation or existing binary; VLESS, VMess, Trojan, Shadowsocks, HTTP, SOCKS, Tunnel and implemented Xray Hysteria/WireGuard native listeners |
| sing-box / Hysteria 2 | Existing binary detection; installation and provisioning unavailable |
| Inbounds and clients | CRUD, enabled state, multi-inbound attachments, protocol options, fixed expiry, isolated listener units |
| Credentials and exports | OpenVPN certificates/.ovpn, SSH accounts/host key, ocserv accounts/certificate fingerprint, WireGuard keys/.conf, MasterDnsVPN encryption key/JSON profile |
| MasterDnsVPN | Standalone unmetered DNS tunnel, or shared authenticated loopback VLESS backend with inner-payload metering. DNS overhead/retransmissions and independent outer-key revocation are not measured/supported |
| Quotas | Weighted native client quotas for VLESS/VMess/Trojan/Shadowsocks/WireGuard; other cores reject quotas |
| First-use expiry | Measured Xray/native WireGuard and supported metered MasterDNS backend only; starts on actual traffic |
| IP/HWID limits and scheduled renewal | Native enforcement unavailable; unsupported writes rejected |
| Traffic and online accounting | Persistent raw/weighted per-client counters; online presence remains unavailable |
| Subscription delivery | Worker-issued standard/V2Box/Happ lists and sing-box/Clash objects; unsupported proxy transports fail explicitly; native VPN profiles in Share |
| Configuration export | Portable desired-state profiles, credentials/managed PKI, usage checkpoints and native restore/standby workflows. Not a full OS/network image. Outbound logical-ID replacement remains unavailable |
| Global Xray settings | Native outbounds/routing/DNS/logging and HTTP outbound probes; managed listeners/stats remain isolated |
| Panel settings and other advanced tools | Panel connection required |
| Services and traffic multipliers | Per-server plans and revisions; weighted enforcement on supported native listeners only |
| Tunneling | Curated WireGuard, SSH direct/reverse and FRP TLS/WSS automatic pairing/tool installation. Separate running/handshake/payload status. Legacy methods remain for existing-record cleanup |
| Provider locations | Public VPNJantit directory, official guides, private imports, test-before-apply; NordVPN/PIA via panel API |
| Firewall, forwarding and NAT | Host administrator configuration required |

## Validation boundaries

Validated: TypeScript and lint checks; Worker bundle/deployment dry run; local Worker with real D1 migrations and persistence; credential encryption/tamper rejection; JWT verification and password rotation; origin checks; private address/DNS rejection; allowlist coverage; credential forwarding, cookie/CSRF adapters, redirects, legacy forms; core UI flows using demo data; native adapter output, rollback, input constraints, fixed-service isolation and download integrity with mocked Linux commands.

Not validated: a real Telegram bot/Stars checkout/card-transfer receipt flow, a real 3X-UI panel, every remote API operation against every installed release, Cloudflare deployment with an actual account, packet transport or quota enforcement on a real Xray process, real Linux package installation, systemd lifecycle, native VPN client connectivity, and full upstream UI parity. No such live services or credentials were supplied. Telegram store payment, replay, customer isolation, delivery recovery, refund revocation, signed webhook and revision checks use a real in-memory SQLite schema with mocked external APIs.

The API snapshot was captured on 2026-10-01 from the public upstream main branch and the v2.8.10 route definitions. Future upstream changes require review before updating the allowlist.
