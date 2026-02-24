import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
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

    const accounts = await prisma.emailAccount.findMany({
      where: { userId: session.user.id, isActive: true },
      select: { id: true },
    });
    const accountIds = accounts.map((a) => a.id);

    if (accountIds.length === 0) {
      return NextResponse.json({
        emails: [],
        total: 0,
        stats: includeStats
          ? { needsReply: 0, needsApproval: 0, activeThreads: 0, unclassified: 0 }
          : undefined,
      });
    }

    // Build the where clause
    const folderLabel = folder === "sent" ? "SENT" : "INBOX";
    const where: Prisma.EmailWhereInput = {
      accountId: accountId ? { equals: accountId } : { in: accountIds },
      labels: { has: folderLabel },
    };

    // Cursor-based pagination
    if (cursor) {
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

    // Classification-based filters
    if (priorityParam || category || actionableOnly || needsReply || needsApproval || isThreadActive) {
      const classificationFilter: Prisma.ClassificationWhereInput = {};

      if (priorityParam) {
        const priorities = priorityParam
          .split(",")
          .map(Number)
          .filter((n) => n >= 1 && n <= 5);
        if (priorities.length > 0) {
          classificationFilter.priority = { in: priorities };
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
        classificationFilter.OR = [
          { needsReply: true },
          { needsApproval: true },
        ];
      }

      where.classification = classificationFilter;
    }

    const [emails, total] = await Promise.all([
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
            },
          },
        },
        orderBy: [
          { receivedAt: "desc" },
        ],
        take: limit,
      }),
      prisma.email.count({ where: { accountId: { in: accountIds }, labels: { has: folderLabel } } }),
    ]);

    // Optional stats
    let stats = undefined;
    if (includeStats) {
      const inboxFilter = { accountId: { in: accountIds }, labels: { has: "INBOX" as string } };
      const [needsReply, needsApproval, activeThreads, unclassified] =
        await Promise.all([
          prisma.classification.count({
            where: {
              email: inboxFilter,
              needsReply: true,
            },
          }),
          prisma.classification.count({
            where: {
              email: inboxFilter,
              needsApproval: true,
            },
          }),
          prisma.classification.count({
            where: {
              email: inboxFilter,
              isThreadActive: true,
            },
          }),
          prisma.email.count({
            where: {
              ...inboxFilter,
              classification: null,
            },
          }),
        ]);
      stats = { needsReply, needsApproval, activeThreads, unclassified };
    }

    const nextCursor =
      emails.length === limit
        ? emails[emails.length - 1].receivedAt.toISOString()
        : undefined;

    return NextResponse.json({ emails, total, cursor: nextCursor, stats });
  } catch (error) {
    console.error("Error fetching emails:", error);
    return NextResponse.json(
      { error: "Failed to fetch emails" },
      { status: 500 }
    );
  }
}
