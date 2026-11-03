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
2. Render reads `render.yaml` and creates the web service and the database.
3. When asked, paste the Resend API key into `RESEND_API_KEY`.
4. Click **Apply**. The first deploy takes a few minutes.

### 4. First sign-in
1. Open the app's URL (shown in Render, e.g. `https://facility-check.onrender.com`).
2. Create the admin account. The standard 55-point checklist is loaded for you.
3. In **Setup**:
   - Add warehouses and managers.
   - Under **Email > Sender**, enter the sender name and `facilities@storage.ae`, save, and click **Send test email**.
   - Under **Users**, add each supervisor with a temporary password and share it with them.

### Costs and limits on Render
- **Database:** the blueprint uses the `basic-256mb` plan (about $6/month). Free Render databases are deleted after 30 days.
- **Web service:** free works, but it sleeps after 15 minutes idle, so the first visit takes about a minute to wake.
  Upgrade to **Starter** (about $7/month) to keep it always on.
- **Photos:** resized to about 200 KB on the phone before upload and stored in the database. 1 GB is roughly 5,000 photos.

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
