# Working on StuFlo

Run `npm run verify` for type checking, tests, lint, and the dashboard build. Use a disposable database and synthetic student data for integration tests.

## Publik API

- Base URL: `https://publikhq.com/api/v1`. StuFlo uses the Responses API with the `publik-fast`, `publik-balanced`, and `publik-smart` tier aliases.
- Hosted sign-in: after StuFlo authenticates a user, the dashboard and API enforce the Publik gate when enabled. The server provisions one install per StuFlo user; only signed-in, opted-in activity is sent to Publik.
- Credentials: keep `PUBLIK_APP_TOKEN` and `PUBLIK_INSTALL_SECRET` in Worker secrets. Keep install and user-supplied keys encrypted on the server. Never put credentials in Git, browser bundles, or logs.
- Payment required: show the provider's safe message and the one verified Publik top-up link. Preserve the user's own-key option and do not charge StuFlo credits for externally funded requests.
- Wallet display: show the percentage remaining, with no monetary amounts.
- Hosted proof: use the built app and verify StuFlo sign-in leads to the Publik gate, then exercise a streamed AI request using synthetic data.
- References: [Publik API](https://publikhq.com/developers), [hosted web integration](https://publikhq.com/sdk/publik.server.ts.md).
