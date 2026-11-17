# A2Z Construction Inbox for HighLevel

Use a Marketplace **Custom Page** to put the inbox in the installed sub-account's navigation. The page points to the existing HTTPS Netlify deployment. HighLevel can automatically select the matching IONOS mailbox in the embedded page. Direct visits use the IONOS sign-in form. This integration does not use HighLevel CRM API access or URL variables.

| Developer Portal field | Setting |
| --- | --- |
| App name | A2Z Construction Inbox |
| Visibility | Private for the A2Z pilot |
| Target user | Sub-account |
| Short description | Access your IONOS mailbox and construction correspondence from HighLevel. |
| Module | Custom Pages |
| Page name | A2Z Inbox |
| Placement | Left navigation menu |
| Page URL | `https://a2zemails.netlify.app/` |
| HighLevel data permissions | No CRM access is used by this page. Leave optional scopes and webhooks unset. |

1. Deploy the source using the hosted IONOS settings in the README. Open the HTTPS URL directly and confirm it shows the mailbox sign-in.
2. In the HighLevel Developer Marketplace, open **My Apps → Create App**. Use the settings above and add the Custom Page in the app version. Keep the app private while testing. If the portal requires an installation authorization flow, complete the applicable app setup in that portal before attempting install.
3. The Netlify response allows `https://app.gohighlevel.com` to frame the page. If the pilot runs on a white-label domain, add its exact HTTPS origin to `frame-ancestors` and redeploy. Keep the Custom Page URL free of mailbox credentials, tokens, and personal query parameters.
4. Go to **Manage → Versions → … → Test Link** and generate a link for the intended test Location ID. Install it in that location and open **A2Z Inbox** from the sidebar.
5. Verify automatic sign-in as an approved user, and confirm direct visits still show the IONOS login form. Check formatted email, inline images, and sending a test message to yourself. The mailbox allowlist is configured per Netlify deployment. This setup is a single-organization pilot with mailbox sign-in, not tenant provisioning for a public listing.

## Automatic sign-in in the Marketplace Custom Page

The page requests HighLevel's encrypted user context from its parent frame. The Netlify function opens that context with the Marketplace app's Shared Secret and checks the agency, active location, and email. When the HighLevel email matches an authorized IONOS mailbox, the app creates a mailbox session. The browser holds the session only in memory and does not need third-party cookies. A regular HighLevel Custom Menu Link may not provide Marketplace user context. Use the installed Marketplace Custom Page for auto sign-in.

Keep the existing `A2Z_MODE`, `IONOS_ALLOWED_MAILBOXES`, and `SESSION_SECRET` settings. Add these variables in Netlify with **Functions** scope, then redeploy:

| Key | Value |
| --- | --- |
| `GHL_APP_SHARED_SECRET` | From the Marketplace app's **Advanced Settings → Auth → Shared Secret**. This is separate from `SESSION_SECRET`. |
| `GHL_COMPANY_ID` | The authorized HighLevel agency/company ID. |
| `GHL_LOCATION_IDS` | Comma-separated IDs of the approved sub-accounts. |
| `GHL_IONOS_MAILBOX_PASSWORDS` | Secret JSON mapping each matching email to its IONOS mailbox password. For example, `{"office@example.com":"<mailbox password>","estimates@example.com":"<mailbox password>"}`. Each mailbox must also be in `IONOS_ALLOWED_MAILBOXES`. |
| `GHL_PARENT_ORIGINS` | Optional. Comma-separated, exact white-label HTTPS origins, without a trailing slash. Add the same origins to the Netlify CSP. |

Enter mailbox passwords only in Netlify's secret Functions setting when enabling GHL auto sign-in. IONOS still requires its own credentials when the server connects. Without this optional mapping, users can sign in manually with their IONOS credentials. To remove GHL access to a mailbox, remove it from the mapping and redeploy. Removing it from the main allowlist also removes direct access through this app.

During the pilot, test a matching user, an unmapped user, a user in a different location, and a direct mobile visit to `https://a2zemails.netlify.app/`. The published Marketplace app and production SSO must be tested in the developer portal.

Official references: [Create a Marketplace app](https://marketplace.gohighlevel.com/docs/oauth/CreateMarketplaceApp/index.html), [Custom Pages](https://marketplace.gohighlevel.com/docs/marketplace-modules/CustomPages/), [install and test an app version](https://marketplace.gohighlevel.com/docs/oauth/TestingApp/index.html).

HighLevel protocol reference: [User Context in Marketplace Apps](https://marketplace.gohighlevel.com/docs/other/user-context-marketplace-apps/).
