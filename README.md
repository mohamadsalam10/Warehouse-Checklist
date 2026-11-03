# Facility Check

Weekly warehouse inspections for storage.ae. Supervisors fill in a checklist for each warehouse
(Pass / Fail / N/A, notes, severity, photos). When the last active warehouse for a week is submitted,
the server emails every manager a summary of their warehouses, with photos and the full report attached.

- **Admin**: sets up warehouses, managers (report recipients), users, the sender email and the checklist.
- **Supervisor**: signs in with email and password and fills in the weekly checklists.
- **Managers**: don't need an account. They just receive the email.

Node.js + Express + Postgres. No build step.

---

## Deploy on Render (about 15 minutes)

### 1. Put the code on GitHub
Create a private repository and push this folder to it.

### 2. Set up email (Resend)
Render's free web services block SMTP, so the app sends through Resend's HTTPS API.

1. Create an account at resend.com.
2. **Domains > Add domain** > `storage.ae`. Add the DNS records Resend shows you
   (ask whoever manages the storage.ae DNS). Wait until it shows **Verified**.
3. **API Keys > Create API key** (sending access). Copy it.

Any address at the verified domain can be the sender, e.g. `facilities@storage.ae`.

### 3. Create the app on Render
1. Render dashboard > **New > Blueprint** > choose your repository.
2. Render reads `render.yaml` and creates the web service and the database, both on free plans.
3. When asked, paste the Resend API key into `RESEND_API_KEY`.
4. Click **Apply**. The first deploy takes a few minutes.

### 4. First sign-in
1. Open the app's URL (shown in Render, e.g. `https://facility-check.onrender.com`).
2. Create the admin account. The standard 55-point checklist is loaded for you.
3. In **Setup**:
   - Add warehouses and managers.
   - Under **Email > Sender**, enter the sender name and `facilities@storage.ae`, save, and click **Send test email**.
   - Under **Users**, add each supervisor with a temporary password and share it with them.

### Free plan limits on Render
The blueprint uses Render's free plans, so it costs nothing, with these limits:
- **The free database is deleted 30 days after it's created.** Before then, either upgrade it
  (Render > facility-check-db > Upgrade, about $6/month, data kept) or move the app to another server
  (see "Moving to another server" below).
- **The web service sleeps after 15 minutes idle,** so the first visit takes about a minute to wake.
- **Email must use Resend;** free web services block SMTP.
- **One free database per Render workspace.** If you already have one, set `plan: basic-256mb` in render.yaml.

Render may still ask for a card to verify your account. It places a $1 hold that is cancelled straight away.

### Moving to another server
All data lives in the Postgres database: inspections, photos, users and settings. To keep it:
1. In Render, open facility-check-db > Info and copy the **External Database URL**.
2. On any computer with Postgres tools, run:
   `pg_dump "EXTERNAL_DATABASE_URL" -Fc -f facility-check.dump`
3. On the new server, create a Postgres database and run:
   `pg_restore -d "NEW_DATABASE_URL" --no-owner facility-check.dump`
4. Deploy the app there with `DATABASE_URL` pointing to the new database, and the same `SESSION_SECRET`
   (copy it from Render > facility-check > Environment) so email photo links keep working.

---

## Using SMTP instead of Resend
Works on paid Render instances or any host that allows outbound SMTP. Remove `RESEND_API_KEY` and set:

| Variable | Example |
|---|---|
| `SMTP_HOST` | `smtp.gmail.com` (Google Workspace) or `smtp.office365.com` |
| `SMTP_PORT` | `587` |
| `SMTP_USER` | `facilities@storage.ae` |
| `SMTP_PASS` | an app password for that mailbox |

With Google Workspace or Microsoft 365, the sender email in Setup must be that mailbox (or an alias it can send as).

## All environment variables

| Variable | Required | What it does |
|---|---|---|
| `DATABASE_URL` | yes | Postgres connection string |
| `SESSION_SECRET` | yes | Long random string; keeps sign-ins and email photo links valid across restarts |
| `RESEND_API_KEY` | one email option | Send through Resend |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` | one email option | Send through SMTP |
| `APP_URL` | no | Public URL for links in emails. Render sets `RENDER_EXTERNAL_URL` automatically, so leave this out there |
| `MAIL_FROM` | no | Default sender if none is set in Setup |
| `DATABASE_SSL` | no | `true` / `false` to force SSL on the database connection |

## Other hosts
Railway, Fly.io, a VPS or anything that runs Node 18+: create a Postgres database, set the variables above, run `npm ci` then `npm start`.
The app creates its tables on first start.

## Run locally
```
npm install
cp .env.example .env    # fill in DATABASE_URL at least
export $(grep -v '^#' .env | xargs) && npm start
```
Open http://localhost:3000.

## How sending works
- The send is triggered by the final submit, so it doesn't depend on a schedule or on anyone keeping a page open.
- Each manager gets one email covering only the warehouses assigned to them in Setup.
- A week is sent automatically once. If an inspection is reopened and resubmitted, it isn't sent again; an admin can use **Resend to managers** on the Reports page.
- If sending fails (for example the sender domain isn't verified), Reports shows the error and an admin can click **Send now** after fixing it.
- Photos in the email body load through signed links, so managers can see them without signing in.
  The attached HTML report has every photo embedded (skipped if the photos exceed 15 MB in total).
