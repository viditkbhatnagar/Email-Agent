import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { runAgentPipeline } from "@/lib/agent-pipeline";

export async function POST() {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Check if there's already a running pipeline
    const existingRun = await prisma.agentRun.findFirst({
      where: { userId: session.user.id, status: "running" },
    });
    if (existingRun) {
      // Auto-fail runs stuck for more than 10 minutes
      const ageMs = Date.now() - new Date(existingRun.startedAt).getTime();
      if (ageMs > 10 * 60 * 1000) {
        await prisma.agentRun.update({
          where: { id: existingRun.id },
          data: {
            status: "failed",
            errorMessage: "Run timed out (exceeded 10 minutes)",
            completedAt: new Date(),
          },
        });
      } else {
        return NextResponse.json({
          runId: existingRun.id,
          status: "running",
          message: "A run is already in progress",
        });
      }
    }

    // Create agent run record upfront so we can return the ID immediately
    const agentRun = await prisma.agentRun.create({
      data: {
        userId: session.user.id,
        trigger: "manual",
        status: "running",
      },
    });

    // Fire and forget — pipeline runs in background
    runAgentPipeline(session.user.id, "manual", agentRun.id).catch(
      (error) => {
        console.error("Background pipeline failed:", error);
      }
    );

    return NextResponse.json({
      runId: agentRun.id,
      status: "running",
    });
  } catch (error) {
    console.error("Agent run failed:", error);
    return NextResponse.json(
      { error: "Agent run failed" },
      { status: 500 }
    );
  }
}

export async function GET() {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const runs = await prisma.agentRun.findMany({
      where: { userId: session.user.id },
      orderBy: { startedAt: "desc" },
      take: 10,
    });

    return NextResponse.json(runs);
  } catch (error) {
    console.error("Error fetching agent runs:", error);
    return NextResponse.json(
      { error: "Failed to fetch agent runs" },
      { status: 500 }
    );
  }
}
