import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { runAgentPipeline } from "@/lib/agent-pipeline";

export async function POST(req: NextRequest) {
  try {
    // Authenticate using CRON_SECRET
    const authHeader = req.headers.get("authorization");
    const expectedToken = `Bearer ${process.env.CRON_SECRET}`;

    if (!authHeader || authHeader !== expectedToken) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Get all active users (who have enabled email accounts)
    const recentUsers = await prisma.user.findMany({
      where: {
        emailAccounts: {
          some: { isActive: true },
        },
      },
      select: { id: true, email: true },
    });

    const results: Record<string, unknown> = {};

    for (const user of recentUsers) {
      try {
        const runId = await runAgentPipeline(user.id, "cron");

        const completedRun = await prisma.agentRun.findUnique({
          where: { id: runId },
        });

        results[user.email!] = {
          status: completedRun?.status ?? "completed",
          emailsFetched: completedRun?.emailsFetched ?? 0,
          emailsClassified: completedRun?.emailsClassified ?? 0,
        };
      } catch (error) {
        results[user.email!] = {
          status: "failed",
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    }

    return NextResponse.json({
      message: "Cron job completed",
      usersProcessed: recentUsers.length,
      results,
    });
  } catch (error) {
    console.error("Cron job failed:", error);
    return NextResponse.json(
      { error: "Cron job failed" },
      { status: 500 }
    );
  }
}
