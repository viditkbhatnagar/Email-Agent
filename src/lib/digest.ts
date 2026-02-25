import { prisma } from "@/lib/prisma";

export interface DigestData {
  userId: string;
  userEmail: string;
  period: { from: Date; to: Date };
  urgent: { id: string; from: string; subject: string; priority: number; category: string }[];
  important: { id: string; from: string; subject: string; priority: number; category: string }[];
  upcomingDeadlines: { id: string; subject: string; deadline: Date; priority: number }[];
  autoHandledCount: number;
  totalNewEmails: number;
  categoryBreakdown: Record<string, number>;
}

/**
 * Generate a daily digest for a single user.
 * Summarises the last 24 hours of classified email:
 *   - P1 / P2 items that are NOT handled
 *   - Upcoming deadlines (next 7 days)
 *   - Auto-handled count
 *   - Category breakdown
 */
export async function generateDigest(userId: string): Promise<DigestData | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true, dailyDigestEnabled: true },
  });

  if (!user || !user.dailyDigestEnabled) return null;

  const now = new Date();
  const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const sevenDaysFromNow = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

  // Get all emails classified in the last 24 hours for this user
  const recentClassified = await prisma.classification.findMany({
    where: {
      classifiedAt: { gte: twentyFourHoursAgo },
      email: {
        account: { userId },
      },
    },
    include: {
      email: {
        select: {
          id: true,
          from: true,
          subject: true,
          receivedAt: true,
        },
      },
    },
    orderBy: { priority: "asc" },
  });

  if (recentClassified.length === 0) return null;

  // P1 items (urgent, not handled)
  const urgent = recentClassified
    .filter((c) => c.priority === 1 && !c.handled)
    .map((c) => ({
      id: c.email.id,
      from: c.email.from,
      subject: c.email.subject,
      priority: c.priority,
      category: c.category,
    }));

  // P2 items (important, not handled)
  const important = recentClassified
    .filter((c) => c.priority === 2 && !c.handled)
    .map((c) => ({
      id: c.email.id,
      from: c.email.from,
      subject: c.email.subject,
      priority: c.priority,
      category: c.category,
    }));

  // Upcoming deadlines (next 7 days, not handled)
  const upcomingDeadlines = recentClassified
    .filter(
      (c) =>
        c.deadline &&
        !c.handled &&
        c.deadline > now &&
        c.deadline <= sevenDaysFromNow
    )
    .map((c) => ({
      id: c.email.id,
      subject: c.email.subject,
      deadline: c.deadline!,
      priority: c.priority,
    }))
    .sort((a, b) => a.deadline.getTime() - b.deadline.getTime());

  // Auto-handled count
  const autoHandledCount = recentClassified.filter(
    (c) => c.handled && c.classifierVersion?.includes("rule") || c.handled && c.handledAt && c.handledAt >= twentyFourHoursAgo
  ).length;

  // Category breakdown
  const categoryBreakdown: Record<string, number> = {};
  for (const c of recentClassified) {
    categoryBreakdown[c.category] = (categoryBreakdown[c.category] ?? 0) + 1;
  }

  return {
    userId,
    userEmail: user.email,
    period: { from: twentyFourHoursAgo, to: now },
    urgent,
    important,
    upcomingDeadlines,
    autoHandledCount,
    totalNewEmails: recentClassified.length,
    categoryBreakdown,
  };
}

/**
 * Format a digest into a plain-text summary string.
 */
export function formatDigestText(digest: DigestData): string {
  const lines: string[] = [];

  lines.push(`MailPilot AI — Daily Digest`);
  lines.push(`Period: ${digest.period.from.toISOString().slice(0, 10)} → ${digest.period.to.toISOString().slice(0, 10)}`);
  lines.push(`Total new emails classified: ${digest.totalNewEmails}`);
  lines.push("");

  if (digest.urgent.length > 0) {
    lines.push(`🔴 URGENT (P1) — ${digest.urgent.length} item(s):`);
    for (const e of digest.urgent) {
      lines.push(`  • [${e.category}] ${e.subject} — from ${e.from}`);
    }
    lines.push("");
  }

  if (digest.important.length > 0) {
    lines.push(`🟠 IMPORTANT (P2) — ${digest.important.length} item(s):`);
    for (const e of digest.important) {
      lines.push(`  • [${e.category}] ${e.subject} — from ${e.from}`);
    }
    lines.push("");
  }

  if (digest.upcomingDeadlines.length > 0) {
    lines.push(`📅 Upcoming Deadlines (next 7 days):`);
    for (const d of digest.upcomingDeadlines) {
      const dateStr = d.deadline.toISOString().slice(0, 10);
      lines.push(`  • ${dateStr} — P${d.priority} — ${d.subject}`);
    }
    lines.push("");
  }

  if (digest.autoHandledCount > 0) {
    lines.push(`✅ Auto-handled: ${digest.autoHandledCount} email(s)`);
    lines.push("");
  }

  // Category breakdown
  const sorted = Object.entries(digest.categoryBreakdown).sort(
    (a, b) => b[1] - a[1]
  );
  lines.push("Category breakdown:");
  for (const [cat, count] of sorted) {
    lines.push(`  ${cat}: ${count}`);
  }

  return lines.join("\n");
}

/**
 * Generate digests for all users with dailyDigestEnabled = true.
 * Returns an array of { userId, digest text } for each user.
 */
export async function generateAllDigests(): Promise<
  { userId: string; userEmail: string; text: string }[]
> {
  const users = await prisma.user.findMany({
    where: { dailyDigestEnabled: true },
    select: { id: true },
  });

  const results: { userId: string; userEmail: string; text: string }[] = [];

  for (const user of users) {
    const digest = await generateDigest(user.id);
    if (digest) {
      results.push({
        userId: digest.userId,
        userEmail: digest.userEmail,
        text: formatDigestText(digest),
      });
    }
  }

  return results;
}
