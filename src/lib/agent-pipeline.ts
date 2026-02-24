import { prisma } from "@/lib/prisma";
import { syncAllAccounts } from "@/lib/email-sync";
import { classifyEmails } from "@/lib/classifier";
import type {
  ClassificationInput,
  ThreadContext,
  SenderContext,
  AttachmentMeta,
} from "@/types";

const MAX_EMAILS_PER_RUN = 500;

async function updateSenderProfiles(
  userId: string,
  emails: { from: string; fromName: string | null; receivedAt: Date }[]
): Promise<void> {
  const bySender = new Map<string, typeof emails>();
  for (const e of emails) {
    const arr = bySender.get(e.from) || [];
    arr.push(e);
    bySender.set(e.from, arr);
  }

  for (const [senderEmail, senderEmails] of bySender) {
    const latestDate = senderEmails.reduce(
      (max, e) => (e.receivedAt > max ? e.receivedAt : max),
      new Date(0)
    );
    const firstName = senderEmails.find((e) => e.fromName)?.fromName ?? null;

    try {
      await prisma.senderProfile.upsert({
        where: {
          userId_senderEmail: { userId, senderEmail },
        },
        create: {
          userId,
          senderEmail,
          senderName: firstName,
          totalEmails: senderEmails.length,
          lastEmailAt: latestDate,
        },
        update: {
          senderName: firstName ?? undefined,
          totalEmails: { increment: senderEmails.length },
          lastEmailAt: latestDate,
        },
      });
    } catch (error) {
      console.error(
        `[Pipeline] Failed to update sender profile for ${senderEmail}:`,
        error
      );
    }
  }
}

export async function runAgentPipeline(
  userId: string,
  trigger: "manual" | "cron",
  existingRunId?: string
): Promise<string> {
  // Step 1: Use existing AgentRun or create a new one
  const agentRun = existingRunId
    ? await prisma.agentRun.findUniqueOrThrow({
        where: { id: existingRunId },
      })
    : await prisma.agentRun.create({
        data: { userId, trigger, status: "running" },
      });

  try {
    // Step 2: Sync all email accounts
    const syncResult = await syncAllAccounts(userId);

    await prisma.agentRun.update({
      where: { id: agentRun.id },
      data: { emailsFetched: syncResult.totalFetched },
    });

    // Step 3: Get unclassified emails (expanded fields for enrichment)
    const accounts = await prisma.emailAccount.findMany({
      where: { userId, isActive: true },
      select: { id: true, email: true },
    });
    const accountIds = accounts.map((a) => a.id);
    const userEmails = new Set(accounts.map((a) => a.email.toLowerCase()));

    const unclassifiedEmails = await prisma.email.findMany({
      where: {
        accountId: { in: accountIds },
        classification: null,
      },
      select: {
        id: true,
        from: true,
        fromName: true,
        to: true,
        cc: true,
        subject: true,
        snippet: true,
        bodyText: true,
        bodyHtml: true,
        receivedAt: true,
        labels: true,
        threadId: true,
        hasAttachments: true,
        attachments: true,
        accountId: true,
      },
      orderBy: { receivedAt: "desc" },
      take: MAX_EMAILS_PER_RUN,
    });

    if (unclassifiedEmails.length === 0) {
      await prisma.agentRun.update({
        where: { id: agentRun.id },
        data: {
          emailsClassified: 0,
          status: "completed",
          completedAt: new Date(),
        },
      });
      return agentRun.id;
    }

    // Step 3b: Batch-fetch thread context
    const threadIds = [
      ...new Set(
        unclassifiedEmails
          .map((e) => e.threadId)
          .filter((t): t is string => t !== null && t !== undefined)
      ),
    ];

    const threadEmails =
      threadIds.length > 0
        ? await prisma.email.findMany({
            where: {
              accountId: { in: accountIds },
              threadId: { in: threadIds },
            },
            select: {
              id: true,
              threadId: true,
              from: true,
              fromName: true,
              to: true,
              cc: true,
              subject: true,
              snippet: true,
              receivedAt: true,
            },
            orderBy: { receivedAt: "desc" },
          })
        : [];

    const threadMap = new Map<string, (typeof threadEmails)[number][]>();
    for (const te of threadEmails) {
      if (!te.threadId) continue;
      const arr = threadMap.get(te.threadId) || [];
      arr.push(te);
      threadMap.set(te.threadId, arr);
    }

    // Step 3c: Batch-fetch sender profiles
    const senderEmailList = [
      ...new Set(unclassifiedEmails.map((e) => e.from)),
    ];

    const senderProfiles = await prisma.senderProfile.findMany({
      where: {
        userId,
        senderEmail: { in: senderEmailList },
      },
    });

    const senderMap = new Map(
      senderProfiles.map((sp) => [sp.senderEmail, sp])
    );

    // Step 4: Build enriched ClassificationInput
    const inputs: ClassificationInput[] = unclassifiedEmails.map((e) => {
      // Thread context
      let threadContext: ThreadContext | null = null;
      if (e.threadId && threadMap.has(e.threadId)) {
        const siblings = threadMap.get(e.threadId)!;
        const participants = [
          ...new Set(siblings.flatMap((s) => [s.from, ...s.to, ...s.cc])),
        ];
        threadContext = {
          threadId: e.threadId,
          messageCount: siblings.length,
          participants,
          latestMessages: siblings
            .filter((s) => s.id !== e.id)
            .slice(0, 3)
            .map((s) => ({
              from: s.from,
              fromName: s.fromName,
              subject: s.subject,
              snippet: s.snippet,
              receivedAt: s.receivedAt,
            })),
          yourRepliesExist: siblings.some((s) =>
            userEmails.has(s.from.toLowerCase())
          ),
        };
      }

      // Sender context
      const sp = senderMap.get(e.from);
      const senderContext: SenderContext | null = sp
        ? {
            totalEmails: sp.totalEmails,
            lastEmailAt: sp.lastEmailAt,
            relationship: sp.relationship,
            avgResponseTime: sp.avgResponseTime,
          }
        : null;

      // Parse attachments from JSON
      const attachments: AttachmentMeta[] | undefined =
        e.attachments && Array.isArray(e.attachments)
          ? (e.attachments as unknown as AttachmentMeta[])
          : undefined;

      return {
        emailId: e.id,
        from: e.from,
        fromName: e.fromName,
        to: e.to,
        cc: e.cc,
        subject: e.subject,
        snippet: e.snippet,
        bodyText: e.bodyText,
        bodyHtml: e.bodyHtml,
        receivedAt: e.receivedAt,
        labels: e.labels,
        threadContext,
        hasAttachments: e.hasAttachments,
        attachments,
        senderContext,
        isForwarded: /^(Fwd?|Fw):/i.test(e.subject),
      };
    });

    // Step 5: Classify using GPT-5.2
    const { results, errors } = await classifyEmails(inputs);

    // Step 6: Store classifications in DB
    const validEmailIds = new Set(unclassifiedEmails.map((e) => e.id));
    let stored = 0;
    let skippedInvalid = 0;
    for (const result of results) {
      if (!validEmailIds.has(result.emailId)) {
        console.warn(
          `[Pipeline] Skipping classification for unknown emailId: ${result.emailId}`
        );
        skippedInvalid++;
        continue;
      }
      try {
        await prisma.classification.upsert({
          where: { emailId: result.emailId },
          create: {
            emailId: result.emailId,
            priority: result.classification.priority,
            category: result.classification.category,
            needsReply: result.classification.needsReply,
            needsApproval: result.classification.needsApproval,
            isThreadActive: result.classification.isThreadActive,
            actionItems: result.classification.actionItems as object[],
            summary: result.classification.summary,
            confidence: result.classification.confidence,
          },
          update: {
            priority: result.classification.priority,
            category: result.classification.category,
            needsReply: result.classification.needsReply,
            needsApproval: result.classification.needsApproval,
            isThreadActive: result.classification.isThreadActive,
            actionItems: result.classification.actionItems as object[],
            summary: result.classification.summary,
            confidence: result.classification.confidence,
            classifiedAt: new Date(),
          },
        });
        stored++;
      } catch (error) {
        console.error(
          `Failed to store classification for email ${result.emailId}:`,
          error
        );
      }
    }

    // Step 6b: Update sender profiles
    await updateSenderProfiles(
      userId,
      unclassifiedEmails.map((e) => ({
        from: e.from,
        fromName: e.fromName,
        receivedAt: e.receivedAt,
      }))
    );

    // Step 7: Update AgentRun with final status
    const hasErrors = errors.length > 0 || skippedInvalid > 0;
    const errorParts: string[] = [];
    if (errors.length > 0)
      errorParts.push(`${errors.length} failed classification`);
    if (skippedInvalid > 0)
      errorParts.push(`${skippedInvalid} had invalid emailIds`);

    console.log(
      `[Pipeline] Stored ${stored} classifications, ${skippedInvalid} skipped (invalid ID), ${errors.length} errors`
    );

    await prisma.agentRun.update({
      where: { id: agentRun.id },
      data: {
        emailsClassified: stored,
        status: hasErrors && stored === 0 ? "failed" : "completed",
        errorMessage: errorParts.length > 0 ? errorParts.join("; ") : null,
        completedAt: new Date(),
      },
    });

    return agentRun.id;
  } catch (error) {
    // Catastrophic failure
    await prisma.agentRun.update({
      where: { id: agentRun.id },
      data: {
        status: "failed",
        errorMessage:
          error instanceof Error ? error.message : "Unknown error",
        completedAt: new Date(),
      },
    });

    throw error;
  }
}
