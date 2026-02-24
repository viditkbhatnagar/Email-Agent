import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { reclassifySingleEmail } from "@/lib/classifier";
import type { ClassificationInput } from "@/types";

export async function PATCH(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await params;

    // Fetch the email with ownership check
    const email = await prisma.email.findUnique({
      where: { id },
      include: {
        account: { select: { userId: true } },
      },
    });

    if (!email || email.account.userId !== session.user.id) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    // Build classification input
    const input: ClassificationInput = {
      emailId: email.id,
      from: email.from,
      fromName: email.fromName,
      to: email.to,
      cc: email.cc,
      subject: email.subject,
      snippet: email.snippet,
      bodyText: email.bodyText,
      receivedAt: email.receivedAt,
      labels: email.labels,
    };

    // Classify
    const result = await reclassifySingleEmail(input);

    // Upsert classification
    const classification = await prisma.classification.upsert({
      where: { emailId: email.id },
      create: {
        emailId: email.id,
        priority: result.priority,
        category: result.category,
        needsReply: result.needsReply,
        needsApproval: result.needsApproval,
        isThreadActive: result.isThreadActive,
        actionItems: result.actionItems as unknown as undefined,
        summary: result.summary,
        confidence: result.confidence,
        userOverride: false,
      },
      update: {
        priority: result.priority,
        category: result.category,
        needsReply: result.needsReply,
        needsApproval: result.needsApproval,
        isThreadActive: result.isThreadActive,
        actionItems: result.actionItems as unknown as undefined,
        summary: result.summary,
        confidence: result.confidence,
        userOverride: false,
        classifiedAt: new Date(),
      },
    });

    return NextResponse.json(classification);
  } catch (error) {
    console.error("Error reclassifying email:", error);
    return NextResponse.json(
      { error: "Failed to reclassify email" },
      { status: 500 }
    );
  }
}
