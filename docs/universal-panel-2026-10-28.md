# Universal native control plane · 28 October 2026

Implemented locally in version 0.8.0:

- Native-first connection chooser and Getting started page with observed setup prerequisites, no false VPN-ready state.
- Fresh-VPS outbound enrollment: authenticated pre-install HTTPS check, expiring pairing secret, stable per-node identity, private loopback agent, no required third-party panel/SSH relay.
- Encrypted D1 command queue, atomic claim, stale-agent rejection, bounded command lifetime, private agent result journal and acknowledgement retry. Claimed/interrupted operations are not blindly replayed. Three-second idle polling is stated in the UI and launch guide.
- Expired/stalled pairing repair with a new expiring installer, exact identity checks, preserved node token/configuration and no duplicate logical server.
- Complete shared agent file set for offline/SSH setup, repairing missing imports in the old download package.
- Native capability/accounting limitations on all core cards; detected standalone cores remain disabled. MasterDNS differentiates unmetered outer tunnel from authenticated measured inner payload.
- Five curated encrypted tunnel choices; older/experimental methods removed from new setup/comparison APIs and UI while retaining historical status/removal/reconciliation support. Required tools already install automatically on both agents.
- Owner-only optional same-account DNS-only A/AAAA and Worker custom-domain management, signed expiring previews, account/zone checks, conflict refusal and explicit manual paths. No token enters browser settings.
- Sanitized source packaging, checksums, GitHub validation workflow, deployment/recovery guide and explicit live acceptance criteria. No GitHub repository or deployment created.

Existing native replacement, portable backups, subscriptions, staff/reseller policy and shop workflows remain. Automatic outbound logical-ID replacement, standalone sing-box/Hysteria provisioning and unmetered-core quota adapters are not implemented. Do not present them as launch-complete.

Validation completed on this candidate:

- TypeScript and ESLint passed.
- 402 application tests across 41 files and 116 Python agent tests passed.
- Production build, fixture exclusion and initial JavaScript budget passed: approximately 76.8 KB compressed initial JavaScript against a 140 KB limit.
- Cloudflare Worker deployment dry run passed (no deployment).
- The allowlisted source kit built independently using the existing installed dependencies. Private runtime/account-value scanning passed. This verifies file completeness; a fresh network dependency installation still belongs to release acceptance.
- Local browser checks covered the new connection chooser, installer options, manual VPS/Worker domain paths, English/Persian RTL and narrow-screen overflow correction. These were development-preview checks with sample data, not live server acceptance.
- npm advisory checks failed against both the configured mirror and the official registry. Dependency vulnerability status remains unverified; no clean audit is claimed.

Real Linux installation, client packet delivery, Cloudflare account writes, tunnel throughput, payment and destructive restore remain separate acceptance work. No live server/account changes, GitHub creation or publication occurred in this rebuild.
