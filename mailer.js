/*
 * Sends email through one of:
 *   - Resend (HTTPS API): set RESEND_API_KEY. Works on hosts that block SMTP ports.
 *   - SMTP (Google Workspace, Microsoft 365, SendGrid, Mailgun...): set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS.
 * The "from" address comes from Setup (Sender email). The provider must allow sending from it.
 */
let transporter = null;

function provider() {
  if (process.env.RESEND_API_KEY) return 'resend';
  if (process.env.SMTP_HOST) return 'smtp';
  return null;
}

function smtp() {
  if (!transporter) {
    const nodemailer = require('nodemailer');
    const port = Number(process.env.SMTP_PORT || 587);
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port,
      secure: process.env.SMTP_SECURE ? process.env.SMTP_SECURE === 'true' : port === 465,
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined
    });
  }
  return transporter;
}

const fmtFrom = (name, email) => name ? `"${String(name).replace(/["\\\r\n]/g, '')}" <${email}>` : email;

async function sendMail({ fromName, fromEmail, replyTo, to, subject, html, text, attachments }) {
  const p = provider();
  if (!p) throw new Error('No email provider is configured on the server. Set RESEND_API_KEY or SMTP_HOST.');
  if (!fromEmail) throw new Error('No sender email is set. Add one in Setup.');
  const from = fmtFrom(fromName, fromEmail);

  if (p === 'resend') {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from, to: [to], subject, html, text,
        reply_to: replyTo || undefined,
        attachments: (attachments || []).map(a => ({ filename: a.filename, content: Buffer.from(a.content).toString('base64') }))
      })
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Resend refused the email (${res.status}): ${body.slice(0, 300)}`);
    }
    return;
  }

  await smtp().sendMail({ from, to, replyTo: replyTo || undefined, subject, html, text, attachments });
}

module.exports = { sendMail, provider };
