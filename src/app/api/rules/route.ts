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

const CreateRuleSchema = z.object({
  name: z.string().min(1).max(200),
  senderPattern: z.string().nullable().optional(),
  subjectPattern: z.string().nullable().optional(),
  isMailingList: z.boolean().nullable().optional(),
  hasAttachments: z.boolean().nullable().optional(),
  category: z.enum(ALLOWED_CATEGORIES).nullable().optional(),
  priority: z.number().min(1).max(5).nullable().optional(),
  needsReply: z.boolean().nullable().optional(),
  autoHandle: z.boolean().nullable().optional(),
});

const UpdateRuleSchema = CreateRuleSchema.partial().extend({
  isActive: z.boolean().optional(),
});

// GET: List all rules for the user
export async function GET() {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const rules = await prisma.userRule.findMany({
      where: { userId: session.user.id },
      orderBy: { createdAt: "asc" },
    });

    return NextResponse.json({ rules });
  } catch (error) {
    console.error("Error fetching rules:", error);
    return NextResponse.json({ error: "Failed to fetch rules" }, { status: 500 });
  }
}

// POST: Create a new rule
export async function POST(req: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await req.json();
    const parsed = CreateRuleSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request body", details: parsed.error.format() },
        { status: 400 }
      );
    }

    // At least one condition must be set
    const { senderPattern, subjectPattern, isMailingList, hasAttachments } = parsed.data;
    if (!senderPattern && !subjectPattern && isMailingList == null && hasAttachments == null) {
      return NextResponse.json(
        { error: "At least one condition (senderPattern, subjectPattern, isMailingList, hasAttachments) is required" },
        { status: 400 }
      );
    }

    // At least one action must be set
    const { category, priority, needsReply, autoHandle } = parsed.data;
    if (!category && priority == null && needsReply == null && autoHandle == null) {
      return NextResponse.json(
        { error: "At least one action (category, priority, needsReply, autoHandle) is required" },
        { status: 400 }
      );
    }

    const rule = await prisma.userRule.create({
      data: {
        userId: session.user.id,
        name: parsed.data.name,
        senderPattern: senderPattern ?? null,
        subjectPattern: subjectPattern ?? null,
        isMailingList: isMailingList ?? null,
        hasAttachments: hasAttachments ?? null,
        category: category ?? null,
        priority: priority ?? null,
        needsReply: needsReply ?? null,
        autoHandle: autoHandle ?? null,
      },
    });

    return NextResponse.json(rule, { status: 201 });
  } catch (error) {
    console.error("Error creating rule:", error);
    return NextResponse.json({ error: "Failed to create rule" }, { status: 500 });
  }
}

// PATCH: Update an existing rule (pass id in body)
export async function PATCH(req: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await req.json();
    const { id, ...updateData } = body;
    if (!id || typeof id !== "string") {
      return NextResponse.json({ error: "Rule id is required" }, { status: 400 });
    }

    const parsed = UpdateRuleSchema.safeParse(updateData);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request body", details: parsed.error.format() },
        { status: 400 }
      );
    }

    // Verify ownership
    const existing = await prisma.userRule.findUnique({ where: { id } });
    if (!existing || existing.userId !== session.user.id) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const updated = await prisma.userRule.update({
      where: { id },
      data: parsed.data,
    });

    return NextResponse.json(updated);
  } catch (error) {
    console.error("Error updating rule:", error);
    return NextResponse.json({ error: "Failed to update rule" }, { status: 500 });
  }
}

// DELETE: Delete a rule (pass id in query param)
export async function DELETE(req: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const id = req.nextUrl.searchParams.get("id");
    if (!id) {
      return NextResponse.json({ error: "Rule id is required" }, { status: 400 });
    }

    // Verify ownership
    const existing = await prisma.userRule.findUnique({ where: { id } });
    if (!existing || existing.userId !== session.user.id) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    await prisma.userRule.delete({ where: { id } });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Error deleting rule:", error);
    return NextResponse.json({ error: "Failed to delete rule" }, { status: 500 });
  }
}
