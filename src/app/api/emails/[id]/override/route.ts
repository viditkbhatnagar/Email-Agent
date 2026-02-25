import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { z } from "zod";

const ALLOWED_CATEGORIES = [
  "approval", "reply-needed", "task", "meeting", "fyi",
  "personal", "support", "finance", "travel", "shipping",
  "security", "social", "notification", "newsletter",
  "marketing", "spam",
] as const;

const OverrideSchema = z.object({
  priority: z.number().min(1).max(5).optional(),
  category: z.enum(ALLOWED_CATEGORIES).optional(),
  needsReply: z.boolean().optional(),
  needsApproval: z.boolean().optional(),
  isThreadActive: z.boolean().optional(),
  deadline: z.string().nullable().optional(),
});

// Categories that indicate an automated sender when users consistently override to them
const AUTOMATED_CATEGORIES = new Set([
  "notification", "newsletter", "marketing", "spam",
]);

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await params;
    const raw = await req.json();
    const parsed = OverrideSchema.safeParse(raw);

    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid override data", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const body = parsed.data;

    // Verify email exists and belongs to user
    const email = await prisma.email.findUnique({
      where: { id },
      select: {
        id: true,
        from: true,
        account: { select: { userId: true } },
        classification: {
          select: {
            id: true,
            priority: true,
            category: true,
            needsReply: true,
          },
        },
      },
    });

    if (!email || email.account.userId !== session.user.id) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    if (!email.classification) {
      return NextResponse.json(
        { error: "Email has no classification to override" },
        { status: 400 }
      );
    }

    // Build update data from provided fields only
    const updateData: Record<string, unknown> = { userOverride: true };
    if (body.priority !== undefined) updateData.priority = body.priority;
    if (body.category !== undefined) updateData.category = body.category;
    if (body.needsReply !== undefined) updateData.needsReply = body.needsReply;
    if (body.needsApproval !== undefined) updateData.needsApproval = body.needsApproval;
    if (body.isThreadActive !== undefined) updateData.isThreadActive = body.isThreadActive;
    if (body.deadline !== undefined) {
      updateData.deadline = body.deadline ? new Date(body.deadline) : null;
    }

    const classification = await prisma.classification.update({
      where: { emailId: id },
      data: updateData,
    });

    // --- Record classification history for audit trail ---
    prisma.classificationHistory
      .create({
        data: {
          emailId: id,
          priority: classification.priority,
          category: classification.category,
          confidence: classification.confidence,
          classifierVersion: classification.classifierVersion,
          reason: "user-override",
        },
      })
      .catch((err: unknown) =>
        console.error("[Override] ClassificationHistory insert failed:", err)
      );

    // --- Update SenderProfile based on override (fire-and-forget) ---
    updateSenderFromOverride(
      session.user.id,
      email.from,
      email.classification,
      body
    ).catch((err) =>
      console.error("[Override] SenderProfile update failed:", err)
    );

    return NextResponse.json(classification);
  } catch (error) {
    console.error("Error overriding classification:", error);
    return NextResponse.json(
      { error: "Failed to override classification" },
      { status: 500 }
    );
  }
}

/**
 * Update SenderProfile intelligence based on user override.
 * Runs fire-and-forget — failures don't block the override response.
 */
async function updateSenderFromOverride(
  userId: string,
  senderEmail: string,
  original: { priority: number; category: string; needsReply: boolean },
  override: {
    priority?: number;
    category?: string;
    needsReply?: boolean;
  }
): Promise<void> {
  const profileUpdate: Record<string, unknown> = {
    overrideCount: { increment: 1 },
  };

  // If user corrected category, add it to sender's topics
  if (override.category && override.category !== original.category) {
    // Fetch current topics to avoid duplicates
    const existing = await prisma.senderProfile.findUnique({
      where: { userId_senderEmail: { userId, senderEmail } },
      select: { topics: true, isVip: true, relationship: true, overrideCount: true },
    });

    if (existing) {
      // Add corrected category to topics if not already present
      if (!existing.topics.includes(override.category)) {
        profileUpdate.topics = [...existing.topics, override.category];
      }

      // Infer relationship if user consistently overrides to automated categories
      // Threshold: 3+ overrides to automated categories from this sender
      if (
        AUTOMATED_CATEGORIES.has(override.category) &&
        !existing.relationship &&
        existing.overrideCount >= 2 // This is the 3rd+ override (0-indexed after increment)
      ) {
        const automatedTopicCount = existing.topics.filter((t) =>
          AUTOMATED_CATEGORIES.has(t)
        ).length + (AUTOMATED_CATEGORIES.has(override.category) ? 1 : 0);

        if (automatedTopicCount >= 2) {
          profileUpdate.relationship = "automated";
        }
      }
    }
  }

  // Auto-VIP consideration: user overrides priority to P1 or P2
  if (override.priority && override.priority <= 2 && original.priority > 2) {
    const existing = await prisma.senderProfile.findUnique({
      where: { userId_senderEmail: { userId, senderEmail } },
      select: { isVip: true },
    });

    // Only auto-promote to VIP, never auto-demote
    if (existing && !existing.isVip) {
      // Check if user has overridden this sender to high priority multiple times
      const highPriorityOverrides = await prisma.classification.count({
        where: {
          userOverride: true,
          priority: { lte: 2 },
          email: {
            from: senderEmail,
            account: { userId },
          },
        },
      });

      // Auto-VIP after 2+ high-priority overrides from same sender
      if (highPriorityOverrides >= 2) {
        profileUpdate.isVip = true;
        profileUpdate.vipReason = "auto: repeated high-priority overrides";
      }
    }
  }

  await prisma.senderProfile.upsert({
    where: { userId_senderEmail: { userId, senderEmail } },
    create: {
      userId,
      senderEmail,
      totalEmails: 0,
      overrideCount: 1,
      ...(override.category ? { topics: [override.category] } : {}),
    },
    update: profileUpdate,
  });
}
