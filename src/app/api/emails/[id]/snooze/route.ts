import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { z } from "zod";

const SnoozeSchema = z.object({
  snoozedUntil: z.string().nullable(), // ISO date string or null to unsnooze
});

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
    const body = await req.json();
    const parsed = SnoozeSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
    }

    // Verify ownership
    const email = await prisma.email.findUnique({
      where: { id },
      select: { account: { select: { userId: true } }, classification: { select: { id: true } } },
    });
    if (!email || email.account.userId !== session.user.id) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    if (!email.classification) {
      return NextResponse.json({ error: "Email not classified yet" }, { status: 400 });
    }

    const snoozedUntil = parsed.data.snoozedUntil
      ? new Date(parsed.data.snoozedUntil)
      : null;

    if (snoozedUntil && isNaN(snoozedUntil.getTime())) {
      return NextResponse.json({ error: "Invalid date" }, { status: 400 });
    }

    const updated = await prisma.classification.update({
      where: { emailId: id },
      data: { snoozedUntil },
    });

    return NextResponse.json(updated);
  } catch (error) {
    console.error("Error snoozing email:", error);
    return NextResponse.json({ error: "Failed to snooze email" }, { status: 500 });
  }
}
