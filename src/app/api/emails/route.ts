import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { computeEffectivePriority, detectFollowUp } from "@/lib/priority";
import type { EffectivePriorityOptions } from "@/lib/priority";
import type { Prisma } from "@prisma/client";

export async function GET(req: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = req.nextUrl;
    const cursor = searchParams.get("cursor");
    const limit = Math.min(parseInt(searchParams.get("limit") ?? "50"), 100);

    // Filter params
    const priorityParam = searchParams.get("priority");
    const category = searchParams.get("category");
    const accountId = searchParams.get("accountId");
    const dateFrom = searchParams.get("dateFrom");
    const dateTo = searchParams.get("dateTo");
    const search = searchParams.get("search");
    const actionableOnly = searchParams.get("actionableOnly") === "true";
    const needsReply = searchParams.get("needsReply") === "true";
    const needsApproval = searchParams.get("needsApproval") === "true";
    const isThreadActive = searchParams.get("isThreadActive") === "true";
    const threadId = searchParams.get("threadId");
    const folder = searchParams.get("folder") ?? "inbox"; // "inbox" | "sent"
    const includeStats = searchParams.get("includeStats") === "true";
    const showHandled = searchParams.get("showHandled") === "true";
    const sortBy = searchParams.get("sortBy") ?? "date"; // "date" | "priority"
    const page = parseInt(searchParams.get("page") ?? "0");
    const vipOnly = searchParams.get("vipOnly") === "true";
    const hasDeadline = searchParams.get("hasDeadline") === "true";
    const lowConfidence = searchParams.get("lowConfidence") === "true";
    const isMailingListFilter = searchParams.get("isMailingList") === "true";

    const accounts = await prisma.emailAccount.findMany({
      where: { userId: session.user.id, isActive: true },
      select: { id: true, email: true },
    });
    const accountIds = accounts.map((a) => a.id);

    if (accountIds.length === 0) {
      return NextResponse.json({
        emails: [],
        total: 0,
        stats: includeStats
          ? {
              needsReply: 0,
              needsApproval: 0,
              activeThreads: 0,
              unclassified: 0,
              categoryCounts: {},
              priorityCounts: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
            }
          : undefined,
      });
    }

    // Fetch user for company domains (used by priority computation)
    const user = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: { companyDomains: true },
    });
    const companyDomains = user?.companyDomains ?? [];

    // Build the where clause
    const folderLabel = folder === "sent" ? "SENT" : "INBOX";
    const where: Prisma.EmailWhereInput = {
      accountId: accountId ? { equals: accountId } : { in: accountIds },
      labels: { has: folderLabel },
    };

    // Cursor-based pagination (only for date sort)
    if (cursor && sortBy === "date") {
      where.receivedAt = { ...(where.receivedAt as object), lt: new Date(cursor) };
    }

    // Date range filters
    if (dateFrom) {
      where.receivedAt = { ...(where.receivedAt as object), gte: new Date(dateFrom) };
    }
    if (dateTo) {
      where.receivedAt = { ...(where.receivedAt as object), lte: new Date(dateTo) };
    }

    // Thread filter
    if (threadId) {
      where.threadId = threadId;
    }

    // Search filter
    if (search) {
      where.OR = [
        { subject: { contains: search, mode: "insensitive" } },
        { from: { contains: search, mode: "insensitive" } },
        { fromName: { contains: search, mode: "insensitive" } },
        { snippet: { contains: search, mode: "insensitive" } },
      ];
    }

    // Email-level filters
    if (isMailingListFilter) {
      where.isMailingList = true;
    }

    // Classification-based filters
    const hasClassificationFilter =
      priorityParam || category || actionableOnly || needsReply ||
      needsApproval || isThreadActive || !showHandled || hasDeadline || lowConfidence;

    if (hasClassificationFilter) {
      const classificationFilter: Prisma.ClassificationWhereInput = {};

      // Priority filtering: broaden DB query, post-filter by effectivePriority
      // We include emails with deadlines (they might escalate into the requested range)
      if (priorityParam) {
        const priorities = priorityParam
          .split(",")
          .map(Number)
          .filter((n) => n >= 1 && n <= 5);
        if (priorities.length > 0) {
          const maxRequested = Math.max(...priorities);
          classificationFilter.OR = [
            { priority: { lte: maxRequested } },
            { deadline: { not: null } },
          ];
        }
      }

      if (category) {
        classificationFilter.category = category;
      }

      if (needsReply) {
        classificationFilter.needsReply = true;
      }

      if (needsApproval) {
        classificationFilter.needsApproval = true;
      }

      if (isThreadActive) {
        classificationFilter.isThreadActive = true;
      }

      if (actionableOnly) {
        const existingOr = classificationFilter.OR;
        // Combine with existing OR if priority filter already set one
        if (existingOr) {
          classificationFilter.AND = [
            { OR: existingOr },
            { OR: [{ needsReply: true }, { needsApproval: true }] },
          ];
          delete classificationFilter.OR;
        } else {
          classificationFilter.OR = [
            { needsReply: true },
            { needsApproval: true },
          ];
        }
      }

      // Default: hide handled emails unless showHandled is true
      if (!showHandled) {
        classificationFilter.handled = false;
      }

      if (hasDeadline) {
        classificationFilter.deadline = { not: null };
      }

      if (lowConfidence) {
        classificationFilter.confidence = { lt: 0.65 };
      }

      // Determine if we should also include unclassified emails.
      // Include them ONLY when the filter is purely the default "hide handled" filter.
      // When explicit classification filters are active, unclassified emails lack those
      // attributes and should not appear.
      const isOnlyDefaultFilter = !priorityParam && !category && !actionableOnly
        && !needsReply && !needsApproval && !isThreadActive && !hasDeadline && !lowConfidence;

      if (isOnlyDefaultFilter && !showHandled) {
        const classificationCondition: Prisma.EmailWhereInput = {
          OR: [
            { classification: { is: null } },
            { classification: classificationFilter },
          ],
        };
        // Compose safely with existing where.OR (search filter)
        if (where.OR) {
          where.AND = [{ OR: where.OR }, classificationCondition];
          delete where.OR;
        } else {
          Object.assign(where, classificationCondition);
        }
      } else {
        where.classification = classificationFilter;
      }
    }

    // Determine fetch strategy based on priority filter and sort mode
    const hasPriorityFilter = !!priorityParam;
    const fetchMultiplier = hasPriorityFilter ? 3 : 1;
    const fetchLimit = sortBy === "priority"
      ? limit * 2 // over-fetch for re-sorting
      : limit * fetchMultiplier;

    // Batch-fetch sender profiles for priority computation (VIP, velocity, relationship, avgResponseTime)
    const senderProfilesPromise = prisma.senderProfile.findMany({
      where: { userId: session.user.id },
      select: {
        senderEmail: true,
        isVip: true,
        relationship: true,
        totalEmails: true,
        recentEmailCount: true,
        recentWindowStart: true,
        avgResponseTime: true,
      },
    });

    const orderBy: Prisma.EmailOrderByWithRelationInput[] =
      sortBy === "priority"
        ? [{ classification: { priority: "asc" } }, { receivedAt: "desc" }]
        : [{ receivedAt: "desc" }];

    const [rawEmails, total, senderProfiles] = await Promise.all([
      prisma.email.findMany({
        where,
        select: {
          id: true,
          from: true,
          fromName: true,
          to: true,
          subject: true,
          snippet: true,
          receivedAt: true,
          isRead: true,
          hasAttachments: true,
          labels: true,
          account: {
            select: { provider: true, email: true },
          },
          classification: {
            select: {
              priority: true,
              category: true,
              summary: true,
              needsReply: true,
              needsApproval: true,
              isThreadActive: true,
              confidence: true,
              deadline: true,
              handled: true,
              userOverride: true,
              actionItems: true,
              threadResolved: true,
              snoozedUntil: true,
              topics: true,
              sentiment: true,
            },
          },
        },
        orderBy,
        ...(sortBy === "priority"
          ? { skip: page * limit, take: fetchLimit }
          : { take: fetchLimit }),
      }),
      prisma.email.count({
        where: { accountId: { in: accountIds }, labels: { has: folderLabel } },
      }),
      senderProfilesPromise,
    ]);

    // Build sender lookup maps
    const vipSet = new Set<string>();
    const senderProfileMap = new Map<string, {
      isVip: boolean;
      relationship: string | null;
      totalEmails: number;
      recentEmailCount: number;
      recentWindowStart: Date | null;
      avgResponseTime: number | null;
    }>();
    for (const sp of senderProfiles) {
      const key = sp.senderEmail.toLowerCase();
      senderProfileMap.set(key, sp);
      if (sp.isVip) vipSet.add(key);
    }

    // Compute effective priority for each email
    const now = new Date();
    const emailsWithEffectivePriority = rawEmails
      .filter((email) => {
        // D1: Filter out snoozed emails
        if (email.classification?.snoozedUntil && email.classification.snoozedUntil > now) {
          return false;
        }
        return true;
      })
      .map((email) => {
      if (!email.classification) return email;
      const { deadline, handled, actionItems, threadResolved, snoozedUntil, ...classRest } = email.classification;
      const senderKey = email.from.toLowerCase();
      const senderDomain = email.from.split("@")[1] ?? "";
      const followUp = detectFollowUp(email.subject, email.snippet ?? undefined);
      const sp = senderProfileMap.get(senderKey);

      const parsedActionItems = Array.isArray(actionItems)
        ? (actionItems as { description: string; dueDate?: string }[])
        : undefined;

      // Compute velocity anomaly: recentEmailCount > 3x average weekly rate
      let velocityAnomaly = false;
      if (sp && sp.totalEmails > 0 && sp.recentWindowStart) {
        const weeksActive = Math.max(
          1,
          (Date.now() - sp.recentWindowStart.getTime()) / (7 * 24 * 60 * 60 * 1000)
        );
        const avgPerWeek = sp.totalEmails / weeksActive;
        velocityAnomaly = sp.recentEmailCount > avgPerWeek * 3;
      }

      // Check if provider marked as starred/important
      const isStarred = email.labels?.includes("STARRED") || email.labels?.includes("IMPORTANT") || false;

      const options: EffectivePriorityOptions = {
        needsReply: email.classification.needsReply,
        handled: email.classification.handled,
        receivedAt: email.receivedAt,
        isVipSender: vipSet.has(senderKey),
        senderDomain,
        companyDomains,
        actionItems: parsedActionItems,
        isFollowUp: followUp.isFollowUp,
        isEscalation: followUp.isEscalation,
        senderVelocityAnomaly: velocityAnomaly,
        senderRelationship: sp?.relationship ?? undefined,
        isThreadActive: email.classification.isThreadActive,
        confidence: email.classification.confidence ?? undefined,
        isStarred,
        avgResponseTime: sp?.avgResponseTime ?? undefined,
        threadResolved: threadResolved ?? false,
      };

      return {
        ...email,
        classification: {
          ...classRest,
          deadline: deadline?.toISOString() ?? null,
          handled,
          threadResolved,
          snoozedUntil: snoozedUntil?.toISOString() ?? null,
          effectivePriority: computeEffectivePriority(
            email.classification.priority,
            deadline,
            options
          ),
        },
      };
    });

    // Post-filter: VIP sender filter (requires SenderProfile lookup)
    type EmailWithEffPri = (typeof emailsWithEffectivePriority)[number];
    let filteredEmails: EmailWithEffPri[] = emailsWithEffectivePriority;
    if (vipOnly) {
      filteredEmails = filteredEmails.filter((e) =>
        vipSet.has(e.from.toLowerCase())
      );
    }

    // Post-filter by effective priority if priority filter is active
    if (priorityParam) {
      const priorities = priorityParam
        .split(",")
        .map(Number)
        .filter((n) => n >= 1 && n <= 5);
      if (priorities.length > 0) {
        filteredEmails = emailsWithEffectivePriority.filter((e) => {
          const cls = e.classification as { effectivePriority?: number; priority?: number } | null;
          const ep = cls?.effectivePriority ?? cls?.priority;
          return ep != null && priorities.includes(ep);
        });
      }
    }

    // Re-sort by effective priority if sort mode is priority
    if (sortBy === "priority") {
      filteredEmails.sort((a, b) => {
        const aCls = a.classification as { effectivePriority?: number; priority?: number } | null;
        const bCls = b.classification as { effectivePriority?: number; priority?: number } | null;
        const aPri = aCls?.effectivePriority ?? aCls?.priority ?? 5;
        const bPri = bCls?.effectivePriority ?? bCls?.priority ?? 5;
        if (aPri !== bPri) return aPri - bPri;
        // Secondary sort: newest first
        return new Date(b.receivedAt).getTime() - new Date(a.receivedAt).getTime();
      });
    }

    // Apply final limit
    const paginatedEmails = filteredEmails.slice(0, limit);

    // Compute cursor/pagination
    let nextCursor: string | undefined;
    let nextPage: number | undefined;

    if (sortBy === "priority") {
      if (filteredEmails.length > limit) {
        nextPage = page + 1;
      }
    } else {
      nextCursor =
        paginatedEmails.length === limit
          ? paginatedEmails[paginatedEmails.length - 1].receivedAt.toISOString()
          : undefined;
    }

    // Optional stats — computed with effective priority
    let stats = undefined;
    if (includeStats) {
      const inboxFilter = {
        accountId: { in: accountIds },
        labels: { has: "INBOX" as string },
      };

      const [allClassifications, unclassified] = await Promise.all([
        prisma.classification.findMany({
          where: { email: inboxFilter },
          select: {
            priority: true,
            category: true,
            confidence: true,
            needsReply: true,
            needsApproval: true,
            isThreadActive: true,
            handled: true,
            deadline: true,
            actionItems: true,
            email: {
              select: { receivedAt: true, from: true, subject: true, snippet: true },
            },
          },
        }),
        prisma.email.count({
          where: { ...inboxFilter, classification: null },
        }),
      ]);

      let pendingReplyCount = 0;
      let pendingApprovalCount = 0;
      let activeThreadCount = 0;
      const effectivePriorityCounts: Record<number, number> = {
        1: 0, 2: 0, 3: 0, 4: 0, 5: 0,
      };
      const categoryCounts: Record<string, number> = {};

      for (const c of allClassifications) {
        // Category counts (all, regardless of handled)
        categoryCounts[c.category] = (categoryCounts[c.category] ?? 0) + 1;

        // Effective priority
        const statsSenderKey = c.email.from.toLowerCase();
        const senderDomain = c.email.from.split("@")[1] ?? "";
        const statsFollowUp = detectFollowUp(c.email.subject, c.email.snippet ?? undefined);
        const statsActionItems = Array.isArray(c.actionItems)
          ? (c.actionItems as { description: string; dueDate?: string }[])
          : undefined;
        const statsSp = senderProfileMap.get(statsSenderKey);
        let statsVelocity = false;
        if (statsSp && statsSp.totalEmails > 0 && statsSp.recentWindowStart) {
          const wks = Math.max(1, (Date.now() - statsSp.recentWindowStart.getTime()) / (7 * 24 * 60 * 60 * 1000));
          statsVelocity = statsSp.recentEmailCount > (statsSp.totalEmails / wks) * 3;
        }
        const ep = computeEffectivePriority(c.priority, c.deadline, {
          needsReply: c.needsReply,
          handled: c.handled,
          receivedAt: c.email.receivedAt,
          isVipSender: vipSet.has(statsSenderKey),
          senderDomain,
          companyDomains,
          actionItems: statsActionItems,
          isFollowUp: statsFollowUp.isFollowUp,
          isEscalation: statsFollowUp.isEscalation,
          senderVelocityAnomaly: statsVelocity,
          senderRelationship: statsSp?.relationship ?? undefined,
          isThreadActive: c.isThreadActive,
          confidence: c.confidence ?? undefined,
          avgResponseTime: statsSp?.avgResponseTime ?? undefined,
        });
        effectivePriorityCounts[ep] =
          (effectivePriorityCounts[ep] ?? 0) + 1;

        // Pending (not handled) counts
        if (!c.handled) {
          if (c.needsReply) pendingReplyCount++;
          if (c.needsApproval) pendingApprovalCount++;
          if (c.isThreadActive) activeThreadCount++;
        }
      }

      stats = {
        needsReply: pendingReplyCount,
        needsApproval: pendingApprovalCount,
        activeThreads: activeThreadCount,
        unclassified,
        categoryCounts,
        priorityCounts: effectivePriorityCounts,
      };
    }

    return NextResponse.json({
      emails: paginatedEmails,
      total,
      cursor: nextCursor,
      page: nextPage,
      stats,
    });
  } catch (error) {
    console.error("Error fetching emails:", error);
    return NextResponse.json(
      { error: "Failed to fetch emails" },
      { status: 500 }
    );
  }
}
