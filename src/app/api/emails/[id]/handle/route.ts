import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

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
    const handled = Boolean(body.handled);

    // Verify email exists and belongs to user
    const email = await prisma.email.findUnique({
      where: { id },
      select: {
        id: true,
        account: { select: { userId: true } },
        classification: { select: { id: true } },
      },
    });

    if (!email || email.account.userId !== session.user.id) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    if (!email.classification) {
      return NextResponse.json(
        { error: "Email has no classification" },
        { status: 400 }
      );
    }

    const classification = await prisma.classification.update({
      where: { emailId: id },
      data: {
        handled,
        handledAt: handled ? new Date() : null,
      },
    });

    return NextResponse.json(classification);
  } catch (error) {
    console.error("Error toggling handled state:", error);
    return NextResponse.json(
      { error: "Failed to update handled state" },
      { status: 500 }
    );
  }
}
