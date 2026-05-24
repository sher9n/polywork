// Email notification helper with optional Resend integration.
//
// Behavior:
//   - Always writes to notification_log table
//   - If POLYWORK_EMAIL_ENABLED=true AND RESEND_API_KEY is set, also sends
//   - Otherwise dry-run (logged but not sent)
//
// Usage:
//   await notify(sql, { subject, body, recipient? })

import type { Sql } from "postgres";

const RESEND_API_URL = "https://api.resend.com/emails";

export type NotifyOptions = {
  subject: string;
  body: string;
  recipient?: string;       // overrides POLYWORK_EMAIL_TO
  channel?: "email" | "log";
};

export async function notify(sql: Sql, opts: NotifyOptions): Promise<{ id: number; sent: boolean; error?: string }> {
  const channel = opts.channel ?? "email";
  const recipient = opts.recipient ?? process.env.POLYWORK_EMAIL_TO ?? null;
  const ts = Date.now();
  const enabled = process.env.POLYWORK_EMAIL_ENABLED === "true";
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.POLYWORK_EMAIL_FROM ?? "polywork@localhost";

  let sent = false;
  let error: string | null = null;

  if (channel === "email" && enabled && apiKey && recipient) {
    try {
      const resp = await fetch(RESEND_API_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from, to: recipient, subject: opts.subject, text: opts.body }),
      });
      if (resp.ok) {
        sent = true;
      } else {
        error = `Resend HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`;
      }
    } catch (e) {
      error = `Resend exception: ${(e as Error).message}`;
    }
  } else if (channel === "email" && !enabled) {
    error = "email disabled (POLYWORK_EMAIL_ENABLED != 'true')";
  } else if (channel === "email" && !apiKey) {
    error = "no RESEND_API_KEY configured";
  } else if (channel === "email" && !recipient) {
    error = "no recipient (set POLYWORK_EMAIL_TO or pass recipient)";
  }

  const rows = await sql<Array<{ id: number }>>`
    INSERT INTO notification_log (ts, channel, subject, body, sent, recipient, error)
    VALUES (${ts}, ${channel}, ${opts.subject}, ${opts.body}, ${sent}, ${recipient}, ${error})
    RETURNING id
  `;
  return { id: rows[0].id, sent, error: error ?? undefined };
}
