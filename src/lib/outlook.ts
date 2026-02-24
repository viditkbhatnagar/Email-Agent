import { ConfidentialClientApplication } from "@azure/msal-node";
import { Client } from "@microsoft/microsoft-graph-client";
import type { NormalizedEmail, SyncResult } from "@/types";

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
}

interface GraphDeltaResponse {
  value: GraphMessage[];
  "@odata.nextLink"?: string;
  "@odata.deltaLink"?: string;
}

function normalizeOutlookMessage(msg: GraphMessage): NormalizedEmail {
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
    labels: msg.categories ?? [],
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
          emails.push(normalizeOutlookMessage(msg));
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
    `/me/mailFolders/inbox/messages/delta?$filter=receivedDateTime ge ${thirtyDaysAgo}&$select=id,conversationId,from,toRecipients,ccRecipients,subject,bodyPreview,body,receivedDateTime,isRead,hasAttachments,categories&$top=50`;
  let deltaLink: string | undefined;

  while (nextLink) {
    const response: GraphDeltaResponse = await client.api(nextLink).get();

    for (const msg of response.value) {
      emails.push(normalizeOutlookMessage(msg));
    }

    nextLink = response["@odata.nextLink"];
    deltaLink = response["@odata.deltaLink"];
  }

  return {
    emails,
    newSyncCursor: deltaLink,
  };
}
