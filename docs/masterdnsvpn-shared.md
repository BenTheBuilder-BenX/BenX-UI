# Shared MasterDNSVPN with customer quotas

The upstream DNS listener shares one encryption key. BenX-UI can put a private authenticated VLESS listener behind its TCP forwarding mode to distinguish customers and meter their proxy traffic.

1. Create a VLESS inbound listening on `127.0.0.1`, using RAW/TCP, security None, decryption `none`, and Exclude from subscription. Give it a free port.
2. On the MasterDNSVPN inbound's Protocol tab, select this listener under Customer authentication.
3. Attach customers to the DNS inbound. BenX-UI also attaches their distinct UUIDs to the private listener. Set their traffic allowance normally.
4. From the customer's Share action, download the MasterDNSVPN TCP configuration and resolver file. Start that client, then import the supplied localhost VLESS link in a compatible proxy app. Use local port 18000 or change both profiles together.

Accounting counts authenticated VLESS upload/download and applies the DNS inbound's traffic multiplier. DNS packet overhead is not counted. Revoking a customer removes their VLESS credentials; the outer DNS encryption key remains shared. Stock MasterDNSVPN SOCKS-only mode does not provide separate customer accounting.

Public resolvers require an NS delegation and UDP port 53. Direct resolvers may use `VPS-IP:port`. Do not expose the private VLESS backend or share its UUID between customers. Use a fresh backend for each DNS listener.

Upstream: https://github.com/masterking32/MasterDnsVPN
