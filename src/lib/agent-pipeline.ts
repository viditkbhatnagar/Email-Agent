import { prisma } from "@/lib/prisma";
import { syncAllAccounts } from "@/lib/email-sync";
import { classifyEmails } from "@/lib/classifier";
import type { ClassificationInput } from "@/types";

const MAX_EMAILS_PER_RUN = 500;

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

    // Step 3: Get unclassified emails
    const accounts = await prisma.emailAccount.findMany({
      where: { userId, isActive: true },
      select: { id: true },
    });
    const accountIds = accounts.map((a) => a.id);

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
        receivedAt: true,
        labels: true,
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

    // Step 4: Transform to ClassificationInput
    const inputs: ClassificationInput[] = unclassifiedEmails.map((e) => ({
      emailId: e.id,
      from: e.from,
      fromName: e.fromName,
      to: e.to,
      cc: e.cc,
      subject: e.subject,
      snippet: e.snippet,
      bodyText: e.bodyText,
      receivedAt: e.receivedAt,
      labels: e.labels,
    }));

    // Step 5: Classify using OpenAI
    const { results, errors } = await classifyEmails(inputs);

    // Step 6: Store classifications in DB
    let stored = 0;
    for (const result of results) {
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
            actionItems: result.classification.actionItems as unknown as undefined,
            summary: result.classification.summary,
            confidence: result.classification.confidence,
          },
          update: {
            priority: result.classification.priority,
            category: result.classification.category,
            needsReply: result.classification.needsReply,
            needsApproval: result.classification.needsApproval,
            isThreadActive: result.classification.isThreadActive,
            actionItems: result.classification.actionItems as unknown as undefined,
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

    // Step 7: Update AgentRun with final status
    const hasErrors = errors.length > 0;
    await prisma.agentRun.update({
      where: { id: agentRun.id },
      data: {
        emailsClassified: stored,
        status: hasErrors && stored === 0 ? "failed" : "completed",
        errorMessage: hasErrors
          ? `${errors.length} email(s) failed classification`
          : null,
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
