# DNS hosting, MasterDNSVPN and server cores

BenX stores the desired configuration and applies it to the selected full-access VPS. DNS hosting is a server service; the Cloudflare Worker is its management interface. Panel-only connections cannot install these services.

## Cached DNS with DoH, DoT and DoQ

1. Select the VPS, open **Cores**, install **DNS resolver**, then open **DNS hosting**.
2. Create an unproxied A record, such as `dns.example.com`, pointing to the VPS public IPv4. DoT and DoQ need a direct connection; an ordinary Cloudflare HTTP proxy cannot carry them.
3. In **Servers → Server setup**, issue a domain certificate, IP certificate, or both. The issuance flow remembers the certificate and private-key paths and installs automatic renewal. Allow port 80 for HTTP ownership validation. Short-lived IP certificates require frequent renewal.
4. Create a resolver. Bind to the public IPv4, select a remembered certificate, choose upstreams, and enable caching. The default cache is 1 MiB and the request rate limit is 20 per second per client IP. Ordinary DNS accepts TCP and UDP. DoH uses TCP; DoT uses TCP; DoQ uses UDP. DoT and DoQ may share port 853.
5. Add the devices’ public IPv4 addresses or private VPN subnets to **Allowed clients**. Access defaults to local-only. If a device’s public IP changes, update its entry. `0.0.0.0/0` deliberately makes the resolver publicly accessible; avoid it unless you intend to run a public resolver. BenX creates a separate access chain scoped to this resolver and its endpoint ports.
6. Allow the selected ports in the VPS provider firewall. The existing OS resolver and global firewall policy are retained.
7. Wait until server synchronization confirms the saved revision. Copy the endpoint from the resolver card:
   - DoH: `https://dns.example.com:8443/dns-query`
   - DoT: `tls://dns.example.com:853`
   - DoQ: `quic://dns.example.com:853`
   - Ordinary DNS: `VPS_IP:5353` when sharing the VPS with a DNS tunnel.

Android Private DNS normally takes a hostname and uses DoT port 853. Most basic device DNS fields cannot specify a custom port; use encrypted DNS or a router/client with custom-port support. QUIC requires a compatible application. An IP endpoint must use an IP certificate, not a certificate for another hostname.

Certificate renewal restarts the owned DNS service and refreshes portable certificate snapshots. Original paths stay in the saved configuration. A replacement uses the backed-up certificate if the original paths do not exist yet. Point DNS at the replacement, then issue its certificate to resume renewal. Certificate recovery does not change external DNS records automatically.

The resolver’s access policy is based on network addresses. It does not provide individual customer credentials, traffic quotas or billing. Customer proxy/VPN credentials remain on the Clients page.

## DNS port conflicts

An ordinary recursive resolver and a MasterDNSVPN authoritative tunnel cannot both bind the same address and UDP port 53. BenX rejects overlapping DNS endpoint ports before saving and checks them again on the server. Keep **MasterDNSVPN on UDP 53** when using public recursive resolvers, and move ordinary DNS to **5353**. Its DoH/DoT/DoQ endpoints continue working on their own ports. Stop or remove an existing conflicting service before changing ports; unmanaged services can also occupy them.

Bind port 53 to the public IPv4 rather than `0.0.0.0`; this avoids competing with the OS stub resolver on its loopback address. MasterDNSVPN on a custom port is suitable for a direct resolver/client test, not a normal public-recursive deployment.

## MasterDNSVPN domain delegation

You need DNS control that permits NS records, not just a dynamic A-record hostname.

| Record | Name | Value |
| --- | --- | --- |
| A, DNS-only | `ns.example.com` | VPS public IPv4 |
| NS | `tunnel.example.com` | `ns.example.com` |

If the nameserver is inside the delegated child zone, the DNS provider may require a glue record. Use the parent-zone nameserver example above to avoid that complication. Check that delegation reaches the VPS from a public resolver. Do not proxy these records or point the delegated tunnel at an unrelated web/CDN endpoint.

1. Install **MasterDnsVPN** from Cores. The adapter pins an official release and verifies its SHA-256 checksum.
2. Add a MasterDNSVPN inbound, listen on the public IPv4, use UDP **53**, and set `DOMAIN` to `tunnel.example.com`. Choose AES-256-GCM (method 5) or another supported encrypted method. Do not use the nameserver hostname as the tunnel domain.
3. Allow UDP 53 at the VPS provider and verify that no ordinary DNS service occupies it.
4. For an individual allowance, pair the DNS listener with a private authenticated VLESS backend, attach the customer to the DNS listener, and set the quota. Each customer gets a separate UUID. Standalone SOCKS5 mode uses a shared key. Anyone with the copied key can have unlimited access. [Metered setup](operator-guide.md#masterdns) · [راهنمای فارسی](operator-guide.fa.md#masterdns)
5. Open **Clients → Share → Connections & profiles**. Download the JSON configuration and **client_resolvers.txt**. The profile contains the generated server key, domain and encryption method. Keep it private.
6. Download the official client for the device. Run, substituting the actual binary and downloaded JSON filename:

   ```text
   MasterDnsVPN_Client -json alice-profile.json -resolvers client_resolvers.txt
   ```

7. For a metered TCP profile, start MasterDNS and import the customer’s subscription in a VLESS-capable app on the same device. Select the localhost MasterDNS entry. For standalone SOCKS5, set the application’s proxy to `127.0.0.1:18000`.

The resolver file initially contains `1.1.1.1:53`, `8.8.8.8:53`, and `9.9.9.9:53`. These are examples, not guaranteed reachable or suitable in Iran. Change **clientResolvers** in the inbound’s Protocol settings if you have a tested list. Run the upstream client’s resolver/MTU checks from the actual user network. Direct testing can use `VPS_IP:31010` when that is the configured tunnel port; this bypasses recursive delegation and must not be described as a public-resolver acceptance test.

Verify the NS and nameserver address with `dig NS t.example.com` and `dig A ns1.example.com`, substituting your actual names. Test the delegated listener through a recursive resolver from the intended customer network. A direct IP-and-port test checks a different path.

## Other cores

Install the selected core on the full-access server first. Create its inbound, then create or attach the client. After synchronization, retrieve native profiles from **Clients → Share → Connections & profiles**.

| Core | Server setup and client use |
| --- | --- |
| Xray | Select protocol, transport and security in the inbound tabs. TLS needs a matching certificate; REALITY needs a suitable target and matching keys/SNI. Share a supported subscription format or connection link. |
| OpenVPN | Choose TCP/UDP and an unused private subnet. Set the public server address. For username/password mode, distribute the common CA-only `.ovpn` file and the customer’s own credentials. Certificate mode retains individual certificate/key files. Both creates separate UDP and TCP download files. |
| OpenConnect / Cisco | Choose an unused subnet and public host. Use the account details and exported public-key pin with OpenConnect. This adapter’s private certificate needs its exported pin; do not disable certificate verification. |
| OpenSSH | Choose a dedicated unused listener port and public host. Use the generated username/password and verify the exported host key. Management SSH credentials remain separate. |
| Native WireGuard | Choose an unused subnet, server interface address and port. Assign each client a unique address. Download its `.conf` and import into WireGuard. |
| MasterDNSVPN | Follow NS delegation and resolver-file instructions above. |
| DNS resolver | Configure in DNS hosting. It is not a customer proxy inbound. |

OpenVPN, OpenConnect and WireGuard can enable Internet access with scoped forwarding/NAT. Avoid overlapping private subnets. Native per-user weighted quota accounting is available for VLESS, VMess, Trojan, Shadowsocks, native WireGuard and paired MasterDNS through VLESS. Other adapters reject unsupported quota/IP/HWID limits rather than suggesting that they are enforced.

## Choosing a server-to-server tunnel

WireGuard creates an encrypted private link over UDP. SSH direct and reverse forward a selected TCP destination. FRP TLS and FRP WSS provide authenticated reverse TCP forwarding. Compare results on the intended pair of servers.

New setups and comparisons offer these five methods. Historical GRE, IPIP, Backhaul, Phormal and Hedioum records remain available for inspection and cleanup. Follow [the tunnel walkthrough](operator-guide.md#tunneling) or [راهنمای تونل](operator-guide.fa.md#tunneling).

## VPNJantit and other free outbound locations

1. Open **Free multi location → VPNJantit → Discover listings**.
2. Create one account on the official site, completing its human challenge and terms yourself. Keep the issued profile; accounts have expiration and usage rules.
3. Import the profile with a unique outbound tag. Run **Test**; only a successful HTTP connection can mark it verified.
4. Choose **Add outbound / route**, tick the inbound(s) whose traffic should exit through it, and optionally select destination domains. If both are set, both conditions must match. With neither, only the outbound is added.
5. Wait for server synchronization, then confirm the exit IP through the actual client. A directory listing alone is not proof of connectivity.
6. Review Routing and Outbounds when the account expires. Removing a library entry does not remove an already applied outbound or rule.

For a provider profile, verify the expected exit IP and transfer a sample file from the client before relying on the route.

## Primary references

- [AdGuard dnsproxy and supported transports](https://github.com/AdguardTeam/dnsproxy)
- [Pinned DNS engine v0.86.0 release](https://github.com/AdguardTeam/dnsproxy/releases/tag/v0.86.0)
- [MasterDNSVPN setup, client downloads and resolver guidance](https://github.com/masterking32/MasterDnsVPN)
- [Hysteria server configuration and obfuscation](https://v2.hysteria.network/docs/advanced/Full-Server-Config/)
- [Phormal project](https://github.com/Schmi7zz/Phormal)
- [Hedioum project](https://github.com/hedioum/Hedioum-Pool-Tunnel)
- [VPNJantit free VLESS directory](https://www.vpnjantit.com/free-v2ray-vless)


## MasterDNS encryption and customer access

Inbounds → Edit → Protocol → Encryption method offers XOR (1), ChaCha20 (2), AES-128-GCM (3), AES-192-GCM (4) and AES-256-GCM (5). New listeners default to ChaCha20. XOR is obfuscation and should not be treated as strong encryption. Existing listener methods remain unchanged until explicitly edited. All customers on the listener need to refresh their subscription or native profile after a method change has been confirmed. Full-access creation allows one MasterDNS listener per server, with multiple delegated domains and customers.

Use the customer icon in an inbound row to attach or detach selected customers, or every customer on that server. Each action saves one revision. Other inbound attachments and credentials are retained. Paired OpenVPN transports and private metered MasterDNS backends follow their main listener. Unsupported traffic quotas are rejected before saving the bulk attachment. Disabling an inbound excludes it from subscription exports; enabling it restores it without changing the subscription URL.
