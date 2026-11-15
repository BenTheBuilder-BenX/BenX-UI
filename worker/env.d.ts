// Optional bindings live outside Wrangler's generated file so `npm run types`
// can be rerun without removing support for optional integration settings.
interface Env {
  AUTO_MIGRATE?: string;
  INSTALL_PROOF?: string;
  OWNER_SETUP_TOKEN?: string;
  OWNER_RECOVERY_TOKEN?: string;
  CF_API_TOKEN?: string;
  CF_ACCOUNT_ID?: string;
  CF_WORKER_NAME?: string;
  AGENT_POLL_SECONDS?: string;
}
