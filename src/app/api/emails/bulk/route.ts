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

const BulkActionSchema = z.object({
  emailIds: z.array(z.string()).min(1).max(100),
  action: z.enum(["handle", "unhandle", "override"]),
  overrideData: z
    .object({
      priority: z.number().min(1).max(5).optional(),
      category: z.enum(ALLOWED_CATEGORIES).optional(),
      needsReply: z.boolean().optional(),
      needsApproval: z.boolean().optional(),
    })
    .optional(),
});

export async function PATCH(req: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const raw = await req.json();
    const parsed = BulkActionSchema.safeParse(raw);

    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const { emailIds, action, overrideData } = parsed.data;

    // Verify ownership of all emailIds
    const ownedEmails = await prisma.email.findMany({
      where: {
        id: { in: emailIds },
        account: { userId: session.user.id },
      },
      select: { id: true },
    });
    const validIds = ownedEmails.map((e) => e.id);

    if (validIds.length === 0) {
      return NextResponse.json({ error: "No valid emails found" }, { status: 404 });
    }

    let updated = 0;

    switch (action) {
      case "handle":
        ({ count: updated } = await prisma.classification.updateMany({
          where: { emailId: { in: validIds } },
          data: { handled: true, handledAt: new Date() },
        }));
        break;

      case "unhandle":
        ({ count: updated } = await prisma.classification.updateMany({
          where: { emailId: { in: validIds } },
          data: { handled: false, handledAt: null },
        }));
        break;

      case "override":
        if (!overrideData) {
          return NextResponse.json(
            { error: "overrideData required for override action" },
            { status: 400 }
          );
        }
        ({ count: updated } = await prisma.classification.updateMany({
          where: { emailId: { in: validIds } },
          data: { ...overrideData, userOverride: true },
        }));
        break;
    }

    return NextResponse.json({ updated, requested: emailIds.length });
  } catch (error) {
    console.error("Error processing bulk action:", error);
    return NextResponse.json(
      { error: "Failed to process bulk action" },
      { status: 500 }
    );
  }
}
