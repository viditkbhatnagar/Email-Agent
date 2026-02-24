import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { reclassifySingleEmail } from "@/lib/classifier";
import type {
  ClassificationInput,
  ThreadContext,
  SenderContext,
  AttachmentMeta,
} from "@/types";

export async function PATCH(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await params;

    // Fetch the email with ownership check
    const email = await prisma.email.findUnique({
      where: { id },
      include: {
        account: { select: { userId: true, id: true } },
      },
    });

    if (!email || email.account.userId !== session.user.id) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    // Fetch thread context
    let threadContext: ThreadContext | null = null;
    if (email.threadId) {
      const userAccounts = await prisma.emailAccount.findMany({
        where: { userId: session.user.id, isActive: true },
        select: { email: true, id: true },
      });
      const userEmails = new Set(
        userAccounts.map((a) => a.email.toLowerCase())
      );
      const accountIds = userAccounts.map((a) => a.id);

      const threadSiblings = await prisma.email.findMany({
        where: {
          accountId: { in: accountIds },
          threadId: email.threadId,
        },
        select: {
          id: true,
          from: true,
          fromName: true,
          to: true,
          cc: true,
          subject: true,
          snippet: true,
          receivedAt: true,
        },
        orderBy: { receivedAt: "desc" },
        take: 10,
      });

      const participants = [
        ...new Set(
          threadSiblings.flatMap((s) => [s.from, ...s.to, ...s.cc])
        ),
      ];

      threadContext = {
        threadId: email.threadId,
        messageCount: threadSiblings.length,
        participants,
        latestMessages: threadSiblings
          .filter((s) => s.id !== email.id)
          .slice(0, 3)
          .map((s) => ({
            from: s.from,
            fromName: s.fromName,
            subject: s.subject,
            snippet: s.snippet,
            receivedAt: s.receivedAt,
          })),
        yourRepliesExist: threadSiblings.some((s) =>
          userEmails.has(s.from.toLowerCase())
        ),
      };
    }

    // Fetch sender context
    const senderProfile = await prisma.senderProfile.findUnique({
      where: {
        userId_senderEmail: {
          userId: session.user.id,
          senderEmail: email.from,
        },
      },
    });

    const senderContext: SenderContext | null = senderProfile
      ? {
          totalEmails: senderProfile.totalEmails,
          lastEmailAt: senderProfile.lastEmailAt,
          relationship: senderProfile.relationship,
          avgResponseTime: senderProfile.avgResponseTime,
        }
      : null;

    // Parse attachments from JSON
    const attachments: AttachmentMeta[] | undefined =
      email.attachments && Array.isArray(email.attachments)
        ? (email.attachments as unknown as AttachmentMeta[])
        : undefined;

    // Build enriched classification input
    const input: ClassificationInput = {
      emailId: email.id,
      from: email.from,
      fromName: email.fromName,
      to: email.to,
      cc: email.cc,
      subject: email.subject,
      snippet: email.snippet,
      bodyText: email.bodyText,
      bodyHtml: email.bodyHtml,
      receivedAt: email.receivedAt,
      labels: email.labels,
      threadContext,
      hasAttachments: email.hasAttachments,
      attachments,
      senderContext,
      isForwarded: /^(Fwd?|Fw):/i.test(email.subject),
    };

    // Classify
    const result = await reclassifySingleEmail(input);

    // Upsert classification
    const classification = await prisma.classification.upsert({
      where: { emailId: email.id },
      create: {
        emailId: email.id,
        priority: result.priority,
        category: result.category,
        needsReply: result.needsReply,
        needsApproval: result.needsApproval,
        isThreadActive: result.isThreadActive,
        actionItems: result.actionItems as unknown as undefined,
        summary: result.summary,
        confidence: result.confidence,
        userOverride: false,
      },
      update: {
        priority: result.priority,
        category: result.category,
        needsReply: result.needsReply,
        needsApproval: result.needsApproval,
        isThreadActive: result.isThreadActive,
        actionItems: result.actionItems as unknown as undefined,
        summary: result.summary,
        confidence: result.confidence,
        userOverride: false,
        classifiedAt: new Date(),
      },
    });

    return NextResponse.json(classification);
  } catch (error) {
    console.error("Error reclassifying email:", error);
    return NextResponse.json(
      { error: "Failed to reclassify email" },
      { status: 500 }
    );
  }
}
