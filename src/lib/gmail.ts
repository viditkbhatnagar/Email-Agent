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

async function fetchMessagesWithRetry(
  gmail: ReturnType<typeof google.gmail>,
  messageIds: string[],
  chunkSize = 10
): Promise<NormalizedEmail[]> {
  const emails: NormalizedEmail[] = [];
  const failedIds: string[] = [];

  for (let i = 0; i < messageIds.length; i += chunkSize) {
    const chunk = messageIds.slice(i, i + chunkSize);
    const results = await Promise.allSettled(
      chunk.map((msgId) =>
        gmail.users.messages.get({ userId: "me", id: msgId, format: "full" })
      )
    );
    for (let j = 0; j < results.length; j++) {
      const result = results[j];
      if (result.status === "fulfilled") {
        const normalized = normalizeGmailMessage(result.value.data);
        if (normalized) emails.push(normalized);
      } else {
        failedIds.push(chunk[j]);
        console.warn(
          `[Gmail] Failed to fetch message ${chunk[j]}: ${result.reason?.message ?? result.reason}`
        );
      }
    }
  }

  if (failedIds.length > 0) {
    console.log(`[Gmail] Retrying ${failedIds.length} failed message fetches...`);
    for (const msgId of failedIds) {
      try {
        const res = await gmail.users.messages.get({
          userId: "me",
          id: msgId,
          format: "full",
        });
        const normalized = normalizeGmailMessage(res.data);
        if (normalized) emails.push(normalized);
        console.log(`[Gmail] Retry succeeded for message ${msgId}`);
      } catch (retryErr: unknown) {
        const errMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
        console.error(`[Gmail] Permanent failure for message ${msgId} after retry: ${errMsg}`);
      }
    }
  }

  return emails;
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

      const incrementalEmails = await fetchMessagesWithRetry(gmail, [...messageIds]);
      emails.push(...incrementalEmails);

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

    const chunkIds = messages.map((m) => m.id!).filter(Boolean);
    const pageEmails = await fetchMessagesWithRetry(gmail, chunkIds);
    emails.push(...pageEmails);

    console.log(`[Gmail] Fetched ${emails.length} emails so far`);
    pageToken = listRes.data.nextPageToken ?? undefined;
  } while (pageToken);

  return { emails, newSyncCursor };
}

function detectMailingList(
  headers: { name?: string | null; value?: string | null }[] | undefined
): { isMailingList: boolean; listId?: string } {
  const listId = getHeader(headers, "List-Id");
  if (listId) return { isMailingList: true, listId };
  if (getHeader(headers, "List-Unsubscribe")) return { isMailingList: true };
  const precedence = getHeader(headers, "Precedence").toLowerCase();
  if (precedence === "bulk" || precedence === "list") return { isMailingList: true };
  if (getHeader(headers, "X-Campaign-Id") || getHeader(headers, "X-Mailer-RecptId")) {
    return { isMailingList: true };
  }
  return { isMailingList: false };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function normalizeGmailMessage(msg: any): NormalizedEmail | null {
  if (!msg.id) return null;

  const headers = msg.payload?.headers;
  const fromRaw = getHeader(headers, "From");
  const parsed = parseEmailAddress(fromRaw);
  const { text, html, attachments, hasAttachments } = extractEmailContent(msg.payload);
  const mailingList = detectMailingList(headers);

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
    isMailingList: mailingList.isMailingList,
    listId: mailingList.listId,
  };
}
