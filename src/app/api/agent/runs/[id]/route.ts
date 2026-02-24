import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

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

    const run = await prisma.agentRun.findUnique({
      where: { id },
    });

    if (!run || run.userId !== session.user.id) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    return NextResponse.json({
      id: run.id,
      status: run.status,
      trigger: run.trigger,
      emailsFetched: run.emailsFetched,
      emailsClassified: run.emailsClassified,
      draftsGenerated: run.draftsGenerated,
      errorMessage: run.errorMessage,
      startedAt: run.startedAt.toISOString(),
      completedAt: run.completedAt?.toISOString() ?? null,
    });
  } catch (error) {
    console.error("Error fetching agent run:", error);
    return NextResponse.json(
      { error: "Failed to fetch agent run" },
      { status: 500 }
    );
  }
}
