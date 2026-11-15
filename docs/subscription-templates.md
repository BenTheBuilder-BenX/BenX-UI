# Subscription templates

Open **Subscriptions → Page templates** for the selected server. Existing customer links and QR codes stay the same when you change a design.

## Built-in layouts

- **Aurora** adapts the supplied `sub-page.html`: soft gradient background, glass cards and circular remaining-data/time indicators. It uses real customer counters and expiry, with no demonstration customer values or external scripts.
- **Gaming** uses an angular masthead and account scoreboard beside the connections.
- **Nature** uses an organic welcome card, a vertical connection path and an expandable account ledger.
- **Tech** puts the account ledger in a sidebar and app connections in a workspace.
- **Candy** uses a usage ticket, rounded connection cards and two shelves.
- **Classic** uses a restrained editorial page and full-width ledger.

Colors and titles are customization options within a layout. Language links, announcements, individual connection copying and supported VPN downloads work in every layout.

## Upload your own HTML

1. Select **Your HTML** and click **Download HTML starter**.
2. Change the surrounding markup and CSS in the HTML file. Keep all six placeholders once each, on separate lines inside the document body:

```
{{header}}
{{meter}}
{{account}}
{{subscription}}
{{files}}
{{footer}}
```

3. Upload the file (maximum 200 KB in UTF-8), or paste the edited HTML into **Template HTML**.
4. Check the preview, then click **Save template**. Open an existing customer link in a browser to see actual data.

The header includes language controls and announcements; meter contains live usage; account contains the customer ledger; subscription includes app links and individual connections; files contains available native downloads and credentials; footer includes support. Empty files blocks are normal when a customer has no downloadable protocols.

Templates use HTML and CSS. BenX supplies copy/theme/password controls; uploaded JavaScript, forms, embedded pages and external CSS resources are rejected. CSS inside `<style>` and inline styles are supported. Images must use HTTPS or data URLs. Head metadata is supplied by BenX (page title and language come from the design form). The uploaded body and CSS supply the custom layout.

A customer waiting for first use sees its purchased duration explicitly. If the original start time is unavailable, the time ring shows no invented percentage.

## Migration direction

In **Servers → Migration & recovery**, **Import from 3X-UI** reads an existing connected panel into BenX. **Restore on a fresh VPS** sends a saved full-access BenX profile to a new VPS, followed by verification and a manual switch. Import and restore are opposite operations; subscription templates do not initiate either operation.
