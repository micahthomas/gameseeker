/**
 * Secrets are not declared in wrangler.jsonc (they'd be committed), so they
 * don't appear in the generated worker-configuration.d.ts. Declaration merging
 * into Cloudflare.Env — the interface backing `env` from "cloudflare:workers" —
 * adds them.
 *
 * Set them with: npx wrangler secret put <NAME>
 */
declare namespace Cloudflare {
  interface Env {
    /** Required. Signs/encrypts the session cookie. Must be >= 32 chars. */
    SESSION_SECRET: string
    /** Required only when MAIL_PROVIDER=resend. */
    RESEND_API_TOKEN?: string
    /** Required only when SMS_PROVIDER=twilio. */
    TWILIO_ACCOUNT_SID?: string
    TWILIO_AUTH_TOKEN?: string
    TWILIO_FROM?: string
  }
}
