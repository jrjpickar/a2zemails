# A2Z Construction Inbox — local sandbox

Use Node.js 22.16+ and pnpm 11. From the extracted repository root:

```sh
pnpm install --frozen-lockfile
pnpm dev
pnpm test
pnpm build
```

Open the local URL printed by Vite. No credentials or environment file are needed. Compose, reply, reply all, forward, and **Send test email** only update this browser. Use **Sandbox → Simulate incoming mail** to run a sample message through classification and project matching. Drafts and mail actions persist in local storage. Inbox combines messages from all folders, with drafts available separately. The top bar switches between GHL dark mode and color mode. Use **Sandbox → Email signatures** to set a plain text signature for each sender. The compose window previews the signature and lets you omit it for the current draft.

Command Center shows bid deadlines in due-date order, urgent unread correspondence, likely requests with no later reply, and unread invoice mail. These queues use mail metadata and simple content rules. Attachments resolve to a same-origin sample PDF; they are safe placeholders. To start fresh, clear site data for the preview origin.

Try searching `project:"Harbor Point" attachment:"Plan Set"`. Search qualifiers include `from:`, `to:`, `subject:`, `project:`, `date:`, and `attachment:`. Use the reader's Project and Category menus to correct matches. Saving a domain rule explicitly affects future classifications. If multiple projects match, the message stays unassigned.

## Connect a local IONOS mailbox

1. Copy `.env.example` to `.env`. Set `A2Z_MODE=live`, `A2Z_ENABLE_LIVE=true`, `IONOS_EMAIL` to the complete mailbox address, and `IONOS_PASSWORD` to the mailbox password. Keep this file local.
2. Run `pnpm build`, then `pnpm ionos`.
3. Open the IONOS inbox printed by the server at `http://127.0.0.1:4174/`. Use **IONOS → Refresh mailbox** to fetch new mail and **IONOS → Email signatures** to set your signature. **Send email** submits a real SMTP message from the configured mailbox.

Defaults follow [IONOS mail client settings](https://www.ionos.com/help/email/other-email-programs/add-a-mail-basic-email-account-to-mozilla-thunderbird/). IMAP uses TLS on 993 and SMTP uses TLS on 465 (587 enables required STARTTLS). Credentials stay in the local Node process. The app binds to loopback for use by the local desktop user. This mode does not require PostgreSQL.

The IONOS client loads up to 75 recent messages from Inbox and 25 from each other readable mail folder. It reads plain text previews within its download budget. If the list skips a body, opening the message fetches only the readable MIME part. HTML-only bodies are converted to plain text, and large attachments are skipped. It supports read status, stars and folder moves on the server, and sends signed plain text mail. After SMTP acceptance it tries to save a copy to IONOS Sent. IMAP drafts and live attachments are outside this version. Real account login and delivery still require validation with an authorized mailbox.

Recipient suggestions in To and Cc come from sender and recipient addresses found in recent IONOS mail, including Sent. Saved-only entries in the separate Webmail Address Book are outside this integration. Use **⌘R** for Reply, **⌘⇧R** for Refresh and **⌘F** for Forward with focus inside the app. Some browser or GHL shortcuts may be intercepted before they reach the iframe. The corresponding controls are available in the reader and IONOS menu.

## Netlify

Import the repository and use the checked-in Netlify settings, `pnpm build`, publish `dist`, and load functions from `netlify/functions`. Run `netlify dev` with the Netlify CLI to exercise `GET /.netlify/functions/sandbox?q=...`. That endpoint only exposes synthetic read-only fixtures. The browser keeps its own sandbox state and does not write to the endpoint. No hosted deployment was performed.

### Enable live IONOS on Netlify

Use a repository-connected Netlify deploy so both the build and Functions run. In Netlify, set the following environment variables for the **Functions** scope and redeploy:

| Key | Value |
| --- | --- |
| `A2Z_MODE` | `live` |
| `IONOS_ALLOWED_MAILBOXES` | Comma-separated list of full mailbox addresses approved for sign-in |
| `SESSION_SECRET` | A random secret, e.g. the output of `openssl rand -hex 32` |
| `IONOS_SMTP_PORT` | Optional. Defaults to `465`. Use `587` for required STARTTLS. |

Open the deployed URL and sign in with the IONOS mailbox address and mailbox password. The hosted backend verifies the login via IMAP. The browser holds a short-lived encrypted session token in memory, so reloads require signing in again. The password is entered at sign-in and does not belong in the Netlify environment or GHL URL. The hosted app talks to IONOS directly and needs no PostgreSQL or GHL API credentials.

Test with one approved mailbox. Sign in, refresh Inbox, type a known correspondent in To, then send a test message to yourself. Confirm delivery and the copy in Sent. Repeat inside the target HighLevel sub-account. Real Netlify-to-IONOS connectivity and the HighLevel iframe remain unverified.

### Embed the sandbox in HighLevel

Deploy the repository to Netlify as a sandbox, then add its HTTPS URL under HighLevel **Settings → Custom Menu Links** and choose **Open in an Embedded Page (iFrame)**. The Netlify CSP allows `https://app.gohighlevel.com` to frame the sandbox. If your agency uses a white-label hostname, add its exact HTTPS origin to the `frame-ancestors` directive in `netlify.toml`, then redeploy. Avoid adding an additional frame-blocking header such as `X-Frame-Options: SAMEORIGIN`.

Test the menu link in the intended sub-account. Open Command Center, toggle the theme, and save and reopen a draft within the iframe. Browser policies can partition or block storage inside an embed. HighLevel menu visibility controls who sees the link in the sidebar. The live app requires an independent IONOS mailbox sign-in.

## Integration boundary

The mock contracts in `src/adapters.mjs` cover estimate/project lookup, demo attachment manifests, dispatch and ledger mail, existing CRM contact lookup, and read-only assistant views. No external route or credential is assumed. No adapter supports autonomous sending.

`db/001_init.sql` is the initial PostgreSQL migration. `worker/sync.mjs` is a separate experimental ingestion process with TLS, UID/UIDVALIDITY cursors, message key deduplication, expunge markers, paged fetches, IDLE/polling, and reconnect backoff. It exits offline by default. Live worker testing requires an isolated IMAP account, PostgreSQL with the migration applied, and process environment variables from `.env.example`. Both `A2Z_MODE=live` and `A2Z_ENABLE_LIVE=true` are required. Use a secret manager on the worker host; never expose credentials to Vite. The web API refuses live mode.

The worker has not been exercised against IMAP or PostgreSQL, and is not connected to the frontend. It stores raw messages in PostgreSQL; production authentication and role checks, HTML rendering and sanitization, signed private object storage, and real A2Z integrations are unfinished. The loopback IONOS app is separate from the worker and includes its own mail parsing and SMTP transport. The demo paginates rendered rows and uses plain text; it does not implement production list virtualization or ingest real uploads.

Before a live pilot, prioritize end-to-end tests using an isolated mailbox, authenticated user and mailbox access, then streaming attachments into private object storage and connecting the UI to the live API. Validate real adapter contracts before connecting to existing systems.
