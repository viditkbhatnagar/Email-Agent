import { ConfidentialClientApplication } from "@azure/msal-node";
import { Client } from "@microsoft/microsoft-graph-client";
import type { NormalizedEmail, SyncResult, AttachmentMeta } from "@/types";

let msalClient: ConfidentialClientApplication | null = null;

function getMsalClient(): ConfidentialClientApplication {
  if (!msalClient) {
    msalClient = new ConfidentialClientApplication({
      auth: {
        clientId: process.env.AZURE_CLIENT_ID!,
        clientSecret: process.env.AZURE_CLIENT_SECRET!,
        authority: "https://login.microsoftonline.com/common",
      },
    });
  }
  return msalClient;
}

function getGraphClient(accessToken: string): Client {
  return Client.init({
    authProvider: (done) => {
      done(null, accessToken);
    },
  });
}

export async function refreshOutlookToken(
  refreshToken: string
): Promise<{ accessToken: string; expiresAt: Date }> {
  const client = getMsalClient();
  const result = await client.acquireTokenByRefreshToken({
    refreshToken,
    scopes: [
      "https://graph.microsoft.com/Mail.Read",
      "https://graph.microsoft.com/Mail.Send",
    ],
  });

  if (!result) {
    throw new Error("Failed to refresh Outlook token");
  }

  return {
    accessToken: result.accessToken,
    expiresAt: result.expiresOn!,
  };
}

interface GraphMessage {
  id: string;
  conversationId?: string;
  from?: {
    emailAddress?: { address?: string; name?: string };
  };
  toRecipients?: Array<{
    emailAddress?: { address?: string; name?: string };
  }>;
  ccRecipients?: Array<{
    emailAddress?: { address?: string; name?: string };
  }>;
  subject?: string;
  bodyPreview?: string;
  body?: { content?: string; contentType?: string };
  receivedDateTime?: string;
  isRead?: boolean;
  hasAttachments?: boolean;
  categories?: string[];
  attachments?: Array<{
    name?: string;
    contentType?: string;
    size?: number;
  }>;
  internetMessageHeaders?: Array<{
    name?: string;
    value?: string;
  }>;
}

interface GraphDeltaResponse {
  value: GraphMessage[];
  "@odata.nextLink"?: string;
  "@odata.deltaLink"?: string;
}

function getOutlookHeader(
  headers: Array<{ name?: string; value?: string }> | undefined,
  name: string
): string {
  if (!headers) return "";
  const header = headers.find(
    (h) => h.name?.toLowerCase() === name.toLowerCase()
  );
  return header?.value ?? "";
}

function detectOutlookMailingList(
  headers: Array<{ name?: string; value?: string }> | undefined
): { isMailingList: boolean; listId?: string } {
  const listId = getOutlookHeader(headers, "List-Id");
  if (listId) return { isMailingList: true, listId };
  if (getOutlookHeader(headers, "List-Unsubscribe")) return { isMailingList: true };
  const precedence = getOutlookHeader(headers, "Precedence").toLowerCase();
  if (precedence === "bulk" || precedence === "list") return { isMailingList: true };
  return { isMailingList: false };
}

function normalizeOutlookMessage(msg: GraphMessage): NormalizedEmail {
  const attachments: AttachmentMeta[] | undefined = msg.attachments
    ?.map((a) => ({
      filename: a.name || "unknown",
      mimeType: a.contentType || "application/octet-stream",
      size: a.size,
    }));

  const mailingList = detectOutlookMailingList(msg.internetMessageHeaders);

  return {
    externalId: msg.id,
    threadId: msg.conversationId,
    from: msg.from?.emailAddress?.address ?? "",
    fromName: msg.from?.emailAddress?.name,
    to:
      msg.toRecipients?.map((r) => r.emailAddress?.address ?? "").filter(Boolean) ??
      [],
    cc:
      msg.ccRecipients?.map((r) => r.emailAddress?.address ?? "").filter(Boolean) ??
      [],
    subject: msg.subject ?? "",
    snippet: msg.bodyPreview,
    bodyText:
      msg.body?.contentType === "text" ? msg.body?.content : undefined,
    bodyHtml:
      msg.body?.contentType === "html" ? msg.body?.content : undefined,
    receivedAt: msg.receivedDateTime
      ? new Date(msg.receivedDateTime)
      : new Date(),
    isRead: msg.isRead ?? false,
    hasAttachments: msg.hasAttachments ?? false,
    attachments: attachments && attachments.length > 0 ? attachments : undefined,
    labels: ["INBOX", ...(msg.categories ?? [])],
    isMailingList: mailingList.isMailingList,
    listId: mailingList.listId,
  };
}

export async function fetchOutlookEmails(
  accessToken: string,
  refreshToken: string,
  syncCursor?: string | null
): Promise<SyncResult> {
  // Refresh token if needed
  let currentToken = accessToken;
  try {
    const refreshed = await refreshOutlookToken(refreshToken);
    currentToken = refreshed.accessToken;
  } catch {
    // Use existing token, it might still be valid
    console.log("Token refresh failed, using existing token");
  }

  const client = getGraphClient(currentToken);
  const emails: NormalizedEmail[] = [];

  if (syncCursor) {
    // Delta sync
    try {
      let nextLink: string | undefined = syncCursor;
      let deltaLink: string | undefined;

      while (nextLink) {
        const response: GraphDeltaResponse = await client
          .api(nextLink)
          .get();

        for (const msg of response.value) {
          try {
            emails.push(normalizeOutlookMessage(msg));
          } catch (err) {
            console.error(`[Outlook] Failed to normalize message ${msg.id}: ${err instanceof Error ? err.message : err}`);
          }
        }

        nextLink = response["@odata.nextLink"];
        deltaLink = response["@odata.deltaLink"];
      }

      return {
        emails,
        newSyncCursor: deltaLink ?? syncCursor,
      };
    } catch (err) {
      console.error("Delta sync failed, falling back to full sync:", err);
      return fetchOutlookEmails(currentToken, refreshToken);
    }
  }

  // Full sync: fetch last 30 days
  const thirtyDaysAgo = new Date(
    Date.now() - 30 * 24 * 60 * 60 * 1000
  ).toISOString();

  let nextLink: string | undefined =
    `/me/mailFolders/inbox/messages/delta?$filter=receivedDateTime ge ${thirtyDaysAgo}&$select=id,conversationId,from,toRecipients,ccRecipients,subject,bodyPreview,body,receivedDateTime,isRead,hasAttachments,categories,internetMessageHeaders&$expand=attachments($select=name,contentType,size)&$top=50`;
  let deltaLink: string | undefined;

  while (nextLink) {
    const response: GraphDeltaResponse = await client.api(nextLink).get();

    for (const msg of response.value) {
      try {
        emails.push(normalizeOutlookMessage(msg));
      } catch (err) {
        console.error(`[Outlook] Failed to normalize message ${msg.id}: ${err instanceof Error ? err.message : err}`);
      }
    }

    nextLink = response["@odata.nextLink"];
    deltaLink = response["@odata.deltaLink"];
  }

  return {
    emails,
    newSyncCursor: deltaLink,
  };
}
