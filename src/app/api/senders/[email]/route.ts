import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ email: string }> }
) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { email: senderEmail } = await params;
    const decodedEmail = decodeURIComponent(senderEmail);
    const body = await req.json();

    const updateData: Record<string, unknown> = {};
    if (typeof body.isVip === "boolean") updateData.isVip = body.isVip;
    if (typeof body.vipReason === "string") updateData.vipReason = body.vipReason;
    if (typeof body.relationship === "string") updateData.relationship = body.relationship;

    const profile = await prisma.senderProfile.upsert({
      where: {
        userId_senderEmail: {
          userId: session.user.id,
          senderEmail: decodedEmail,
        },
      },
      create: {
        userId: session.user.id,
        senderEmail: decodedEmail,
        isVip: body.isVip ?? false,
        vipReason: body.vipReason ?? null,
        relationship: body.relationship ?? null,
        totalEmails: 0,
      },
      update: updateData,
    });

    return NextResponse.json(profile);
  } catch (error) {
    console.error("Error updating sender profile:", error);
    return NextResponse.json(
      { error: "Failed to update sender profile" },
      { status: 500 }
    );
  }
}
