import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { classifyEmails } from "@/lib/classifier";
import type { ClassifyOptions } from "@/lib/classifier";
import type {
  ClassificationInput,
  ThreadContext,
  SenderContext,
  AttachmentMeta,
} from "@/types";
import { z } from "zod";

const ReclassifySchema = z.object({
  /** Only re-classify emails with this classifier version (e.g. "v1" to upgrade old classifications) */
  classifierVersion: z.string().optional(),
  /** Only re-classify emails below this confidence threshold */
  maxConfidence: z.number().min(0).max(1).optional(),
  /** Only re-classify emails in this category */
  category: z.string().optional(),
  /** Maximum number of emails to re-classify in this batch */
  limit: z.number().min(1).max(200).default(50),
});

export async function POST(req: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const raw = await req.json();
    const parsed = ReclassifySchema.safeParse(raw);

    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const { classifierVersion, maxConfidence, category, limit } = parsed.data;

    // Must provide at least one filter to prevent accidental mass re-classification
    if (!classifierVersion && maxConfidence === undefined && !category) {
      return NextResponse.json(
        { error: "At least one filter (classifierVersion, maxConfidence, or category) is required" },
        { status: 400 }
      );
    }

    const accounts = await prisma.emailAccount.findMany({
      where: { userId: session.user.id, isActive: true },
      select: { id: true, email: true },
    });
    const accountIds = accounts.map((a) => a.id);
    const userEmails = new Set(accounts.map((a) => a.email.toLowerCase()));

    if (accountIds.length === 0) {
      return NextResponse.json({ reclassified: 0, message: "No accounts" });
    }

    // Build classification filter — NEVER re-classify user overrides
    const classificationFilter: Record<string, unknown> = {
      userOverride: false,
    };

    if (classifierVersion) {
      classificationFilter.classifierVersion = classifierVersion;
    }
    if (maxConfidence !== undefined) {
      classificationFilter.confidence = { lt: maxConfidence };
    }
    if (category) {
      classificationFilter.category = category;
    }

    // Fetch emails matching criteria
    const emails = await prisma.email.findMany({
      where: {
        accountId: { in: accountIds },
        classification: classificationFilter,
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
        isMailingList: true,
        listId: true,
      },
      orderBy: { receivedAt: "desc" },
      take: limit,
    });

    if (emails.length === 0) {
      return NextResponse.json({
        reclassified: 0,
        message: "No emails match the filter criteria",
      });
    }

    // Batch-fetch sender profiles
    const senderEmailList = [...new Set(emails.map((e) => e.from))];
    const senderProfiles = await prisma.senderProfile.findMany({
      where: { userId: session.user.id, senderEmail: { in: senderEmailList } },
    });
    const senderMap = new Map(
      senderProfiles.map((sp) => [sp.senderEmail, sp])
    );

    // Batch-fetch thread context
    const threadIds = [
      ...new Set(
        emails
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

    // Build ClassificationInput
    const inputs: ClassificationInput[] = emails.map((e) => {
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

      const sp = senderMap.get(e.from);
      const senderContext: SenderContext | null = sp
        ? {
            totalEmails: sp.totalEmails,
            lastEmailAt: sp.lastEmailAt,
            relationship: sp.relationship,
            avgResponseTime: sp.avgResponseTime,
            recentEmailCount: sp.recentEmailCount,
            isVip: sp.isVip,
          }
        : null;

      const attachments: AttachmentMeta[] | undefined =
        e.attachments && Array.isArray(e.attachments)
          ? (e.attachments as unknown as AttachmentMeta[])
          : undefined;

      const isDirectlyAddressed = e.to.some((addr) =>
        userEmails.has(addr.toLowerCase())
      );

      // Lightweight follow-up detection
      const text = `${e.subject} ${e.snippet ?? ""}`;
      const isFollowUp =
        /\b(?:follow(?:ing)?\s*up|checking\s+in|bump|circling\s+back|gentle\s+reminder|any\s+update|haven'?t\s+heard\s+back|friendly\s+reminder|still\s+(?:waiting|pending|need))\b/i.test(
          text
        );
      const isEscalation =
        /\b(?:urgent|time[\s-]sensitive|asap|escalat(?:ing|ion|ed)|immediately|critical|blocking|overdue|final\s+(?:notice|reminder|warning)|action\s+required)\b/i.test(
          text
        );

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
        isDirectlyAddressed,
        isMailingList: e.isMailingList,
        isFollowUp,
        isEscalation,
      };
    });

    // Fetch user config for classify options
    const [user, recentOverrides] = await Promise.all([
      prisma.user.findUnique({
        where: { id: session.user.id },
        select: { companyDomains: true },
      }),
      prisma.classification.findMany({
        where: {
          userOverride: true,
          email: { accountId: { in: accountIds } },
        },
        select: {
          priority: true,
          category: true,
          originalPriority: true,
          originalCategory: true,
          needsReply: true,
          email: { select: { from: true, subject: true } },
        },
        orderBy: { classifiedAt: "desc" },
        take: 20,
      }),
    ]);

    const classifyOptions: ClassifyOptions = {
      companyDomains: user?.companyDomains ?? [],
      overrideExamples: recentOverrides.length > 0
        ? recentOverrides.map((o) => ({
            from: o.email.from,
            subject: o.email.subject,
            originalPriority: o.originalPriority ?? o.priority,
            originalCategory: o.originalCategory ?? o.category,
            correctedPriority: o.priority,
            correctedCategory: o.category,
            correctedNeedsReply: o.needsReply,
          }))
        : undefined,
    };

    // Classify
    const { results, errors } = await classifyEmails(inputs, classifyOptions);

    // Store results — skip user overrides (double-check)
    let reclassified = 0;
    for (const result of results) {
      try {
        const deadlineDate = result.classification.deadline
          ? new Date(result.classification.deadline)
          : null;
        const validDeadline =
          deadlineDate && !isNaN(deadlineDate.getTime()) ? deadlineDate : null;

        await prisma.classification.update({
          where: { emailId: result.emailId },
          data: {
            priority: result.classification.priority,
            category: result.classification.category,
            needsReply: result.classification.needsReply,
            needsApproval: result.classification.needsApproval,
            isThreadActive: result.classification.isThreadActive,
            actionItems: result.classification.actionItems as object[],
            deadline: validDeadline,
            summary: result.classification.summary,
            confidence: result.classification.confidence,
            classifiedAt: new Date(),
            classifierVersion: "v2-gpt52-enriched",
          },
        });
        reclassified++;
      } catch {
        // Individual update failure — continue
      }
    }

    return NextResponse.json({
      reclassified,
      errors: errors.length,
      total: emails.length,
      message: `Re-classified ${reclassified} of ${emails.length} emails`,
    });
  } catch (error) {
    console.error("Error in bulk re-classification:", error);
    return NextResponse.json(
      { error: "Failed to re-classify emails" },
      { status: 500 }
    );
  }
}
