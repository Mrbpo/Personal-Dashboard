# Fitbit / Google Health

The health module uses Google Health API v4 (the legacy Fitbit API is being retired in September 2026).

## Connect

1. Follow https://developers.google.com/health/setup to enable Google Health API in a Google Cloud project and configure its OAuth consent screen. If the application is in testing, add your Google account as a test user.
2. Create a Web application OAuth client. Register `http://localhost:3000/api/health/callback` for local development, and `https://baipiao.fun/api/health/callback` for the deployed site, exactly as authorized redirect URIs.
3. Open `/settings#services` and enter Google OAuth Client ID and Client Secret. The default redirect URI is the localhost URL above. No `.env` edit is necessary.
4. Open `/health`, choose Connect Fitbit, and authorize the Google account linked to your Fitbit records.
5. The module requests only activity/fitness, sleep, and health metrics read-only scopes. It requests records from `users/me/dataSourceFamilies/google-wearables`.

## Storage and sync

Service settings are encrypted with AES-256-GCM in `data/private/services.enc`. A server-local key is created at `data/private/vault.key`. These files must remain private and backed up together. File encryption does not protect against someone who can read both files. The existing `data/` git exclusion covers them. Windows deployments should restrict this directory's ACL to the server account.

OAuth tokens are encrypted before being stored in the existing database. The UI never receives access or refresh tokens. Server-side config overrides existing environment settings; removing a value in the UI disables it even if an environment value exists.

The health page checks for updates when opened and every 15 minutes while visible. It is not an unattended background scheduler. Sync loads a rolling seven-day window. Daily steps use dailyRollUp; sleep, resting heart rate, and exercise use reconciled records with pagination. Missing values remain null. Failed categories retain earlier data with explicit warnings. All-failed syncs retain the prior successful timestamp.

AI analysis is user-triggered and sends only the daily summaries and missing-data notes to the configured OpenAI service with `store: false`. It does not send account credentials, detailed heart-rate samples or location. Same-data analysis is cached. Output is a wellness observation, not a diagnosis.

Disconnect clears this website's tokens, cached summaries, and analysis. To revoke the Google grant itself, use Google Account third-party connection settings.

## References

- https://developers.google.com/health/setup
- https://developers.google.com/health/endpoints
- https://developers.google.com/health/filters
- https://developers.google.com/health/reference/rest/v4/users.dataTypes.dataPoints
