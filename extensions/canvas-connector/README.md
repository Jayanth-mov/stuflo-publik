# StuFlo Canvas Connector

Chrome/Edge extension for connecting a student's Canvas browser session to StuFlo and quietly refreshing it after Canvas rotates the login cookie.

## Local Install

1. Open Chrome or Edge.
2. Go to `chrome://extensions`.
3. Turn on Developer mode.
4. Click **Load unpacked**.
5. Select this folder:

```text
C:\Users\annaj\StuFlo\extensions\canvas-connector
```

## Test Flow

1. Open `https://app.stuflo.com/dashboard/connections` and sign into StuFlo.
2. Open your Canvas dashboard in another tab and sign into Canvas normally.
3. While focused on the Canvas tab, click the StuFlo Canvas Connector extension.
4. Click **Grant Canvas permission** and approve the Chrome permission prompt.
5. Reopen the extension if Chrome closes the popup.
6. Click **Connect Canvas to StuFlo**.
7. The extension sends Canvas-domain cookies to the open StuFlo dashboard tab.
8. StuFlo validates the cookies, encrypts them, and saves them.
9. Return to the Connections page and confirm Canvas changes to **Connected**.
10. After this explicit connection, the extension resynchronizes cookies for that exact Canvas host when Canvas rotates `canvas_session`, `_normandy_session`, or `_csrf_token`, when StuFlo reopens, and every five minutes while StuFlo is open.

## Notes

- This does not send or store the Canvas password.
- The extension requests Canvas host permission at runtime for the active Canvas origin.
- Custom university domains are supported; the hostname need not contain `canvas` or `instructure`. Open your signed-in Canvas page, grant permission for that exact site, then connect. Opening the popup or granting permission does not upload site cookies; clicking Connect sends that site's cookies to StuFlo for Canvas validation. A generic HTTPS site is not automatically identified as Canvas.
- Compatibility requires a public HTTPS DNS hostname with Canvas's cookie-authenticated API at `/api/v1`. IP addresses, local/reserved hosts, URL credentials, custom ports, and Canvas installations under a separate API base path are not supported. School SSO, WAF, or API restrictions can still prevent a connection; this is not a guarantee for every university.
- Background refresh is limited to the exact Canvas host the student explicitly connected and is throttled.
- Manual connects and background refreshes share one queue, and repeated clicks share the same pending connect.
- Reload the unpacked extension at `chrome://extensions` after upgrading to 0.4.5, then reload the StuFlo tab. Updates under the same extension ID preserve the connected host and resume background refresh. Installing under a new extension ID requires connecting once; Chrome keeps each extension's storage separate. Chrome may ask for the alarms permission when upgrading from 0.3.
- A recurring alarm checks for refresh about every five minutes while StuFlo is open. Its deadline survives service-worker restarts. Periodic checks allow up to 65 seconds for the previous upload's completion time, and skip a more recent successful refresh. Chrome may delay alarms during sleep or for scheduling reasons.
- Connect Canvas and StuFlo in normal browser windows. Incognito connections are not supported.
- An upload must receive a confirmed saved connection from StuFlo before the extension records success. Uploads stop after 60 seconds, and a missing response releases the connection queue after 65 seconds so a later refresh or manual retry can recover.
- A failed upload cancels cookie refresh activity received before the failure. New cookie changes remain eligible to recover. Upload requests include an allowlisted refresh-reason header (`manual`, `cookie`, `canvas-tab`, `stuflo-tab`, `alarm`, or `startup`) for diagnostics, without cookie values or account information in the label.
- The backend validates that the cookie set opens a logged-in Canvas session before saving.
- The public Web Store package communicates only with `https://app.stuflo.com`.
- If the popup says StuFlo is not signed in, open the StuFlo dashboard tab and sign in again.
- If the popup says Canvas did not accept the session, reload Canvas, confirm you are past the login page, and retry.

## E2E Acceptance

- Popup success should read `Connected <canvas-host> with <n> cookies.`
- `cookiesUpdatedAt` should update in Postgres for the signed-in StuFlo account.
- The scraper should log `Canvas cookies saved from connector`.
- A chat request that needs Canvas data should work without opening a remote/headful browser.
