# Panel and platform research · 28 October 2026

Primary project documentation informed the native-first workflow. “Nexura” was interpreted as Nexora VPN; if a different project was intended its identity still needs confirmation. This is a design comparison, not a claim of complete parity or copied implementation.

| Reference | Useful baseline | BenX scope/decision |
| --- | --- | --- |
| [3X-UI](https://github.com/3x-ui/3x-ui) | Inbounds, centralized customers, quota/expiry, node/API, QR/subscriptions, backup | Keep compatibility import and native customer workflows; unsupported upstream-only operations remain explicit |
| [Nexora VPN](https://github.com/Nexora-VPN/panel) | Separate control/node roles, managed onboarding/migration, reseller plans, backups and rollback | Native agent is the default; per-agent enrollment and durable command outcomes; no proprietary code copied |
| [Marzban](https://gozargah.github.io/marzban/en/docs/introduction) | User/account lifecycle, multiple nodes and subscription delivery | Keep services/customer setup separate from low-level core controls |
| [Remnawave](https://docs.rw/) | Explicit panel/node roles and connection prerequisites | Agent connectivity and configured services do not imply client connectivity |

Protocol evidence matters more than a core logo. [MasterDnsVPN](https://github.com/masterking32/MasterDnsVPN) exposes a shared outer encryption identity; its [simple configuration](https://raw.githubusercontent.com/masterking32/MasterDnsVPN/main/server_config.toml.simple) does not establish an independent per-customer quota API. BenX's private VLESS backend is the accounting/authentication boundary and counts inner payload only. Stock DNS-only mode must not advertise per-user metering.

[Hysteria 2 traffic API](https://v2.hysteria.network/docs/advanced/Traffic-Stats-API/) documents measurement and kick operations; a complete future adapter must also prevent reconnect after disable. [sing-box V2Ray API](https://sing-box.sagernet.org/configuration/experimental/v2ray-api/) is optional in builds. Detection alone does not prove provisioning or accounting; both standalone adapters stay disabled.

Cloudflare [TCP sockets](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/) support outbound TCP with destination restrictions. They do not provide a general inbound VPN service. A TCP connect/SSH handshake timing is not ICMP ping. This implementation's normal path is outbound agent HTTPS; automatic SSH still uses a configured private relay.

Domain setup follows the official [DNS record API](https://developers.cloudflare.com/api/resources/dns/subresources/records/methods/create/), [Worker domain API](https://developers.cloudflare.com/api/resources/workers/subresources/domains/methods/update/), [DNS proxy rules](https://developers.cloudflare.com/dns/proxy-status/) and [subdomain delegation guide](https://developers.cloudflare.com/dns/manage-dns-records/how-to/subdomains-outside-cloudflare/). VPS DNS, Worker hosting and authoritative DNS delegation remain different tasks. Same-account access requires correctly scoped credentials, and confirmation of an API write is not propagation or protocol acceptance.
