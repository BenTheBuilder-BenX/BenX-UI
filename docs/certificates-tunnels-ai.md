# Certificates, tunnels and AI

These features require migration 0016. Certificates and tunnel tests require agent 0.6 on full-access servers. Existing panel-only workspaces retain their panel API tools.

## Certificates

Server onboarding and **Cores → Server setup** offer Domain, Public IP or Both. Both requests two certificates. Certificate/key paths are recorded in the server checkpoint and displayed in Server setup. The inbound TLS editor can select an available certificate; remembered paths from an old VPS are not presented as available files.

The agent uses Certbot standalone HTTP validation. Port 80 must be reachable and free; domain DNS must point directly to the VPS. Existing web servers are not stopped. Public IPv4/IPv6 ownership is validated by ACME. Older distribution Certbot builds use an isolated, pinned Certbot 5.3.0 environment for IP issuance. BenX owns a renewal timer that runs four times daily and renews only its recorded certificate names. Retirement disables that timer on the old VPS.

[Let's Encrypt IP certificates are short-lived, about six days](https://letsencrypt.org/2026/01/15/6day-and-ip-general-availability). [Certbot supports IP issuance](https://letsencrypt.org/2026/03/11/shorter-certs-certbot). Successful issuance, renewal and IPv6 validation still need verification on real Linux servers.

Replacement keeps portable TLS material working before domain DNS cutover. A combined request can issue the new IP certificate while domain renewal stays pending. After DNS cutover, apply Server setup to issue the domain certificate on the replacement. Original paths remain recorded; no arbitrary exported file is written to an unrelated destination path.

## Tunnels and comparisons

The Tunneling page offers nine adapters:

| Method | Connection | Requirements |
| --- | --- | --- |
| WireGuard | Encrypted private /30 | UDP on the chosen link port |
| SSH direct/reverse | Loopback TCP forwarding | TCP, dedicated restricted SSH account, pinned host key |
| GRE / IPIP | Kernel private /30 | Literal IPv4 endpoints, IP protocol 47 / 4; payload is unencrypted |
| FRP TLS / WSS | Authenticated reverse TCP forwarding | TCP, paired CA verification |
| Phormal Relay | Hysteria 2 with Salamander | UDP, paired CA verification |
| Hedioum | Adaptive pool with SSH/TLS mimicry and private SOCKS | TCP, experimental adapter; optional domain for upstream ACME |

Missing distribution tools are installed automatically. Other engines use fixed official release URLs and SHA-256 verification: FRP 0.71.0, Hysteria 2.12.3 and Hedioum 0.11.0, for x86-64/ARM64. Phormal uses its [Relay recipe](https://github.com/Schmi7zz/Phormal), rather than executing the entire interactive script. Hedioum receives a separate service mount for its hard-coded config directory; the adapter does not move the management SSH port. Sources: [Hedioum](https://github.com/hedioum/Hedioum-Pool-Tunnel), [FRP TLS/WSS](https://gofrp.org/en/docs/features/common/network/network/), [Hysteria configuration](https://v2.hysteria.network/docs/advanced/Full-Client-Config/).

Speed/DPI scores and endpoint exposure are engineering estimates, with confidence labels. They are not measured Iran access or detection probabilities. All methods retain visible server IPs. Private links leave default routes, NAT and provider firewalls unchanged; forwarding binds to loopback.

**Compare tunnels** installs temporary paired endpoints, measures authenticated TCP reachability, latency/jitter, probe failure rate and acknowledged upload/received download. Samples use 2, 8 or 16 MiB per direction, with a ten-second measurement ceiling. Large samples on slow paths may time out; failure cannot establish DPI as the cause. Hedioum requires a temporary authenticated public target probe on link port +2/TCP because upstream restricts private-IP egress. No external speed-test service is used.

Test identities and encrypted original connections are saved before remote setup. Cleanup retries against those original endpoints after interruption. A comparison awaiting offline cleanup does not prevent VPS replacement; its record remains until cleanup is confirmed. It prevents deleting its logical server or starting another overlapping comparison. Results apply only to the selected VPS pair at that time. Real Linux tunnel deployment and Iran-specific reachability remain unverified.

## AI help

The header's **AI help** accepts Gemini or OpenAI API keys, encrypted in D1. Keys are never returned by the settings API or stored in browser storage. The setup screen links to official key guides and pricing: [Gemini keys](https://ai.google.dev/gemini-api/docs/api-key), [Gemini free tiers](https://ai.google.dev/gemini-api/docs/pricing), [OpenAI quickstart](https://developers.openai.com/api/docs/quickstart).

The provider receives the user's message and a limited selected-server summary: server name, mode, revision, cores and inbound names/protocols/ports. Saved SSH credentials, private keys and client credentials are excluded. Anything pasted into a message is sent to the provider. Availability, billing and free-tier data use depend on the selected provider/account.

English/Persian help can propose creating clients/inbounds and attaching clients. The operator reviews each draft before saving it. Only the stored proposal can be applied; stale/expired proposals and concurrent profile changes are rejected. Applying it saves a versioned desired configuration and queues normal server reconciliation. It does not claim a live VPS write succeeded immediately. The assistant cannot execute shell commands, delete configurations or process payments. Provider calls have bounded responses, timeouts and rate limits; no live provider call has been made during local validation.
