# Full-access server connection

## Native-first outbound enrollment · agent 0.8

Use **Connect your VPS → Direct agent connection**. The private installer verifies authenticated Worker HTTPS reachability before installation, then starts outbound polling from this loopback agent. No third-party panel or SSH relay is required for this mode. See [launch guide](../docs/launch-guide.md) for OS support, secret handling, limits, recovery and staging acceptance. Claimed actions are not blindly replayed; a private journal retains results until acknowledgement.


BenX-UI stays on a Cloudflare Worker. Privileged server operations run through this small management agent, rather than a Linux-hosted panel. Panel connections continue to use the original 3X-UI API. These are separate modes: the native agent does not import or modify an existing 3X-UI database or its services.

## Automatic setup from the panel (agent 0.4)

For a fresh VPS, use **Servers → Add server → Full access**. Supply the SSH password or private key for root or a passwordless-sudo user, check the host fingerprint against the provider console, choose features and click **Install & connect**. No downloaded script or user-run SSH command is needed. First-install recipes support Debian 12/13 and Ubuntu 24.04/26.04, x86-64/ARM64, public SSH and systemd. Domain DNS and provider firewalls still need to permit the selected listeners.

The Worker uses SSH for installation, then connects to the private agent through SSH TCP forwarding. Initial root credentials are not written to D1. A generated Ed25519 key is stored with AES-GCM encryption and added to authorized_keys with `restrict`, a fixed status-reading command and `permitopen="127.0.0.1:8095"`. It cannot request an arbitrary shell or forward to other destinations. The agent remains privileged and its token and this key must remain private. Every SSH handshake pins the verified host fingerprint. Hostnames are resolved through public DNS and the connection uses the verified public address.

The first install launches a server-side background script; recent base status and private logs remain on the VPS. Once the agent starts, chosen setup recipes run as a serialized job with persistent per-step status. Closing the browser does not stop installation. Reopen **Servers → Setup status**. If base packages fail, use **Retry base installation** and provide the original root login again. If an optional feature fails, the agent stays connected; retry the option in **Cores → Server setup**. After an agent restart, unfinished options are marked interrupted for explicit retry.

Feature recipes: pinned checksum-verified Xray; distro OpenVPN, ocserv, OpenSSH and WireGuard; pinned MasterDnsVPN; BBR detection/verification with rollback; Certbot standalone domain certificates and renewal timer; optional pinned 3X-UI 3.8.5. The upstream GPL installer is vendored at the commit in `3x-ui-release.json`, verified before use, and its noninteractive local-binding default is changed to loopback before execution. Existing 3X-UI installations/databases are rejected instead of updated. The optional panel has a separate database from BenX native listeners and stays private. Its API token stays in a root-only agent file; a managed panel workspace is added to the BenX server picker automatically. Requests are allowlisted in the Worker and again on the agent, then sent to fixed loopback port 2053. It does not share native clients or expose a public panel port. The private API bridge supports JSON/form operations and downloads up to 2 MB; multipart restore/upload remains unavailable through this bridge. Other panel/core installers need explicit adapters before appearing as supported options.

Certificates require direct DNS and a free, reachable port 80. Certbot never stops an existing web server. Issued paths are reusable via the inbound TLS certificate action; the renewal hook restarts only BenX Xray/ocserv units. BBR needs a compatible kernel and does not install a different kernel. VPN NAT, forwarding and firewall rules remain explicit network configuration. Tunnel pairing is available after connecting two servers through **Tunneling**; install the required tools on both endpoints through setup/Cores.

Run `node scripts/sync-agent.mjs` when building directly with Wrangler. Normal npm build/dev/check/test scripts refresh the Worker’s generated `agent-bundle.json` from agent sources. Apply migrations `0008_bootstrap.sql` and `0009_managed_panels.sql` before using automatic onboarding. SSH uses ECDH NIST curves, AES-CTR and SHA-2 MACs to match tested Worker crypto support; SSH daemons must permit these algorithms.

## Existing HTTPS agent setup

Requires Python 3.11+, systemd, and root privileges. Package installation recipes currently support Debian/Ubuntu systems with `apt-get`. Copy the agent files from this repository to the server:

```sh
sudo install -d -m 700 /opt/benx-agent /var/lib/benx-agent
sudo install -m 700 benx_agent.py /opt/benx-agent/benx_agent.py
sudo install -m 600 accounting.py tunnels.py setup.py /opt/benx-agent/
sudo install -m 600 masterdnsvpn-release.json masterdnsvpn-defaults.json xray-release.json 3x-ui-release.json 3x-ui-install.sh panel-operations.json /opt/benx-agent/
sudo install -m 644 benx-agent.service /etc/systemd/system/benx-agent.service
sudo sh -c 'umask 077; printf "BENX_AGENT_TOKEN=%s\n" "$(openssl rand -hex 32)" > /etc/benx-agent.env'
sudo systemctl daemon-reload
sudo systemctl enable --now benx-agent
```

Retrieve the token privately from `/etc/benx-agent.env`. The agent binds only to `127.0.0.1:8095`; keep it on loopback. Publish a management hostname using Cloudflare Tunnel with service-token Access protection, or a trusted HTTPS reverse proxy. For Tunnel, the origin service is `http://127.0.0.1:8095`. Preserve the request path and `Authorization` header. Use a dedicated hostname/root base path (for example `https://manage.example.com/`). Do not place the management token in the URL.

In BenX-UI: **Servers → Connect a server → Connect to server · full access**. Enter the HTTPS management URL and agent token. Enter the Cloudflare Access service-token credentials when applicable. Test the connection; Cores requires a successful agent capabilities response. The Worker encrypts the access credentials in D1.


## Implemented adapters

| Core | Installation | Inbounds and client provisioning |
| --- | --- | --- |
| Xray | Pinned official x86-64/ARM64 release with verified SHA-256, or retain an existing binary | VLESS, VMess, Trojan, Shadowsocks, HTTP, SOCKS, Tunnel; isolated, validated Xray configurations |
| OpenVPN | Distribution `openvpn` + `openssl` packages | TCP/UDP listener, private CA, server/client certificates, `.ovpn` exports, client revocation via listener restart |
| ocserv / OpenCisco | Distribution `ocserv` + `openssl` packages | OpenConnect/AnyConnect listener, private server certificate, individual password accounts, certificate fingerprint export |
| OpenSSH | Distribution `openssh-server` package | Separate SSH listeners and non-root client accounts, password credentials, TCP forwarding, no interactive shell |
| WireGuard | Distribution `wireguard-tools` package | Native interfaces, private/public/pre-shared keys, CIDR peers and `.conf` exports |
| sing-box / Hysteria 2 | Existing binary detection | Native provisioning adapter pending; installation buttons disabled |
| MasterDnsVPN | Pinned official Linux AMD64/ARM64/ARMv7 release; verified SHA-256 archive | DNS listener, domain delegation options, encrypted tunnel, standalone or shared authenticated private VLESS backend, JSON client profile export |

Each listener uses a `benx-<core>-<id>.service` unit. Existing Xray, SSH, OpenVPN and 3X-UI services are not restarted or edited. Package post-install service starts are suppressed when no existing `policy-rc.d` policy is present. Core Start/Stop/Restart actions affect only BenX listener units. Installation jobs are asynchronous and serialized; recent job history is in memory and resets on agent restart.

Set a **Public host** in native inbound Protocol options. This is the server's VPN address, not the management/Tunnel address. OpenVPN and ocserv profiles use a private CA; import the OpenVPN embedded CA, or verify/trust the exported ocserv certificate fingerprint. SSH exports include the dedicated host public key. Keep exported client profiles private.

Server firewall rules, IP forwarding, egress NAT, and routing are intentionally explicit administrator setup. The agent does not change global routing/firewall policies. VPN clients reach the VPN subnet; routing internet traffic through the VPN requires configuring forwarding/NAT on the host. WireGuard also requires a usable kernel WireGuard module and `/dev/net/tun` is required by OpenVPN/ocserv. Choose distinct VPN subnets/listener ports.

Native listeners support enabled/disabled clients and fixed expiry dates (reconciled every 30 seconds). Agent 0.3 adds weighted quota accounting for VLESS, VMess, Trojan, Shadowsocks and native WireGuard, sampled every 10 seconds. Xray uses a private loopback StatsService; WireGuard uses peer counters. Save older Xray listeners once to create the local stats API. The private accounting ledger preserves raw baselines and charged usage across agent restarts; changing a rate affects future deltas only. Depleted clients are removed from every attached listener and manual traffic reset is available. Polling permits a small overshoot; counter failures are reported in Clients and require operator attention. First-use expiry is supported for measured Xray protocols and native WireGuard, including supported metered MasterDNS backends. It starts on real traffic, not subscription download. Quotas and first-use activation on unmetered cores, IP/HWID limits and scheduled renewal remain unsupported.

Services and traffic policy are synchronized from the Worker; verify the agent policy revision before relying on new rates. Xray global outbounds, routing, DNS and logging can be edited without replacing managed inbounds or their private stats API. Individual native VPN/SSH/DNS profiles remain in Clients > Share. Worker subscriptions generate standard/V2Box/Happ proxy-link lists and native sing-box/Clash configuration objects for supported proxy transports. Set the actual public proxy host and REALITY public key on an inbound before sharing.

Tunneling supports WireGuard site-to-site and dedicated SSH direct/reverse forwarding. Both agents must be version 0.3 or later, with the selected core tools installed. Setup prepares separate private keys, exchanges public keys and commits the receiver before the initiator. Failures attempt cleanup on both endpoints; unreachable cleanup is recorded for retry. SSH pins the host key and exposes forwarding listeners only on loopback, using an isolated sshd/account on the target. WireGuard adds only the peer /32 route on the chosen private /30 link. Status checks distinguish a running service from a recent WireGuard handshake; SSH connection verification remains unavailable. These adapters have mocked tests, not live Linux/VPS validation.

MasterDnsVPN follows [masterking32/MasterDnsVPN](https://github.com/masterking32/MasterDnsVPN), pinned to `v2026.06.13.234407-7de2476`. Delegate your chosen domains to this server and allow its DNS listener through your firewall. Add domains in Protocol options and attach one enabled client to start the listener. Encryption modes 1–5 are accepted; modes 2–5 are preferred. the agent generates a private key and exports it in that client's JSON profile. Disabling or expiring the identity stops that DNS inbound. Upstream does not provide independent per-user quota/authentication on the outer shared listener. Standalone listeners are unmetered. The optional private VLESS backend supplies customer identities and counts inner payload only; DNS overhead and retransmissions are excluded. See [shared backend setup](../docs/masterdnsvpn-shared.md). Release updates require reviewing and replacing the checked-in manifest.

The agent has privileged server access. Its token belongs only in encrypted Worker storage and the root-readable environment file. There is no shell/terminal execution endpoint. Package names, core actions, and service names are fixed or generated internally. Agent-owned configuration and state files use private permissions. Configuration failures trigger restoration of previous managed files and listener configuration. Never point the agent data directory at an existing panel's files.

## Validation

Run `python -m unittest discover -s agent/tests -v` from the repository root. Unit tests mock Linux commands and validate adapter output, authentication/input constraints, core installation recipes and managed-service isolation. Real package installation and connectivity still need a Linux staging server; Windows local preview cannot verify Linux/systemd or actual VPN connections.

## Sources

Adapters follow [OpenVPN configuration](https://openvpn.net/community-docs/creating-configuration-files-for-server-and-clients.html), [ocserv documentation](https://www.infradead.org/ocserv/manual.html), [OpenSSH sshd_config](https://man.openbsd.org/sshd_config), [WireGuard quick start](https://www.wireguard.com/quickstart/), [Xray configuration](https://xtls.github.io/config/), and [MasterDnsVPN](https://github.com/masterking32/MasterDnsVPN) (MIT).
