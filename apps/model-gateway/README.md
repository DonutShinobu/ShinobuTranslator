# Shinobu model gateway

This Worker streams the exact content-addressed model objects listed by
`@shinobu/model-manifest` from a private R2 bucket. It has no upload, list, or
remote-manifest endpoint.

Before production deployment:

1. Create the private `shinobu-models` and preview R2 buckets; keep `r2.dev`
   and public custom domains disabled.
2. Before replacing `manifest.json`, copy the outgoing package into
   `packages/model-manifest/compatibility.json`. The gateway must allow both
   content-hash packages while the new Pages version rolls out.
3. Upload every asset to the `modelR2Key(asset)` key and verify its size and
   SHA-256 locally.
4. Replace `ALLOWED_ORIGIN` with the production Pages origin.
5. Set `SERVING_ENABLED` to `true` only after the objects and Web release are
   ready.
6. Keep `TURNSTILE_REQUIRED=false` normally. If emergency abuse protection is
   enabled, store `TURNSTILE_SECRET` with `wrangler secret put` and set the
   expected `TURNSTILE_HOSTNAME`.
7. Keep the Workers route fail mode set to **fail closed** so the Free-plan
   daily request limit cannot bypass the gateway.
8. Remove an outgoing compatibility package only after its 30-day retention
   window and a successful rollback drill.
9. Keep `observability.enabled=false` and verify the deployed Worker in the
   Cloudflare dashboard. `send_metrics=false` only disables Wrangler usage
   metrics; it does not disable invocation logs.
10. Verify that Pages Web Analytics is disabled unless its beacon and data
    processing have been separately reviewed and disclosed.

Use a scoped Cloudflare API token; never use the Global API Key. `wrangler
deploy --dry-run` validates the bundle without changing remote state.
The protected-environment rehearsal, production smoke checks, emergency
shutdown, and exact Worker/Pages/model rollback commands are maintained in
[`docs/web-production-runbook.md`](../../docs/web-production-runbook.md).
