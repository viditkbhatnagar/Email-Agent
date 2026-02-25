import { prisma } from "@/lib/prisma";
import { fetchGmailEmails, refreshGmailToken } from "@/lib/gmail";
import { fetchOutlookEmails, refreshOutlookToken } from "@/lib/outlook";
import type { NormalizedEmail } from "@/types";

async function ensureValidToken(
  accountId: string,
  provider: string,
  accessToken: string,
  refreshToken: string,
  expiresAt: Date | null
): Promise<string> {
  // If token hasn't expired yet, use it
  if (expiresAt && expiresAt > new Date(Date.now() + 5 * 60 * 1000)) {
    return accessToken;
  }

  // Refresh the token
  try {
    let newToken: { accessToken: string; expiresAt: Date };

    if (provider === "gmail") {
      newToken = await refreshGmailToken(refreshToken);
    } else {
      newToken = await refreshOutlookToken(refreshToken);
    }

    // Update in database
    await prisma.emailAccount.update({
      where: { id: accountId },
      data: {
        accessToken: newToken.accessToken,
        expiresAt: newToken.expiresAt,
      },
    });

    return newToken.accessToken;
  } catch (error) {
    console.error(`Token refresh failed for ${provider} account ${accountId}:`, error);
    // Return existing token as fallback
    return accessToken;
  }
}

export async function syncEmailAccount(
  emailAccountId: string,
  forceFullSync = false
): Promise<{ fetched: number; errors: number }> {
  const account = await prisma.emailAccount.findUnique({
    where: { id: emailAccountId },
  });

  if (!account || !account.isActive) {
    return { fetched: 0, errors: 0 };
  }

  // Ensure we have a valid token
  const validToken = await ensureValidToken(
    account.id,
    account.provider,
    account.accessToken,
    account.refreshToken,
    account.expiresAt
  );

  // Fetch emails from provider
  let emails: NormalizedEmail[] = [];
  let newSyncCursor: string | undefined;

  console.log(`[Sync] Fetching emails for ${account.provider} account ${account.email}...`);

  try {
    if (account.provider === "gmail") {
      const result = await fetchGmailEmails(
        validToken,
        account.refreshToken,
        forceFullSync ? null : account.syncCursor
      );
      emails = result.emails;
      newSyncCursor = result.newSyncCursor;
    } else if (account.provider === "outlook") {
      const result = await fetchOutlookEmails(
        validToken,
        account.refreshToken,
        forceFullSync ? null : account.syncCursor
      );
      emails = result.emails;
      newSyncCursor = result.newSyncCursor;
    }
    console.log(`[Sync] Fetched ${emails.length} emails from ${account.provider}`);
  } catch (error) {
    console.error(`[Sync] Failed to fetch emails for ${account.email}:`, error);
    return { fetched: 0, errors: 1 };
  }

  // Store emails in database (upsert to handle duplicates)
  let stored = 0;
  let errors = 0;

  for (const email of emails) {
    try {
      await prisma.email.upsert({
        where: {
          accountId_externalId: {
            accountId: emailAccountId,
            externalId: email.externalId,
          },
        },
        create: {
          accountId: emailAccountId,
          externalId: email.externalId,
          threadId: email.threadId,
          from: email.from,
          fromName: email.fromName,
          to: email.to,
          cc: email.cc,
          subject: email.subject,
          snippet: email.snippet,
          bodyText: email.bodyText,
          bodyHtml: email.bodyHtml,
          receivedAt: email.receivedAt,
          isRead: email.isRead,
          hasAttachments: email.hasAttachments,
          attachments: email.attachments ? (email.attachments as object[]) : undefined,
          labels: email.labels,
          isMailingList: email.isMailingList ?? false,
          listId: email.listId,
        },
        update: {
          isRead: email.isRead,
          labels: email.labels,
          receivedAt: email.receivedAt,
          isMailingList: email.isMailingList ?? false,
          listId: email.listId,
        },
      });
      stored++;
    } catch (error) {
      console.error(`Failed to store email ${email.externalId}:`, error);
      errors++;
    }
  }

  // Update sync cursor and last sync time
  await prisma.emailAccount.update({
    where: { id: emailAccountId },
    data: {
      syncCursor: newSyncCursor ?? account.syncCursor,
      lastSyncAt: new Date(),
    },
  });

  return { fetched: stored, errors };
}

export async function syncAllAccounts(
  userId: string,
  forceFullSync = false
): Promise<{ totalFetched: number; totalErrors: number; accountResults: Record<string, { fetched: number; errors: number }> }> {
  const accounts = await prisma.emailAccount.findMany({
    where: { userId, isActive: true },
  });

  let totalFetched = 0;
  let totalErrors = 0;
  const accountResults: Record<string, { fetched: number; errors: number }> = {};

  for (const account of accounts) {
    try {
      const result = await syncEmailAccount(account.id, forceFullSync);
      totalFetched += result.fetched;
      totalErrors += result.errors;
      accountResults[account.email] = result;
    } catch (error) {
      console.error(`Sync failed for account ${account.email}:`, error);
      totalErrors++;
      accountResults[account.email] = { fetched: 0, errors: 1 };
    }
  }

  return { totalFetched, totalErrors, accountResults };
}
