# BenX-UI operator guide

[راهنمای فارسی](operator-guide.fa.md) · [Install and activate](easy-install.md)

Open **Page guide** in the panel to read these steps beside the settings. After changing a server, check the applied revision and test the customer connection.

- [Start your panel](#launch)
- [MasterDNS with a data allowance](#masterdns)
- [DNS hosting and external DNS records](#dns)
- [Set up the Telegram shop and deliver a purchase](#telegram)
- [Connect two servers and verify the tunnel](#tunneling)
- [Create a listener and test its public endpoint](#inbounds)
- [Create, share and renew a customer](#clients)
- [Build a plan for customers or a shop](#services)
- [Share an app link or customer page](#subscriptions)
- [Connect a native VPN client](#native)
- [Connect, synchronize and replace a VPS](#servers)
- [Worker, subscription and VPS hostnames](#domains)
- [Issue and renew a TLS certificate](#certificates)
- [Install the network core your inbound uses](#cores)
- [Read server health and usage](#overview)
- [Delegate access and set reseller limits](#team)
- [Sell and renew from the reseller workspace](#portal)
- [Protect and recover your login](#account)
- [Publish the native server storefront](#storefront)
- [Choose an outbound connection](#outbounds)
- [Route traffic by inbound or destination](#routing)
- [Edit the Xray configuration](#xray)
- [Set the address advertised to clients](#hosts)
- [Import and test an external location](#locations)
- [Run an isolated experiment](#testing)
- [Connect an upstream panel node](#nodes)
- [Organize customers and panel groups](#groups)
- [Change selected panel settings](#settings)
- [Read service and connection logs](#logs)
- [Review administrative activity](#audit)
- [Back up and restore a configuration](#backups)
- [Use the versioned API console](#api)
- [Use the optional assistant](#ai)

<a id="launch"></a>

## Start your panel

1. Deploy the repository with its Cloudflare button. Open the private setup URL printed in the deployment log, create your owner login, and save your recovery details from My account.
2. Choose Servers, add a full-access Linux VPS or link an existing 3X-UI panel, and check the connection. In manual mode, save edits, review the pending revision, then select Apply saved batch.
3. Create an inbound, add one test customer, and open their private subscription from another device. Update the subscription in the client app after changing its assigned connections.

<a id="masterdns"></a>

## MasterDNS with a data allowance

1. On a native server, install MasterDNSVPN and Xray in Cores. In Inbounds create a VLESS listener on `127.0.0.1` with a free TCP port, RAW/TCP transport, security None, decryption `none` and Exclude from subscription enabled. This is the private authentication endpoint.
2. Create or edit the MasterDNSVPN inbound. In Protocol enter the delegated domain, choose its encryption method and under Customer authentication select that private VLESS listener. Use a dedicated backend for this DNS listener. Complete the DNS records and firewall steps in the DNS hosting guide.
3. In Services select the **DNS inbound** for the plan and set the data allowance, duration, multiplier and app formats. Attach the customer to the DNS inbound. BenX also attaches their UUID to the backend. Apply the revision and open the customer’s Share page.
4. On the customer device download the TCP JSON configuration and `client_resolvers.txt` from their customer page. Load both into MasterDNS and start it. Import the subscription in a VLESS-capable app on the same device and choose the MasterDNS entry. Both profiles use `127.0.0.1:18000`. If changing the local port, change both sides. Start with proxy mode. If you enable device-wide VPN routing, exempt the MasterDNS client so its upstream DNS can still reach a resolver.
5. Transfer a file, allow an accounting interval, then refresh usage. The private backend counts authenticated upload and download once per customer and applies the DNS inbound multiplier. DNS packet overhead and retransmissions consume separate network bandwidth. Fetching the subscription itself consumes no VPN quota.
6. Standalone shared-key SOCKS5 access can be unlimited. The panel cannot meter it per person or revoke a copied shared key for one buyer. A quota shown for another connection does not cap this path. Use the paired TCP setup when selling a fixed allowance. To offer standalone access through Telegram, select unlimited data, no individual expiry and enable the V2Box format.

<a id="dns"></a>

## DNS hosting and external DNS records

1. For a public MasterDNS tunnel under `example.com`, create a DNS-only A record `ns1.example.com` pointing to the real VPS IPv4 address. Add AAAA only if the VPS accepts IPv6 traffic on the advertised listener.
2. At the provider hosting the parent zone, create an NS record named `t` pointing to `ns1.example.com`. Enter `t.example.com` in MasterDNS. Keep the parent domain’s nameservers. The nameserver hostname and delegated child serve different purposes.
3. Allow inbound UDP 53 in the hosting provider firewall and the VPS firewall. Check port conflicts with other resolvers. From outside the VPS, verify `dig NS t.example.com` and `dig A ns1.example.com`, then transfer data through a real client using a recursive resolver. DNS lookup alone verifies only delegation.
4. For a direct resolver test use your VPS address and actual UDP port in the client resolver file. A nonstandard port will work only with direct resolvers configured for that port. If public resolvers fail, compare direct versus recursive results and inspect the parent NS record and UDP 53.
5. To run a recursive DNS service choose a DNS resolver inbound, an upstream and its network access rules. Permit only the intended networks. For a TLS endpoint set the matching certificate and hostname, then query from an allowed client.

<a id="telegram"></a>

## Set up the Telegram shop and deliver a purchase

1. Use the owner account or an administrator granted Manage Telegram shop in Team & Resellers. The shop is shared across servers. Give an administrator All servers and the separate shop permission to delegate setup, payment review and orders.
2. Create a bot with @BotFather using `/newbot`. Open Telegram sale on your public HTTPS panel, paste its token, Save, Verify bot, then Connect for setup. Open the bot in a private chat and send `/start`. The store can stay paused while you set it up.
3. Under Services create an enabled plan with at least one eligible inbound and subscription format. For metered MasterDNS select the public DNS inbound paired with private VLESS. Under Products choose the server and service, check the price in Stars, and enable the product. Supply the seller’s actual support contact and review the purchase terms.
4. Appearance controls the store name, language, welcome, delivery text, menu and checkout labels, custom HTTPS buttons and layout. Open **Order and payment messages** to change purchase, receipt, status and retry messages. Leave a field blank for its language default. Set the bot image in @BotFather. Save, then choose Start store to check products and register the webhook.
5. The buyer opens `/start`, chooses a plan and confirms the Stars invoice. After Telegram confirms payment, BenX creates one customer identity, applies the plan and sends the private customer page and compatible app links. The customer can retrieve the same delivery using `/myconfigs`. `/paysupport` shows your support details.
6. Check Orders for payment and delivery separately. For Delivery failed, check the assigned server and service, then Retry the existing order. Pause sales to stop new purchases while keeping paid orders available. Keep each customer’s link private.
7. Telegram requires Stars for digital services sold inside bots. The panel also records manual receipts for seller review. A photo is not payment confirmation. For an existing transfer, verify the deposit at the bank and approve the matching order once.

<a id="tunneling"></a>

## Connect two servers and verify the tunnel

1. Choose two different enabled full-access servers and enter their reachable public endpoint addresses. Select WireGuard, SSH direct, SSH reverse, FRP TLS or FRP WSS. Each server needs its agent online.
2. WireGuard needs an unused private IPv4 /30 and reachable UDP listen ports on the peers. For SSH direct the source loopback listener forwards to the target. For SSH reverse and FRP the source initiates and the target loopback listener forwards to the source service. Permit the selected control port at the receiving peer and keep the forwarded service pointed at its intended host and port.
3. Use Compare tunnels with unused ports and a sample size. Wait for upload and download measurements and cleanup confirmation on both peers. “Running” describes the service process. A successful two-way transfer checks the chosen path.
4. Create the permanent tunnel with the chosen method, then connect the application to the intended private address or loopback forwarding port. Test the actual destination with the client. If cleanup is pending, reconnect the original peers and let the comparison finish before starting another.

<a id="inbounds"></a>

## Create a listener and test its public endpoint

1. Select the intended server, open Inbounds and add a listener. Choose its protocol, a free port and a bind address. Set the public hostname clients should receive. An outbound agent ID is a management address.
2. Set the transport and TLS options to match the client. Permit the selected TCP or UDP port at the provider and OS firewall. Use Exclude from subscription for internal listeners.
3. Save, apply the revision if working in manual mode and create a test client. For MasterDNS open the dedicated quota tutorial in the guide selector before offering limited data.

<a id="clients"></a>

## Create, share and renew a customer

1. Add a customer to a visible inbound or choose a service. Use a unique name, separate credentials, a quota and either a fixed expiry or a supported first-use duration. Zero quota means unlimited.
2. Save and apply. Use Share to open the customer page or copy the URL or QR for the buyer. For native profiles, use the file and connection instructions on the page.
3. To renew, change the intended date or duration explicitly. Reset traffic when starting a fresh allowance. Refresh usage to confirm. A reseller’s cumulative consumption is retained across a customer reset.

<a id="services"></a>

## Build a plan for customers or a shop

1. Add a service on the chosen server. Select customer-facing inbounds, choose compatible subscription formats, then set quota in GB, duration in days and any supported device limits.
2. On a native metered listener a 2× multiplier charges twice the measured payload. For MasterDNS choose the DNS inbound and keep its private VLESS backend excluded. Panel-only connections use upstream accounting.
3. Enable the plan and save. Use Clients to assign it manually or Telegram sale → Products to attach a price. Confirm the first customer receives the intended connections.

<a id="subscriptions"></a>

## Share an app link or customer page

1. Choose the server and enable the app formats used by the service. Use Share on the client to issue their private URL. Use the customer page for QR codes, usage, expiry, connection files and individual configurations.
2. Open the URL in a browser for the customer page or use an app-specific subscription URL in an importer. Refresh the feed after changing the plan. A downloaded MasterDNS TCP profile needs the DNS client running before the VLESS app connects.
3. Use the page designer to set appearance, announcements and support. Configure an optional subscription hostname in Domains & Worker, verify its HTTPS route and then distribute links. Revoke or rotate a link if the customer needs a replacement.

<a id="native"></a>

## Connect a native VPN client

1. OpenVPN users download the matching UDP or TCP `.ovpn` profile from the customer page. In password mode enter that customer’s own credentials. In certificate mode import their individual profile and key. Test a connection from the customer network.
2. For native WireGuard assign a unique client address in the inbound subnet, apply the server revision and import the customer’s `.conf`. Send traffic, then check the handshake and byte counts. For OpenConnect use the public host, assigned login and exported server certificate pin. For SSH use the exported host, port and credentials and verify the host key.
3. Set a real public endpoint and allow the protocol at the VPS and provider firewall. For internet access verify forwarding, NAT and the client routes. OpenVPN, OpenConnect and SSH do not report per-customer data for native quotas. Use a measured listener when selling a data cap.

<a id="servers"></a>

## Connect, synchronize and replace a VPS

1. Add a native server and use the generated enrollment command on the intended Linux VPS, or provide the HTTPS URL and credentials for your existing 3X-UI panel. Copy enrollment commands from your own panel.
2. Use the connection check and import the existing configuration before editing. In manual mode inspect pending changes, apply the batch and confirm the server reports the same revision.
3. Before replacing a VPS, take a backup and stage the candidate. Verify applied listeners, customer traffic and TLS on the replacement before switching the public DNS record or retiring the old host.

<a id="domains"></a>

## Worker, subscription and VPS hostnames

1. Decide which hostname serves the panel, which serves subscriptions, and which points to a VPS. In Domains & Worker select the matching action. Use a Cloudflare token scoped to the account and zone you manage.
2. Preview the change and check the hostname, target and DNS record before applying. For a direct VPS connection, publish the actual address as DNS only. A Worker custom domain routes HTTP requests to the Worker.
3. Open the panel or a private subscription over HTTPS on its intended hostname. For a delegated DNS tunnel add the NS record at the parent DNS provider as described under DNS hosting.

<a id="certificates"></a>

## Issue and renew a TLS certificate

1. Choose the native server and hostname. At your DNS provider point A and any published AAAA records to this VPS. For standalone HTTP validation allow inbound TCP 80 and check that the port is free.
2. Request the certificate through Certificates or Server setup. After issuance choose the certificate in the inbound TLS settings, match the hostname and apply.
3. Connect with certificate verification enabled. Check the renewal status after a VPS replacement or DNS change and confirm the new host can answer the next challenge.

<a id="cores"></a>

## Install the network core your inbound uses

1. Select a full-access VPS and open Cores. Match the selected protocol to an available native adapter. Install the required core and wait for its job result.
2. Use Server setup for system options and certificate requests. Review the job log if a dependency, distribution or architecture is unsupported.
3. After saving the listener, refresh core status and connect a client. A detected binary alone does not confirm an applied listener or successful connection.

<a id="overview"></a>

## Read server health and usage

1. Select the server before reading CPU, memory, networking or listener counts. Check the timestamp of the last successful sample.
2. In manual mode choose Refresh server for live readings. Scheduled usage refresh can update counters separately from configuration. Look for a failed accounting check if totals stay unchanged after a transfer.
3. If a metric is unavailable, open Logs and check the connection or agent on that VPS. A native server may have no online-client reading.

<a id="team"></a>

## Delegate access and set reseller limits

1. As owner open Team & Resellers. Add an administrator for server operations, or a manager/reseller for customer sales. Share the individual sign-in URL with that person.
2. Choose assigned servers or inbounds and explicit customer actions. Set allocation, cumulative consumption and per-customer limits. To delegate the global Telegram shop, enable All servers and Manage Telegram shop on the administrator account.
3. Sign in through that role’s entry and verify which servers or customers appear. Changes to permissions invalidate old sessions. Archive a departing account when its customers and historic consumption should be retained.

<a id="portal"></a>

## Sell and renew from the reseller workspace

1. Use your personal workspace URL. Check the available customer count, remaining allocation, allowed inbounds and consumption budget before promising a plan.
2. Create a customer on an assigned server, enter the data allowance and days, then save and share their private link. If no inbound is available, the owner can add a grant in Team & Resellers.
3. Use the existing customer to renew or reset their allowance. Verify expiry and usage in their row. Only the actions granted to your account are available.

<a id="account"></a>

## Protect and recover your login

1. In My account change the generated login using your current password. Keep the private owner or member entry URL with your password manager.
2. The owner can export recovery details. Store that file offline with restricted access. Use the recovery procedure in the installation guide if the owner login is lost.
3. Sign in with the new credentials after changing them. Existing sessions may need to sign in again.

<a id="storefront"></a>

## Publish the native server storefront

1. Choose a native server and open Storefront. Pick the template or supported custom HTML, public hostname, port and eligible web-facing inbounds.
2. Set DNS for the chosen direct or CDN mode and arrange matching TLS. Verify the public HTTP page first, then test an assigned WebSocket connection through its advertised hostname.
3. Preview edits before applying them. Telegram sale manages the bot, product catalog, payments and private order delivery separately.

<a id="outbounds"></a>

## Choose an outbound connection

1. Add a uniquely named outbound tag and enter the upstream endpoint and credentials issued to you. Use the native editor or the selected panel’s supported options.
2. Test the outbound, save the configuration, and create a routing rule that uses its exact tag. Confirm the exit from an actual client on the matching inbound.

<a id="routing"></a>

## Route traffic by inbound or destination

1. Select a valid outbound tag, then choose the inbound, destination domains or address ranges for the rule. Review rule order and any broader rule that could match first.
2. Apply the revision and test one matching destination and one ordinary destination. Use the previous revision or remove the specific rule if the result differs.

<a id="xray"></a>

## Edit the Xray configuration

1. Open Xray configs for the correct server and back up the working configuration. Review outbound tags, routing dependencies and protocol support before editing JSON.
2. Save valid JSON and apply the revision. Check the core and logs, then reconnect a test client. If another edit already changed the config, reload it before merging yours.

<a id="hosts"></a>

## Set the address advertised to clients

1. Create a host entry, select its inbounds and enter the public address, port and TLS settings reachable from the client network.
2. Refresh an assigned subscription and inspect the advertised endpoint. Test a connection from outside the VPS. Update DNS and certificates separately when changing the hostname.

<a id="locations"></a>

## Import and test an external location

1. Obtain a profile from the provider with your own account. Import it into Free multi location with a unique tag and check its expiry.
2. Run Test, then add the outbound and select the inbound or destinations that should use it. Apply and verify the exit address with a client. Remove or update routing when the provider account expires.

<a id="testing"></a>

## Run an isolated experiment

1. In Testing Lab choose an assigned server and a test recipe. Review the temporary resources and the test objective before applying it.
2. Use its test link or manifest on the intended client, record observations and finish cleanup. Use Compare tunnels for a measured network-path comparison between two VPSs.

<a id="nodes"></a>

## Connect an upstream panel node

1. On a compatible 3X-UI server open Panel nodes, configure the node endpoint and credentials, then use its availability check.
2. Assign a test inbound to the intended node and confirm its public address and client connection. Node management depends on the connected panel version.

<a id="groups"></a>

## Organize customers and panel groups

1. On a compatible panel open Groups and review the selected members or filter before changing a group.
2. Apply the group change, refresh and verify a sample member. Use Services for saleable plans with quotas, formats and pricing through Telegram products.

<a id="settings"></a>

## Change selected panel settings

1. Open Panel settings on the intended 3X-UI server and review the current values. Save a backup before changing listening addresses, TLS or access paths.
2. Apply the changes, confirm the upstream panel remains reachable, and update its BenX connection details if the URL or credentials changed. Use Cores → Server setup for native server settings.

<a id="logs"></a>

## Read service and connection logs

1. Select the server, log source and recent time window. Reproduce one ordinary connection or refresh and match its time to the service messages.
2. Check the associated job or configuration revision for failures. Remove private links, tokens, addresses and customer identities before sharing a diagnostic excerpt.

<a id="audit"></a>

## Review administrative activity

1. Open Activity log and find the time, actor, server and operation matching a change. A saved change can still be waiting to reach the server.
2. Compare the audit entry with Synchronization and the service logs. Use Orders for purchase payment and delivery details.

<a id="backups"></a>

## Back up and restore a configuration

1. Export the selected server or panel backup before changing configuration. Keep it private because it may contain credentials.
2. Choose the restoration flow for that profile type. Review the target server and existing revision, then restore and compare listeners, subscriptions and actual client connectivity. Store recovery keys separately.

<a id="api"></a>

## Use the versioned API console

1. Select the target server and a listed operation for its API version. Fill the documented fields and inspect the response from a read operation first.
2. For writes, confirm the target and payload. Configuration changes on managed servers must follow their supported save and synchronization flow. Verify the result through the matching panel page.

<a id="ai"></a>

## Use the optional assistant

1. The owner configures the AI provider and its credentials. Open AI help in the panel and describe the intended change, customer allowance or configuration question.
2. Review the proposed server, customer and rule changes before confirming a draft. Check the saved revision and actual service afterwards. Use the manual controls when a provider is unavailable.

## Upstream references

- [MasterDnsVPN client and server](https://github.com/masterking32/MasterDnsVPN/releases/tag/v2026.06.13.234407-7de2476)
- [Cloudflare DNS subdomain delegation](https://developers.cloudflare.com/dns/manage-dns-records/how-to/subdomains-outside-cloudflare/)
- [Telegram Stars payments](https://core.telegram.org/bots/payments-stars)
