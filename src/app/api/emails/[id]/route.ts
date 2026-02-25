import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { computeEffectivePriority, computeEscalationReasons, detectFollowUp } from "@/lib/priority";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await params;

    const [email, user] = await Promise.all([
      prisma.email.findUnique({
        where: { id },
        include: {
          account: {
            select: { provider: true, email: true, userId: true },
          },
          classification: true,
        },
      }),
      prisma.user.findUnique({
        where: { id: session.user.id },
        select: { companyDomains: true },
      }),
    ]);

    if (!email || email.account.userId !== session.user.id) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    // Fetch sender profile for VIP, relationship, velocity, and response time data
    const senderProfile = await prisma.senderProfile.findUnique({
      where: {
        userId_senderEmail: {
          userId: session.user.id,
          senderEmail: email.from,
        },
      },
      select: {
        isVip: true,
        relationship: true,
        totalEmails: true,
        recentEmailCount: true,
        recentWindowStart: true,
        avgResponseTime: true,
      },
    });

    const companyDomains = user?.companyDomains ?? [];
    const senderDomain = email.from.split("@")[1] ?? "";

    // Add effectivePriority based on deadline proximity + dynamic factors
    const followUp = detectFollowUp(email.subject, email.snippet ?? undefined);
    const parsedActionItems = email.classification?.actionItems
      ? Array.isArray(email.classification.actionItems)
        ? (email.classification.actionItems as { description: string; dueDate?: string }[])
        : undefined
      : undefined;

    // Compute velocity anomaly
    let velocityAnomaly = false;
    if (senderProfile && senderProfile.totalEmails > 0 && senderProfile.recentWindowStart) {
      const weeksActive = Math.max(
        1,
        (Date.now() - senderProfile.recentWindowStart.getTime()) / (7 * 24 * 60 * 60 * 1000)
      );
      const avgPerWeek = senderProfile.totalEmails / weeksActive;
      velocityAnomaly = senderProfile.recentEmailCount > avgPerWeek * 3;
    }

    let result;
    if (email.classification) {
      // Check provider flags
      const isStarred = email.labels?.includes("STARRED") || email.labels?.includes("IMPORTANT") || false;

      const priorityOptions = {
        needsReply: email.classification.needsReply,
        handled: email.classification.handled,
        receivedAt: email.receivedAt,
        isVipSender: senderProfile?.isVip ?? false,
        senderDomain,
        companyDomains,
        actionItems: parsedActionItems,
        isFollowUp: followUp.isFollowUp,
        isEscalation: followUp.isEscalation,
        senderVelocityAnomaly: velocityAnomaly,
        senderRelationship: senderProfile?.relationship ?? undefined,
        isThreadActive: email.classification.isThreadActive,
        confidence: email.classification.confidence ?? undefined,
        isStarred,
        avgResponseTime: senderProfile?.avgResponseTime ?? undefined,
        threadResolved: (email.classification as Record<string, unknown>).threadResolved as boolean ?? false,
      };
      const ep = computeEffectivePriority(
        email.classification.priority,
        email.classification.deadline,
        priorityOptions
      );
      const escalationReasons = computeEscalationReasons(
        email.classification.priority,
        ep,
        email.classification.deadline,
        priorityOptions
      );
      result = {
        ...email,
        classification: {
          ...email.classification,
          effectivePriority: ep,
          escalationReasons,
        },
        isVipSender: senderProfile?.isVip ?? false,
      };
    } else {
      result = { ...email, isVipSender: senderProfile?.isVip ?? false };
    }

    return NextResponse.json(result);
  } catch (error) {
    console.error("Error fetching email:", error);
    return NextResponse.json(
      { error: "Failed to fetch email" },
      { status: 500 }
    );
  }
}
