// Minimal email sender. Uses Resend (https://resend.com) if RESEND_API_KEY
// is set — just one HTTP call, no SDK needed. Without a key, it logs the
// email to the server console instead, so password reset (and anything
// else built on this later) works and is fully testable before you've
// signed up for an email provider.

// Turns the HTML body into a readable console line — importantly, this
// keeps link URLs (as "text (url)") instead of just discarding them, since
// the whole point of the console fallback is being able to grab the link.
function htmlToPlainText(html) {
  return html
    .replace(/<a\s+[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gi, '$2 ($1)')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function logToConsole(to, subject, html) {
  console.log(`\n[mailer] To: ${to}\n[mailer] Subject: ${subject}\n[mailer] ${htmlToPlainText(html)}\n`);
}

async function sendEmail({ to, subject, html }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.log('[mailer] No RESEND_API_KEY set — logging email instead of sending it.');
    logToConsole(to, subject, html);
    return { delivered: false };
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: process.env.RESEND_FROM || 'Fleet Priority <onboarding@resend.dev>',
        to,
        subject,
        html,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error('[mailer] Resend API error:', res.status, body);
      console.log('[mailer] Falling back to console log.');
      logToConsole(to, subject, html);
      return { delivered: false };
    }
    return { delivered: true };
  } catch (err) {
    console.error('[mailer] Failed to reach Resend:', err.message);
    console.log('[mailer] Falling back to console log.');
    logToConsole(to, subject, html);
    return { delivered: false };
  }
}

function sendPasswordResetEmail(to, resetUrl) {
  return sendEmail({
    to,
    subject: 'Reset your Fleet Priority password',
    html: `
      <p>Someone (hopefully you) asked to reset the password on your Fleet Priority account.</p>
      <p><a href="${resetUrl}">Click here to set a new password</a>. This link expires in 1 hour.</p>
      <p>If you didn't request this, you can safely ignore this email — your password won't change.</p>
    `,
  });
}

module.exports = { sendEmail, sendPasswordResetEmail };
