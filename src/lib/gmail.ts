import { google } from "googleapis";
import type { NormalizedEmail, SyncResult, AttachmentMeta } from "@/types";

function getOAuth2Client(accessToken: string, refreshToken: string) {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
  );
  oauth2Client.setCredentials({
    access_token: accessToken,
    refresh_token: refreshToken,
  });
  return oauth2Client;
}

function decodeBase64Url(data: string): string {
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8");
}

function extractEmailContent(
  payload: { mimeType?: string; body?: { data?: string; attachmentId?: string; size?: number }; filename?: string; parts?: unknown[] } | undefined
): { text: string; html: string; attachments: AttachmentMeta[]; hasAttachments: boolean } {
  let text = "";
  let html = "";
  const attachments: AttachmentMeta[] = [];

  if (!payload) return { text, html, attachments, hasAttachments: false };

  interface Part {
    mimeType?: string;
    body?: { data?: string; attachmentId?: string; size?: number };
    filename?: string;
    parts?: Part[];
  }

  function traverse(part: Part) {
    if (part.filename && part.filename.length > 0) {
      attachments.push({
        filename: part.filename,
        mimeType: part.mimeType || "application/octet-stream",
        size: part.body?.size,
      });
    } else if (part.mimeType === "text/plain" && part.body?.data) {
      text = decodeBase64Url(part.body.data);
    } else if (part.mimeType === "text/html" && part.body?.data) {
      html = decodeBase64Url(part.body.data);
    }
    if (part.parts) {
      for (const p of part.parts) {
        traverse(p);
      }
    }
  }

  traverse(payload as Part);
  return { text, html, attachments, hasAttachments: attachments.length > 0 };
}

function getHeader(
  headers: { name?: string | null; value?: string | null }[] | undefined,
  name: string
): string {
  if (!headers) return "";
  const header = headers.find(
    (h) => h.name?.toLowerCase() === name.toLowerCase()
  );
  return header?.value ?? "";
}

function parseEmailAddress(raw: string): { email: string; name?: string } {
  const match = raw.match(/^(.+?)\s*<(.+?)>$/);
  if (match) {
    return { name: match[1].replace(/"/g, "").trim(), email: match[2].trim() };
  }
  return { email: raw.trim() };
}

function parseEmailList(raw: string): string[] {
  if (!raw) return [];
  return raw.split(",").map((e) => {
    const parsed = parseEmailAddress(e.trim());
    return parsed.email;
  });
}

export async function refreshGmailToken(
  refreshToken: string
): Promise<{ accessToken: string; expiresAt: Date }> {
  const oauth2Client = getOAuth2Client("", refreshToken);
  const { credentials } = await oauth2Client.refreshAccessToken();
  return {
    accessToken: credentials.access_token!,
    expiresAt: new Date(credentials.expiry_date!),
  };
}

export async function fetchGmailEmails(
  accessToken: string,
  refreshToken: string,
  syncCursor?: string | null
): Promise<SyncResult> {
  const oauth2Client = getOAuth2Client(accessToken, refreshToken);
  const gmail = google.gmail({ version: "v1", auth: oauth2Client });
  const emails: NormalizedEmail[] = [];

  if (syncCursor) {
    // Incremental sync using history (with pagination)
    try {
      const messageIds = new Set<string>();
      let historyPageToken: string | undefined;
      let latestHistoryId: string | undefined;

      do {
        const historyRes = await gmail.users.history.list({
          userId: "me",
          startHistoryId: syncCursor,
          historyTypes: ["messageAdded"],
          maxResults: 500,
          pageToken: historyPageToken,
        });

        latestHistoryId = historyRes.data.historyId ?? latestHistoryId;

        for (const h of historyRes.data.history ?? []) {
          for (const m of h.messagesAdded ?? []) {
            if (m.message?.id) {
              messageIds.add(m.message.id);
            }
          }
        }

        historyPageToken = historyRes.data.nextPageToken ?? undefined;
      } while (historyPageToken);

      console.log(`[Gmail] Incremental sync found ${messageIds.size} new messages`);

      for (const msgId of messageIds) {
        try {
          const msg = await gmail.users.messages.get({
            userId: "me",
            id: msgId,
            format: "full",
          });
          const normalized = normalizeGmailMessage(msg.data);
          if (normalized) emails.push(normalized);
        } catch (err) {
          console.error(`Failed to fetch Gmail message ${msgId}:`, err);
        }
      }

      return {
        emails,
        newSyncCursor: latestHistoryId ?? syncCursor,
      };
    } catch (err: unknown) {
      // If history is invalid (e.g., too old), fall back to full sync
      const error = err as { code?: number };
      if (error.code === 404) {
        console.log("History too old, falling back to full sync");
        return fetchGmailEmails(accessToken, refreshToken);
      }
      throw err;
    }
  }

  // Full sync: fetch last 30 days
  // Capture historyId BEFORE listing so we don't miss emails that arrive during sync
  const profile = await gmail.users.getProfile({ userId: "me" });
  const newSyncCursor = profile.data.historyId ?? undefined;

  let pageToken: string | undefined;
  const thirtyDaysAgo = Math.floor(
    (Date.now() - 30 * 24 * 60 * 60 * 1000) / 1000
  );

  console.log("[Gmail] Starting full sync (last 30 days)...");

  do {
    const listRes = await gmail.users.messages.list({
      userId: "me",
      maxResults: 100,
      pageToken,
      q: `after:${thirtyDaysAgo}`,
    });

    const messages = listRes.data.messages ?? [];
    console.log(`[Gmail] Listed ${messages.length} messages (total so far: ${emails.length})`);

    for (const m of messages) {
      try {
        const msg = await gmail.users.messages.get({
          userId: "me",
          id: m.id!,
          format: "full",
        });
        const normalized = normalizeGmailMessage(msg.data);
        if (normalized) emails.push(normalized);
      } catch (err) {
        console.error(`[Gmail] Failed to fetch message ${m.id}:`, err);
      }
    }

    console.log(`[Gmail] Fetched ${emails.length} emails so far`);
    pageToken = listRes.data.nextPageToken ?? undefined;
  } while (pageToken);

  return { emails, newSyncCursor };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function normalizeGmailMessage(msg: any): NormalizedEmail | null {
  if (!msg.id) return null;

  const headers = msg.payload?.headers;
  const fromRaw = getHeader(headers, "From");
  const parsed = parseEmailAddress(fromRaw);
  const { text, html, attachments, hasAttachments } = extractEmailContent(msg.payload);

  return {
    externalId: msg.id,
    threadId: msg.threadId ?? undefined,
    from: parsed.email,
    fromName: parsed.name,
    to: parseEmailList(getHeader(headers, "To")),
    cc: parseEmailList(getHeader(headers, "Cc")),
    subject: getHeader(headers, "Subject"),
    snippet: msg.snippet ?? undefined,
    bodyText: text || undefined,
    bodyHtml: html || undefined,
    receivedAt: msg.internalDate
      ? new Date(parseInt(msg.internalDate))
      : new Date(),
    isRead: !(msg.labelIds ?? []).includes("UNREAD"),
    hasAttachments,
    attachments: attachments.length > 0 ? attachments : undefined,
    labels: msg.labelIds ?? [],
  };
}
