import { prisma } from "@/lib/prisma";
import { syncAllAccounts } from "@/lib/email-sync";
import { classifyEmails } from "@/lib/classifier";
import { detectResolution } from "@/lib/priority";
import type { ClassifyOptions, OverrideExample } from "@/lib/classifier";
import type {
  ClassificationInput,
  ThreadContext,
  SenderContext,
  AttachmentMeta,
} from "@/types";

const MAX_EMAILS_PER_RUN = 500;

// --- Follow-up & escalation detection ---

const FOLLOW_UP_PATTERNS = [
  /\bfollow(?:ing)?\s*up\b/i,
  /\bchecking\s+in\b/i,
  /\bbump(?:ing)?\b/i,
  /\bcircling\s+back\b/i,
  /\bgentle\s+reminder\b/i,
  /\bjust\s+wanted\s+to\s+check\b/i,
  /\bany\s+update(?:s)?\b/i,
  /\bpending\s+(?:your\s+)?(?:response|reply|feedback|input)\b/i,
  /\bstill\s+(?:waiting|pending|need)\b/i,
  /\bhaven'?t\s+heard\s+back\b/i,
  /\bfriendly\s+reminder\b/i,
];

const ESCALATION_PATTERNS = [
  /\burgent\b/i,
  /\btime[\s-]sensitive\b/i,
  /\basap\b/i,
  /\bescalat(?:ing|ion|ed)\b/i,
  /\bimmediately\b/i,
  /\bcritical\b/i,
  /\bblocking\b/i,
  /\boverdue\b/i,
  /\bfinal\s+(?:notice|reminder|warning)\b/i,
  /\blast\s+chance\b/i,
  /\baction\s+required\b/i,
];

function detectFollowUpSignals(
  subject: string,
  bodyPreview: string
): { isFollowUp: boolean; isEscalation: boolean } {
  const text = `${subject} ${bodyPreview}`;
  const isFollowUp = FOLLOW_UP_PATTERNS.some((p) => p.test(text));
  const isEscalation = ESCALATION_PATTERNS.some((p) => p.test(text));
  return { isFollowUp, isEscalation };
}

// Noreply patterns for relationship inference (reuses classifier logic)
const AUTOMATED_LOCAL_PARTS = new Set([
  "noreply", "no-reply", "do-not-reply", "donotreply",
  "mailer-daemon", "postmaster", "bounce",
  "invitations", "notifications", "notification",
  "alerts", "alert", "digest", "newsletter",
  "marketing", "promo", "automated", "auto",
  "unsubscribe", "marketplace-messages",
]);

function inferRelationship(
  senderEmail: string,
  companyDomains: string[],
  isMailingListSender: boolean
): string | null {
  const lower = senderEmail.toLowerCase();
  const [localPart, domain] = lower.split("@");
  if (!domain) return null;

  // Automated sender
  if (AUTOMATED_LOCAL_PARTS.has(localPart) || /\b(noreply|no-reply)\b/.test(localPart)) {
    return isMailingListSender ? "newsletter" : "automated";
  }
  // Internal / same company
  if (companyDomains.some((d) => domain === d.toLowerCase())) {
    return "internal";
  }
  // Mailing list
  if (isMailingListSender) {
    return "newsletter";
  }
  return null; // Don't infer — let manual label or future logic decide
}

async function updateSenderProfiles(
  userId: string,
  emails: { from: string; fromName: string | null; receivedAt: Date; isMailingList?: boolean }[],
  companyDomains: string[]
): Promise<void> {
  const bySender = new Map<string, typeof emails>();
  for (const e of emails) {
    const arr = bySender.get(e.from) || [];
    arr.push(e);
    bySender.set(e.from, arr);
  }

  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  for (const [senderEmail, senderEmails] of bySender) {
    const latestDate = senderEmails.reduce(
      (max, e) => (e.receivedAt > max ? e.receivedAt : max),
      new Date(0)
    );
    const firstName = senderEmails.find((e) => e.fromName)?.fromName ?? null;
    const recentCount = senderEmails.filter((e) => e.receivedAt >= sevenDaysAgo).length;
    const isMailingListSender = senderEmails.some((e) => e.isMailingList);

    try {
      // Fetch existing profile to decide what to update
      const existing = await prisma.senderProfile.findUnique({
        where: { userId_senderEmail: { userId, senderEmail } },
        select: { relationship: true, recentWindowStart: true },
      });

      // Only infer relationship if not manually set
      const inferredRelationship = !existing?.relationship
        ? inferRelationship(senderEmail, companyDomains, isMailingListSender)
        : undefined;

      // Reset recent window if it's stale (older than 7 days)
      const shouldResetWindow =
        !existing?.recentWindowStart ||
        existing.recentWindowStart < sevenDaysAgo;

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
          relationship: inferredRelationship ?? undefined,
          recentEmailCount: recentCount,
          recentWindowStart: now,
        },
        update: {
          senderName: firstName ?? undefined,
          totalEmails: { increment: senderEmails.length },
          lastEmailAt: latestDate,
          ...(inferredRelationship ? { relationship: inferredRelationship } : {}),
          recentEmailCount: shouldResetWindow
            ? recentCount
            : { increment: recentCount },
          recentWindowStart: shouldResetWindow ? now : undefined,
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

// ── C3: User rule matching ──

function matchGlobPattern(pattern: string, value: string): boolean {
  // Convert glob to regex: * → .*, ? → .
  const escaped = pattern
    .toLowerCase()
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`).test(value.toLowerCase());
}

interface MatchedRule {
  ruleId: string;
  category?: string | null;
  priority?: number | null;
  needsReply?: boolean | null;
  autoHandle?: boolean | null;
}

function matchUserRules(
  email: { from: string; subject: string; isMailingList?: boolean; hasAttachments?: boolean },
  rules: {
    id: string;
    senderPattern: string | null;
    subjectPattern: string | null;
    isMailingList: boolean | null;
    hasAttachments: boolean | null;
    category: string | null;
    priority: number | null;
    needsReply: boolean | null;
    autoHandle: boolean | null;
  }[]
): MatchedRule | null {
  for (const rule of rules) {
    let matches = true;

    if (rule.senderPattern && !matchGlobPattern(rule.senderPattern, email.from)) {
      matches = false;
    }
    if (rule.subjectPattern && !email.subject.toLowerCase().includes(rule.subjectPattern.toLowerCase())) {
      matches = false;
    }
    if (rule.isMailingList !== null && rule.isMailingList !== !!email.isMailingList) {
      matches = false;
    }
    if (rule.hasAttachments !== null && rule.hasAttachments !== !!email.hasAttachments) {
      matches = false;
    }

    if (matches) {
      return {
        ruleId: rule.id,
        category: rule.category,
        priority: rule.priority,
        needsReply: rule.needsReply,
        autoHandle: rule.autoHandle,
      };
    }
  }
  return null;
}

// ── Classification history helper ──

async function recordClassificationHistory(
  emailId: string,
  priority: number,
  category: string,
  confidence: number | null,
  classifierVersion: string | null,
  reason: string
): Promise<void> {
  try {
    await prisma.classificationHistory.create({
      data: {
        emailId,
        priority,
        category,
        confidence,
        classifierVersion,
        reason,
      },
    });
  } catch (error) {
    console.error(`[Pipeline] Failed to record classification history for ${emailId}:`, error);
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
        isMailingList: true,
        listId: true,
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

    // Step 3d: Fetch user rules for rule-based classification
    const userRules = await prisma.userRule.findMany({
      where: { userId, isActive: true },
      orderBy: { createdAt: "asc" },
    });

    // Step 4: Build enriched ClassificationInput + apply user rules
    const inputs: ClassificationInput[] = [];
    const ruleMatchedResults: { emailId: string; rule: MatchedRule }[] = [];

    for (const e of unclassifiedEmails) {
      // Check user rules first — matched emails skip GPT entirely
      if (userRules.length > 0) {
        const matched = matchUserRules(
          { from: e.from, subject: e.subject, isMailingList: e.isMailingList, hasAttachments: e.hasAttachments },
          userRules
        );
        if (matched) {
          ruleMatchedResults.push({ emailId: e.id, rule: matched });
          continue; // Skip GPT classification
        }
      }

      // Thread context
      let threadContext: ThreadContext | null = null;
      if (e.threadId && threadMap.has(e.threadId)) {
        const siblings = threadMap.get(e.threadId)!;
        const participants = [
          ...new Set(siblings.flatMap((s) => [s.from, ...s.to, ...s.cc])),
        ];

        // B1: Detect reply-to-your-email
        const sortedSiblings = [...siblings].sort(
          (a, b) => b.receivedAt.getTime() - a.receivedAt.getTime()
        );
        const previousMsg = sortedSiblings.find(
          (s) => s.receivedAt < e.receivedAt && s.id !== e.id
        );
        const isReplyToYou = previousMsg
          ? userEmails.has(previousMsg.from.toLowerCase())
          : false;

        // B2: Thread fatigue detection
        const userReplies = siblings.filter((s) =>
          userEmails.has(s.from.toLowerCase())
        );
        const latestUserReply = userReplies.length > 0
          ? userReplies.reduce((latest, s) =>
              s.receivedAt > latest.receivedAt ? s : latest
            )
          : null;
        const msPerDay = 24 * 60 * 60 * 1000;
        const daysSinceUserReply = latestUserReply
          ? (Date.now() - latestUserReply.receivedAt.getTime()) / msPerDay
          : Infinity;
        const threadFatigueDetected =
          siblings.length >= 10 && daysSinceUserReply > 3;

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
          yourRepliesExist: userReplies.length > 0,
          isReplyToYou,
          threadFatigueDetected,
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
            recentEmailCount: sp.recentEmailCount,
            isVip: sp.isVip,
          }
        : null;

      // Parse attachments from JSON
      const attachments: AttachmentMeta[] | undefined =
        e.attachments && Array.isArray(e.attachments)
          ? (e.attachments as unknown as AttachmentMeta[])
          : undefined;

      // Recipient analysis: is user in TO (directly addressed) vs CC only
      const isDirectlyAddressed = e.to.some((addr) =>
        userEmails.has(addr.toLowerCase())
      );

      // Follow-up & escalation detection
      const { isFollowUp, isEscalation } = detectFollowUpSignals(
        e.subject,
        e.snippet ?? e.bodyText?.slice(0, 300) ?? ""
      );

      inputs.push({
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
        recipientCount: e.to.length + e.cc.length,
      });
    }

    // Step 4b: Store rule-matched classifications (skip GPT)
    let ruleStored = 0;
    for (const { emailId, rule } of ruleMatchedResults) {
      try {
        const classification = {
          priority: rule.priority ?? 4,
          category: rule.category ?? "notification",
          needsReply: rule.needsReply ?? false,
          needsApproval: false,
          isThreadActive: false,
          actionItems: [] as object[],
          deadline: null as Date | null,
          summary: "Matched user rule",
          confidence: 1.0,
          classifierVersion: "user-rule",
          originalPriority: rule.priority ?? 4,
          originalCategory: rule.category ?? "notification",
          topics: [] as string[],
          sentiment: "neutral",
          handled: rule.autoHandle ?? false,
          handledAt: rule.autoHandle ? new Date() : null,
        };

        await prisma.classification.upsert({
          where: { emailId },
          create: { emailId, ...classification },
          update: { ...classification, classifiedAt: new Date() },
        });

        // Record history
        await recordClassificationHistory(
          emailId,
          classification.priority,
          classification.category,
          1.0,
          "user-rule",
          "user-rule"
        );

        // Increment rule match count
        await prisma.userRule.update({
          where: { id: rule.ruleId },
          data: { matchCount: { increment: 1 } },
        });

        ruleStored++;
      } catch (error) {
        console.error(`[Pipeline] Failed to store rule-matched classification for ${emailId}:`, error);
      }
    }

    if (ruleStored > 0) {
      console.log(`[Pipeline] Applied user rules to ${ruleStored} emails (skipped GPT)`);
    }

    // Step 4c: Build ClassifyOptions — override history + company domains
    const currentBatchSenders = new Set(
      unclassifiedEmails.map((e) => e.from.toLowerCase())
    );

    const [recentOverrides, user] = await Promise.all([
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
        take: 40, // Over-fetch so we can prioritize same-sender overrides
      }),
      prisma.user.findUnique({
        where: { id: userId },
        select: { companyDomains: true },
      }),
    ]);

    // Prioritize same-sender overrides, then most recent
    const sameSenderOverrides = recentOverrides.filter((o) =>
      currentBatchSenders.has(o.email.from.toLowerCase())
    );
    const otherOverrides = recentOverrides.filter(
      (o) => !currentBatchSenders.has(o.email.from.toLowerCase())
    );
    const prioritizedOverrides = [
      ...sameSenderOverrides.slice(0, 10), // Up to 10 same-sender overrides
      ...otherOverrides,
    ].slice(0, 20); // Total cap: 20

    // Group overrides by sender+category pattern for concise few-shot representation
    const overrideExamples: OverrideExample[] = [];
    const patternCounts = new Map<string, number>();

    for (const o of prioritizedOverrides) {
      const patternKey = `${o.email.from.toLowerCase()}|${o.category}`;
      const count = patternCounts.get(patternKey) ?? 0;
      patternCounts.set(patternKey, count + 1);

      // Include max 2 examples per sender+category pattern (avoid redundancy)
      if (count < 2) {
        overrideExamples.push({
          from: o.email.from,
          subject: o.email.subject,
          originalPriority: o.originalPriority ?? o.priority,
          originalCategory: o.originalCategory ?? o.category,
          correctedPriority: o.priority,
          correctedCategory: o.category,
          correctedNeedsReply: o.needsReply,
        });
      }
    }

    // Step 4d: Compute self-tuning confidence thresholds based on override rates
    let confidenceOverrides: Record<string, number> | undefined;
    if (recentOverrides.length >= 5) {
      const allRecentClassifications = await prisma.classification.findMany({
        where: {
          email: { accountId: { in: accountIds } },
          classifiedAt: {
            gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
          },
        },
        select: { category: true, userOverride: true },
      });

      const categoryStats = new Map<string, { total: number; overrides: number }>();
      for (const c of allRecentClassifications) {
        const stats = categoryStats.get(c.category) ?? { total: 0, overrides: 0 };
        stats.total++;
        if (c.userOverride) stats.overrides++;
        categoryStats.set(c.category, stats);
      }

      const BASE_THRESHOLDS: Record<string, number> = {
        spam: 0.6, newsletter: 0.6, marketing: 0.6, social: 0.6,
        shipping: 0.6, notification: 0.6, meeting: 0.65, travel: 0.65,
        finance: 0.7, security: 0.7, personal: 0.7, support: 0.7,
        fyi: 0.75, task: 0.75, "reply-needed": 0.80, approval: 0.8,
      };

      confidenceOverrides = {};
      for (const [category, stats] of categoryStats) {
        if (stats.total < 5) continue;
        const overrideRate = stats.overrides / stats.total;
        if (overrideRate > 0.2) {
          const reduction = Math.min(0.15, (overrideRate - 0.2) * 0.5 + 0.05);
          const base = BASE_THRESHOLDS[category] ?? 0.7;
          confidenceOverrides[category] = Math.max(0.4, base - reduction);
          console.log(
            `[Pipeline] Self-tuning: category "${category}" override rate ${(overrideRate * 100).toFixed(0)}% → threshold lowered from ${base} to ${confidenceOverrides[category].toFixed(2)}`
          );
        }
      }

      if (Object.keys(confidenceOverrides).length === 0) {
        confidenceOverrides = undefined;
      }
    }

    const classifyOptions: ClassifyOptions = {
      companyDomains: user?.companyDomains ?? [],
      overrideExamples: overrideExamples.length > 0 ? overrideExamples : undefined,
      confidenceOverrides,
    };

    // Step 5: Classify using GPT-5.2 (only emails not matched by rules)
    let stored = 0;
    let skippedInvalid = 0;
    let skippedOverride = 0;

    if (inputs.length > 0) {
      const { results, errors } = await classifyEmails(inputs, classifyOptions);

      // Step 6: Store classifications in DB
      const validEmailIds = new Set(unclassifiedEmails.map((e) => e.id));

      // Pre-fetch existing classifications with userOverride to avoid overwriting
      const existingOverrides = await prisma.classification.findMany({
        where: {
          emailId: { in: [...validEmailIds] },
          userOverride: true,
        },
        select: { emailId: true },
      });
      const overrideSet = new Set(existingOverrides.map((c) => c.emailId));

      for (const result of results) {
        if (!validEmailIds.has(result.emailId)) {
          console.warn(
            `[Pipeline] Skipping classification for unknown emailId: ${result.emailId}`
          );
          skippedInvalid++;
          continue;
        }

        // Respect user overrides — never auto-overwrite manual corrections
        if (overrideSet.has(result.emailId)) {
          console.log(
            `[Pipeline] Skipping ${result.emailId} — user override active`
          );
          skippedOverride++;
          continue;
        }

        try {
          const deadlineDate = result.classification.deadline
            ? new Date(result.classification.deadline)
            : null;
          const validDeadline =
            deadlineDate && !isNaN(deadlineDate.getTime()) ? deadlineDate : null;

          // Record history before upsert
          await recordClassificationHistory(
            result.emailId,
            result.classification.priority,
            result.classification.category,
            result.classification.confidence,
            "v3-gpt52-enriched",
            "initial"
          );

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
              deadline: validDeadline,
              summary: result.classification.summary,
              confidence: result.classification.confidence,
              originalPriority: result.classification.priority,
              originalCategory: result.classification.category,
              classifierVersion: "v3-gpt52-enriched",
              topics: result.classification.topics ?? [],
              sentiment: result.classification.sentiment ?? "neutral",
            },
            update: {
              priority: result.classification.priority,
              category: result.classification.category,
              needsReply: result.classification.needsReply,
              needsApproval: result.classification.needsApproval,
              isThreadActive: result.classification.isThreadActive,
              actionItems: result.classification.actionItems as object[],
              deadline: validDeadline,
              summary: result.classification.summary,
              confidence: result.classification.confidence,
              originalPriority: result.classification.priority,
              originalCategory: result.classification.category,
              classifiedAt: new Date(),
              classifierVersion: "v3-gpt52-enriched",
              topics: result.classification.topics ?? [],
              sentiment: result.classification.sentiment ?? "neutral",
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

      // Log any GPT errors
      if (errors.length > 0) {
        console.warn(`[Pipeline] ${errors.length} classification errors`);
      }
    }

    // Step 6b: Update sender profiles
    await updateSenderProfiles(
      userId,
      unclassifiedEmails.map((e) => ({
        from: e.from,
        fromName: e.fromName,
        receivedAt: e.receivedAt,
        isMailingList: e.isMailingList,
      })),
      user?.companyDomains ?? []
    );

    // Step 6c: Detect hot threads and re-classify stale siblings
    const newEmailsByThread = new Map<string, number>();
    for (const e of unclassifiedEmails) {
      if (e.threadId) {
        newEmailsByThread.set(
          e.threadId,
          (newEmailsByThread.get(e.threadId) ?? 0) + 1
        );
      }
    }
    const hotThreadIds = [...newEmailsByThread.entries()]
      .filter(([, count]) => count >= 3)
      .map(([tid]) => tid);

    if (hotThreadIds.length > 0) {
      const newEmailIds = new Set(unclassifiedEmails.map((e) => e.id));

      // B4: Detect thread resolution in latest messages
      for (const tid of hotThreadIds) {
        const threadSiblings = threadMap.get(tid);
        if (!threadSiblings || threadSiblings.length === 0) continue;

        const latestMsg = threadSiblings[0]; // Already sorted desc
        const isResolved = detectResolution(
          latestMsg.subject,
          latestMsg.snippet ?? undefined
        );

        if (isResolved) {
          // Mark older unhandled emails in this thread as resolved
          await prisma.classification.updateMany({
            where: {
              email: {
                accountId: { in: accountIds },
                threadId: tid,
                id: { notIn: [...newEmailIds] },
              },
              userOverride: false,
              handled: false,
            },
            data: { threadResolved: true },
          });
          console.log(`[Pipeline] Thread ${tid} detected as resolved`);
        }
      }

      // Find older classified (non-overridden) emails in hot threads
      const staleEmails = await prisma.email.findMany({
        where: {
          accountId: { in: accountIds },
          threadId: { in: hotThreadIds },
          id: { notIn: [...newEmailIds] },
          classification: {
            userOverride: false,
            handled: false,
            threadResolved: false,
          },
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
        take: 50,
      });

      if (staleEmails.length > 0) {
        console.log(
          `[Pipeline] Re-classifying ${staleEmails.length} stale emails in ${hotThreadIds.length} hot threads`
        );

        const staleInputs: ClassificationInput[] = staleEmails.map((e) => {
          let threadContext: ThreadContext | null = null;
          if (e.threadId && threadMap.has(e.threadId)) {
            const siblings = threadMap.get(e.threadId)!;
            const participants = [
              ...new Set(
                siblings.flatMap((s) => [s.from, ...s.to, ...s.cc])
              ),
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
              }
            : null;

          const attachments: AttachmentMeta[] | undefined =
            e.attachments && Array.isArray(e.attachments)
              ? (e.attachments as unknown as AttachmentMeta[])
              : undefined;

          const staleIsDirectlyAddressed = e.to.some((addr) =>
            userEmails.has(addr.toLowerCase())
          );
          const staleFollowUp = detectFollowUpSignals(
            e.subject,
            e.snippet ?? e.bodyText?.slice(0, 300) ?? ""
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
            isDirectlyAddressed: staleIsDirectlyAddressed,
            isFollowUp: staleFollowUp.isFollowUp,
            isEscalation: staleFollowUp.isEscalation,
            recipientCount: e.to.length + e.cc.length,
          };
        });

        try {
          const { results: reResults } = await classifyEmails(staleInputs, classifyOptions);
          let reStored = 0;
          for (const result of reResults) {
            try {
              const deadlineDate = result.classification.deadline
                ? new Date(result.classification.deadline)
                : null;
              const validDeadline =
                deadlineDate && !isNaN(deadlineDate.getTime())
                  ? deadlineDate
                  : null;

              await recordClassificationHistory(
                result.emailId,
                result.classification.priority,
                result.classification.category,
                result.classification.confidence,
                "v3-gpt52-enriched",
                "hot-thread"
              );

              await prisma.classification.update({
                where: { emailId: result.emailId },
                data: {
                  priority: result.classification.priority,
                  category: result.classification.category,
                  needsReply: result.classification.needsReply,
                  needsApproval: result.classification.needsApproval,
                  isThreadActive: result.classification.isThreadActive,
                  actionItems:
                    result.classification.actionItems as object[],
                  deadline: validDeadline,
                  summary: result.classification.summary,
                  confidence: result.classification.confidence,
                  classifiedAt: new Date(),
                  classifierVersion: "v3-gpt52-enriched",
                  topics: result.classification.topics ?? [],
                  sentiment: result.classification.sentiment ?? "neutral",
                },
              });
              reStored++;
            } catch {
              // Individual email update failure — continue with others
            }
          }
          console.log(
            `[Pipeline] Re-classified ${reStored} stale emails in hot threads`
          );
        } catch (error) {
          console.error(
            "[Pipeline] Hot-thread re-classification failed:",
            error
          );
        }
      }
    }

    // Step 6d: Apply auto-actions
    try {
      const autoActions = await prisma.autoAction.findMany({
        where: { userId, isActive: true },
      });

      if (autoActions.length > 0) {
        for (const action of autoActions) {
          const [triggerType, triggerValue] = action.trigger.split(":");
          if (!triggerType || !triggerValue) continue;

          const matchFilter: Record<string, unknown> = {
            email: { accountId: { in: accountIds } },
            handled: false,
            classifiedAt: { gte: new Date(Date.now() - 60 * 60 * 1000) }, // Only recent (last hour)
          };

          if (triggerType === "priority") {
            matchFilter.priority = parseInt(triggerValue);
          } else if (triggerType === "category") {
            matchFilter.category = triggerValue;
          }

          if (action.action === "handle") {
            const updated = await prisma.classification.updateMany({
              where: matchFilter,
              data: { handled: true, handledAt: new Date() },
            });
            if (updated.count > 0) {
              await prisma.autoAction.update({
                where: { id: action.id },
                data: { matchCount: { increment: updated.count } },
              });
              console.log(
                `[Pipeline] Auto-action "${action.trigger}" → "${action.action}": ${updated.count} emails`
              );
            }
          }
        }
      }
    } catch (error) {
      console.error("[Pipeline] Auto-actions failed:", error);
    }

    // Step 7: Update AgentRun with final status
    const totalStored = stored + ruleStored;

    console.log(
      `[Pipeline] Stored ${stored} GPT + ${ruleStored} rule-matched classifications, ${skippedInvalid} skipped (invalid ID), ${skippedOverride} skipped (user override)`
    );

    await prisma.agentRun.update({
      where: { id: agentRun.id },
      data: {
        emailsClassified: totalStored,
        status: totalStored === 0 && inputs.length > 0 ? "failed" : "completed",
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
