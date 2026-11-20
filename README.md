# A2Z Construction Inbox — local sandbox

Use Node.js 22.16+ and pnpm 11. From the extracted repository root:

```sh
pnpm install --frozen-lockfile
pnpm dev
pnpm test
pnpm build
```

Open the local URL printed by Vite. No credentials or environment file are needed. Compose, reply, reply all, forward, and **Send test email** only update this browser. Use **Sandbox → Simulate incoming mail** to run a sample message through classification and project matching. Drafts and mail actions persist in local storage. Inbox shows incoming messages newest first. Deleted messages move to Trash. Workspace views show categorized mail and unread counts, with General available for messages without a specific category. Additional IONOS folders appear alphabetically in the sidebar. The top bar switches between GHL dark mode and color mode. Use **Sandbox → Email signatures** to set a plain text signature for each sender. The compose window previews the signature and lets you omit it for the current draft.

Command Center shows bid deadlines in due-date order, urgent unread correspondence, likely requests with no later reply, and unread invoice mail. These queues use mail metadata and simple content rules. Attachments resolve to a same-origin sample PDF; they are safe placeholders. To start fresh, clear site data for the preview origin.

Try searching `project:"Harbor Point" attachment:"Plan Set"`. Search qualifiers include `from:`, `to:`, `subject:`, `project:`, `date:`, and `attachment:`. Use the reader's Project and Category menus to correct matches. Saving a domain rule explicitly affects future classifications. If multiple projects match, the message stays unassigned.

## Connect a local IONOS mailbox

1. Copy `.env.example` to `.env`. Set `A2Z_MODE=live`, `A2Z_ENABLE_LIVE=true`, `IONOS_EMAIL` to the complete mailbox address, and `IONOS_PASSWORD` to the mailbox password. Keep this file local.
2. Run `pnpm build`, then `pnpm ionos`.
3. Open the IONOS inbox printed by the server at `http://127.0.0.1:4174/`. Use **IONOS → Refresh mailbox** to fetch new mail and **IONOS → Email signatures** to set your signature. **Send email** submits a real SMTP message from the configured mailbox.

Defaults follow [IONOS mail client settings](https://www.ionos.com/help/email/other-email-programs/add-a-mail-basic-email-account-to-mozilla-thunderbird/). IMAP uses TLS on 993 and SMTP uses TLS on 465 (587 enables required STARTTLS). Credentials stay in the local Node process. The app binds to loopback for use by the local desktop user. This mode does not require PostgreSQL.

The IONOS client loads up to 75 recent messages from Inbox and 25 from each other readable mail folder. It reads plain text previews within its download budget. If the list skips a body, opening the message fetches only the readable MIME part. HTML email keeps supported sender formatting and embedded images. External HTTPS images load only when selected in the reader. Plain text remains available for messages with no HTML, and large attachments are skipped. It supports read status, stars and folder moves on the server, and sends signed plain text mail. After SMTP acceptance it tries to save a copy to IONOS Sent. Syncing drafts to the native IMAP Drafts folder is outside this version. The hosted inbox supports sending file attachments and cross-device drafts through Netlify Blobs. Hosted draft edits can be recovered after a reload in the same browser tab while waiting for the next cloud save. Thread attachments appear above the body. Real account login and delivery still require validation with an authorized mailbox.

Recipient suggestions in To and Cc come from sender and recipient addresses found in recent IONOS mail, including Sent. Saved-only entries in the separate Webmail Address Book are outside this integration. Use **⌘R** for Reply, **⌘⇧R** for Refresh and **⌘F** for Forward with focus inside the app. Some browser or GHL shortcuts may be intercepted before they reach the iframe. The corresponding controls are available in the reader and IONOS menu.

## Netlify

Import the repository and use the checked-in Netlify settings, `pnpm build`, publish `dist`, and load functions from `netlify/functions`. Run `netlify dev` with the Netlify CLI to exercise `GET /.netlify/functions/sandbox?q=...`. That endpoint only exposes synthetic read-only fixtures. The browser keeps its own sandbox state and does not write to the endpoint. No hosted deployment was performed.

### Optional Groq inbox classification

Set `GROQ_API_KEY` in Netlify under **Production → Functions** and redeploy, or set it in the server's local `.env` for local IONOS. Use a Groq API key with access to `openai/gpt-oss-120b`. Keep it in server environment settings.

On live mailbox load and refresh, the server asks Groq to classify the recent Inbox messages. Groq receives subjects and preview excerpts of up to 1,200 characters with common quoted history removed. The request omits attachment data, mailbox credentials and address fields. Recent results are cached in memory. If the model abstains, the request fails or times out, or the key is absent, the built-in rules supply the category.

### Ask AI and Contact Temperature

Set `GEMINI_API_KEY` in Netlify **Production → Functions**, or in the server's local `.env`. **Ask AI** appears on open emails when either AI key is configured. On submit, the server sends the question, selected subject, and up to 12,000 characters of plain text to Gemini and uses `GROQ_API_KEY` as fallback. [Google AI Studio API keys](https://aistudio.google.com/apikey)

Set `GHL_TEMPERATURE_FIELD_ID` to the HighLevel **Contact** custom field ID for Temperature. Reuse `GHL_CONTACTS_PIT_TOKEN` with `contacts.readonly` and `GHL_CONTACTS_LOCATION_ID` (or a single configured `GHL_LOCATION_IDS` value). On refresh, the Cold, Warm, Hot, and VIP folders filter recent Inbox mail by the sender's matching primary email in that location, without moving messages in IONOS. The field values are matched case-insensitively. [HighLevel Search Contacts](https://marketplace.gohighlevel.com/docs/ghl/contacts/search-contacts-advanced/index.html)

### Enable live IONOS on Netlify

On the standalone sign-in page, select **Remember me** to keep an IONOS session for up to seven days in that browser. Signing out clears the saved session.

Use a repository-connected Netlify deploy so both the build and Functions run. In Netlify, set the following environment variables for the **Functions** scope and redeploy:

| Key | Value |
| --- | --- |
| `A2Z_MODE` | `live` |
| `IONOS_ALLOWED_MAILBOXES` | Comma-separated list of full mailbox addresses approved for sign-in |
| `SESSION_SECRET` | A random secret, e.g. the output of `openssl rand -hex 32` |
| `IONOS_SMTP_PORT` | Optional. Defaults to `465`. Use `587` for required STARTTLS. |

Open the deployed URL and sign in with the IONOS mailbox address and mailbox password. The hosted backend verifies the login via IMAP. The browser holds a short-lived encrypted session token in memory, so reloads require signing in again. The password is entered at sign-in and does not belong in the Netlify environment or GHL URL. The hosted app talks to IONOS directly and needs no PostgreSQL or GHL API credentials.

Compose autosaves hosted drafts as you type. **Save draft** confirms the save and closes Compose. Reopen saved messages from **Drafts** after signing in again. On desktop, Compose opens across the bottom half of the inbox. Drag its title bar to move it. The hosted app saves drafts, attachments, and plain-text signatures in site-wide Netlify Blobs keyed to the signed-in mailbox. They follow the mailbox between HighLevel and the direct mobile site. A saved draft is removed after IONOS accepts the email. Use **Edit signature** in Compose or **IONOS → Email signatures** to customize it and **Attach files** to upload up to 10 files totaling 24 MB per hosted message. Files are staged in 2 MB chunks and passed to IONOS when you send. Slow connections can affect delivery time, and the recipient provider may impose a lower email size limit after encoding. Saved drafts are in A2Z Inbox and are separate from the Webmail Drafts folder. Incoming files can be previewed or downloaded from the reader.

Test with one approved mailbox. Sign in, refresh Inbox, type a known correspondent in To, then send a test message to yourself. Confirm delivery and the copy in Sent. Repeat inside the target HighLevel sub-account. Real Netlify-to-IONOS connectivity and the HighLevel iframe remain unverified.

### Embed the sandbox in HighLevel

Deploy the repository to Netlify as a sandbox, then add its HTTPS URL under HighLevel **Settings → Custom Menu Links** and choose **Open in an Embedded Page (iFrame)**. The Netlify CSP allows `https://app.gohighlevel.com` to frame the sandbox. If your agency uses a white-label hostname, add its exact HTTPS origin to the `frame-ancestors` directive in `netlify.toml`, then redeploy. Avoid adding an additional frame-blocking header such as `X-Frame-Options: SAMEORIGIN`.

Test the menu link in the intended sub-account. Open Command Center, toggle the theme, and save and reopen a draft within the iframe. Browser policies can partition or block storage inside an embed. HighLevel menu visibility controls who sees the link in the sidebar. The Marketplace Custom Page can enable automatic sign-in using the matching HighLevel and IONOS email. Direct mobile and desktop visits keep the IONOS sign-in form. See MARKETPLACE.md for the optional configuration.

## Integration boundary

The mock contracts in `src/adapters.mjs` cover estimate/project lookup, demo attachment manifests, dispatch and ledger mail, existing CRM contact lookup, and read-only assistant views. No external route or credential is assumed. No adapter supports autonomous sending.

`db/001_init.sql` is the initial PostgreSQL migration. `worker/sync.mjs` is a separate experimental ingestion process with TLS, UID/UIDVALIDITY cursors, message key deduplication, expunge markers, paged fetches, IDLE/polling, and reconnect backoff. It exits offline by default. Live worker testing requires an isolated IMAP account, PostgreSQL with the migration applied, and process environment variables from `.env.example`. Both `A2Z_MODE=live` and `A2Z_ENABLE_LIVE=true` are required. Use a secret manager on the worker host; never expose credentials to Vite. The web API refuses live mode.

The worker has not been exercised against IMAP or PostgreSQL, and is not connected to the frontend. It stores raw messages in PostgreSQL; production role checks, signed private object storage, and the other A2Z integrations are unfinished. The loopback IONOS app is separate from the worker and includes its own mail parsing and SMTP transport. The demo paginates rendered rows and uses plain text; it does not implement production list virtualization or ingest real uploads.

Before a live pilot, prioritize end-to-end tests using an isolated mailbox, authenticated user and mailbox access, then streaming attachments into private object storage and connecting the UI to the live API. Validate real adapter contracts before connecting to existing systems.

## Command Center stats for MCP

The hosted inbox exposes a read-only JSON route at `GET /api/mcp/command-center`. Configure `MCP_COMMAND_CENTER_TOKEN` (a random secret of at least 32 characters, such as from `openssl rand -hex 32`) and `MCP_IONOS_EMAIL` in Production → Functions. That mailbox must be in `IONOS_ALLOWED_MAILBOXES`. Set `MCP_IONOS_PASSWORD` only if its IONOS credential is not already in the HighLevel mailbox mapping. Configure your existing MCP server or HTTP tool to use the header `Authorization: Bearer <MCP_COMMAND_CENTER_TOKEN>`.

Example response shape:

```json
{"stats":{"unreadIncoming":6,"bidInvitations":2,"urgentUnread":1,"awaitingReply":5,"unreadInvoiceMail":2},"asOf":"2026-11-17T20:00:00.000Z","coverage":"recent_mail"}
```

The API calculates the same metrics as the Command Center from the configured mailbox's recent messages. It excludes message contents, addresses, and sending controls. It is an HTTP JSON endpoint for an MCP tool to call, not an MCP transport server.

## Attachment and signature support

Open an incoming PDF or supported image from the attachment card for a preview, download, or new tab. Other attachment types can be downloaded. Forward includes the original attachment references and fetches the file bytes from IONOS when sending. If the source message moved, refresh the mailbox and forward from its current folder. The existing 24 MB total applies to all message attachments, including forwarded files. In **Edit signature**, upload a PNG, JPEG, GIF, or WebP image up to 256 KB. It is sent as an inline email image. Plain-text clients see the signature text.

This app remains an IONOS mail client. IONOS administrative and Webmail features such as filters, aliases, calendar, address book sync, and server-side drafts are outside the current build.

## Full mailbox access for MCP

Use a distinct random `MCP_MAIL_TOKEN` for the full feed. Set it in Netlify Production → Functions and in the MCP HTTP tool's bearer credential. The statistics token still has access only to Command Center counts. Both integrations report on the mailbox in `MCP_IONOS_EMAIL`.

| HTTP request | Response |
| --- | --- |
| `GET /api/mcp/mail/folders` | Selectable IMAP folders, including Sent, Drafts, Archive, and any custom folders that exist. |
| `GET /api/mcp/mail/messages?folder=INBOX&limit=25` | Compact rows with a single column list, folder generation, UID checkpoint, and pagination. No bodies or file bytes. |
| `GET /api/mcp/mail/messages?folder=INBOX&limit=25&view=full` | Named envelope fields, flags, reply information, and attachment metadata. |
| `GET /api/mcp/mail/message?id=<URL-encoded id>` | Envelope, attachments, and plain text. Use `format=metadata` to omit the body, `format=html` if needed, and `headers=1` for original headers. |
| `POST /api/mcp/mail/export?id=<URL-encoded id>` | Creates a download ticket for the original EML, including its MIME parts. Add `part=<attachment part>` to export just one attachment. Originals are capped at 96 MB. |
| `GET /api/mcp/mail/chunk?ticket=<ticket>&file=<file>&index=0` | Binary chunk. Read indexes 0 through `chunks - 1` and concatenate the bytes in your connector, outside model context. |
| `DELETE /api/mcp/mail/export?ticket=<ticket>` | Remove the temporary download after reading it. This does not modify the mailbox. |

A compact message row's ID is `folder:uidValidity:uid`. For the initial copy, backfill using `before=<next>&uidValidity=<uidValidity>` until `hasMore` is false. Even an empty page can have `hasMore` when a UID range is sparse. Keep the initial `highWaterUid` as the starting point for new arrivals and use `after=<checkpoint>&uidValidity=<uidValidity>` to poll. When an incremental page has more, continue from its `next`. On the last page advance to its `highWaterUid`. If the API returns 409, rebuild that folder's index. New UID polling does not detect changes to flags on older messages or expunges. Reconcile metadata periodically if your index needs those changes.

Store the full envelope or raw export in your MCP connector if required. Send only the matching subjects and body excerpts to the model. The mailbox feed performs no send, move, mark-read, or delete operations on IONOS.

## Drag and drop and files up to 1 GB

Drop files anywhere on Compose or use the paperclip. Regular attachments keep the 24 MB total limit. When private Cloudflare R2 storage is configured, choosing a file above that limit automatically uses a download link. You can also choose **Add download link** for smaller files. Link uploads support up to 1 GB total and retry a failed upload part once. Recipients receive download links that expire seven days after sending. Anyone with a link can download the file until it expires, so share it only with the intended recipients.

To enable link uploads, create a **private R2 bucket** and a bucket-scoped token with object read and write access. Set `ATTACHMENT_STORAGE_BUCKET`, `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, and `R2_SECRET_ACCESS_KEY` in Netlify Production → Functions. Use a bucket CORS policy like this, replacing the origin if you host Inbox on another domain:

```json
[
  {
    "AllowedOrigins": ["https://a2zemails.netlify.app"],
    "AllowedMethods": ["PUT"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag"]
  }
]
```

Keep the bucket private. Enable lifecycle cleanup for incomplete multipart uploads. If you configure expiry for completed objects, allow at least seven days after sending and sufficient time for saved drafts. Link uploads go straight from the browser to R2. IONOS receives a small email with URLs, and Netlify Functions do not handle the 1 GB file bytes.

## Bcc and HighLevel recipient lookup

To, Cc, and Bcc each accept multiple addresses. Type an address and press Enter, choose a suggestion, or paste addresses separated by commas, semicolons, or newlines. Use **Bcc** in Compose for blind recipients. Bcc is saved with drafts and appears in your Sent copy, while outgoing SMTP uses it only in the delivery envelope. Reply All never adds Bcc recipients.

To enable CRM suggestions in **To**, create a HighLevel **sub-account Private Integration Token** with only `contacts.readonly`. Set `GHL_CONTACTS_PIT_TOKEN` for Production → Functions in Netlify and redeploy. If `GHL_LOCATION_IDS` contains exactly one location, lookup uses it. Otherwise set `GHL_CONTACTS_LOCATION_ID` to the location the PIT belongs to. The app searches that one sub-account for signed-in mailbox users. For embedded HighLevel sessions, their active location must match the configured lookup location. Lookup returns names and email addresses only. If HighLevel is unavailable, mailbox suggestions and manual entry still work. [HighLevel Search Contacts](https://marketplace.gohighlevel.com/docs/ghl/contacts/search-contacts-advanced/index.html)


## MCP Command Center queues and drafts

Use `GET /api/mcp/mail/command-center` with `MCP_MAIL_TOKEN` for the counters, up to five entries per queue, and recent activity. The counts-only endpoint continues to use `MCP_COMMAND_CENTER_TOKEN`.

Set a separate `MCP_MAIL_DRAFT_TOKEN` of at least 32 characters in Production → Functions on both sites. `POST /api/mcp/mail/draft` takes a UUID `id`, a plain-text `body`, and optional `to`, `cc`, `bcc`, and `subject`. The draft is stored in the hosted Inbox app under `MCP_IONOS_EMAIL`. Open **Drafts** while signed in to that mailbox to review it. Repeating the same draft ID and content is safe. A conflicting ID returns HTTP 409.


In the compose window, select an attachment's name to preview a PDF or supported image, or to download other file types. This also works with forwarded files and uploaded attachments in saved drafts. Large files added as download links use a short-lived download URL. The separate Remove button leaves the draft open.

Sent messages and expanded conversation entries show the signature saved with that message, including supported inline signature images. Historical messages need the signature image in their original stored email.


## Trash and message actions

The Inbox uses an ordinary IMAP folder named **A2Z Trash** for newly trashed messages. It appears together with existing IONOS Trash in the app and keeps the new messages recoverable for at least 30 days unless they are deleted manually. A2Z keeps them past 30 days as well. Messages previously moved into IONOS Trash by another client still follow that client's or provider's settings.

Use **Restore message** or the Move menu to recover an email. **Delete forever** asks for confirmation and permanently removes the selected message from Trash when the IMAP server supports targeted UID expunge. Hover over a message row or focus it with the keyboard to **Mark as read** or **Mark as unread** next to Trash.
