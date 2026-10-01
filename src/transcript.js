import { AttachmentBuilder } from "discord.js";
import { escapeHtml } from "./transcript-html.js";

export async function buildTranscript(channel, ticket, limit = 2000) {
  const messages = [];
  let before;
  const safeLimit = Math.max(0, Math.min(Number(limit) || 2000, 2000));
  while (messages.length < safeLimit) {
    const batchLimit = Math.min(100, safeLimit - messages.length);
    const batch = await channel.messages.fetch({ limit: batchLimit, before });
    if (!batch.size) break;
    messages.push(...batch.values());
    before = batch.last()?.id;
    if (batch.size < 100) break;
  }

  messages.reverse();
  const rows = messages.map((message) => {
    const content = message.content || "";
    const attachments = [...message.attachments.values()]
      .map((a) => `<div class="attachment"><a href="${escapeHtml(a.url)}">${escapeHtml(a.name || "attachment")}</a></div>`)
      .join("");
    return `<article><header><strong>${escapeHtml(message.author?.tag || message.author?.username || "Unknown User")}</strong><time>${escapeHtml(new Date(message.createdTimestamp).toISOString())}</time></header><p>${escapeHtml(content).replaceAll("\n", "<br>") || "<em>No text content</em>"}</p>${attachments}</article>`;
  }).join("\n");

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(ticket.ticket_key)} transcript</title>
<style>
body{font-family:Inter,system-ui,sans-serif;background:#111318;color:#e6e7eb;margin:0;padding:32px}
main{max-width:1000px;margin:auto}
header.page{border-bottom:1px solid #2b2f38;padding-bottom:18px;margin-bottom:22px}
article{background:#171a21;border:1px solid #252a33;border-radius:10px;padding:14px 16px;margin:10px 0}
article header{display:flex;justify-content:space-between;gap:16px;color:#9ca3af}
article p{white-space:normal;overflow-wrap:anywhere;line-height:1.5}
a{color:#8ab4ff}
.attachment{margin-top:6px}
</style>
</head>
<body><main>
<header class="page">
<h1>${escapeHtml(ticket.ticket_key)} — ${escapeHtml(ticket.type_label)}</h1>
<p>Owner: ${escapeHtml(ticket.owner_id)} · Created: ${escapeHtml(new Date(ticket.created_at).toISOString())}</p>
</header>
${rows || "<p>No messages were available.</p>"}
</main></body></html>`;

  return {
    buffer: Buffer.from(html, "utf8"),
    fileName: `${ticket.ticket_key.toLowerCase()}-transcript.html`,
    messageCount: messages.length,
  };
}

export function transcriptAttachment(buffer, fileName) {
  return new AttachmentBuilder(buffer, { name: fileName });
}
