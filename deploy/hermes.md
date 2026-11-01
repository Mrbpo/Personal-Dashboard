# Hermes under the website owner login

`/hermes/` proxies the unmodified official Hermes dashboard. It does not add a new UI or user-facing login.

The proxy calls the existing read-only `/api/codex-maintenance` GET endpoint solely for its `apiOwner` authentication result; its status body is discarded. Anonymous API/socket requests receive 401, while HTML navigation returns to the website's `/login`. The recording authorization endpoint is unsuitable here because it also checks a temporary recording-session state.

The authentication subrequest strips `Upgrade` and `Connection`; the original WebSocket upgrade remains intact for the Hermes backend. Forwarding those headers to Next.js's ordinary owner-check route causes an EOF/502 instead of an authentication response.

All non-read requests and WebSocket upgrades require the public site's Origin. Caddy strips the `/hermes` path, declares `X-Forwarded-Prefix: /hermes`, and supplies an internal Authorization credential only after owner authentication succeeds. Client-provided Authorization never replaces the website login check.

Host requirements:

- Run Hermes on the host's internal Docker bridge address, with native dashboard authentication enabled and `dashboard.public_url` set to the site's `/hermes` URL. Keep port 9119 off the public interface.
- Provision `/srv/study/hermes-proxy.env` privately with `HERMES_UPSTREAM_AUTH`. It must be a valid credential accepted by the configured native Hermes provider, never the website password or a model key. Do not commit it.
- Set the matching Hermes-native provider in a root-only environment file for its service. The website login remains mandatory on every public request; the machine identity is not another human login.
- Configure `dashboard.trusted_proxies` for the actual proxy network. Do not rewrite away client Origin checks or disable Hermes authentication.
- If the host firewall blocks container-to-host traffic, allow only the actual site container subnet to the private bridge address on port 9119. Do not open this port on the public interface.

The optional Compose env file preserves deployments without Hermes; authenticated `/hermes` requests then fail closed if its backend/credential is absent. This deployment changes proxy configuration only and does not require rebuilding the website application.

Before activation, validate Caddy and preserve its previous configuration. Verify website health, anonymous denial, authenticated prefixed HTML/assets/API, wrong-Origin denial, and the authenticated WebSocket upgrade. No model request is needed for these checks.
