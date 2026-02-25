import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { runAgentPipeline } from "@/lib/agent-pipeline";
import { generateAllDigests } from "@/lib/digest";

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

    // --- Generate daily digests after pipeline completes ---
    let digests: { userId: string; userEmail: string; text: string }[] = [];
    try {
      digests = await generateAllDigests();
      // TODO: Send digests via email (e.g., using a transactional email service).
      // For now, log them. Each entry has { userId, userEmail, text }.
      for (const d of digests) {
        console.log(`[Digest] Generated for ${d.userEmail} (${d.text.length} chars)`);
      }
    } catch (digestErr) {
      console.error("[Digest] Failed to generate digests:", digestErr);
    }

    return NextResponse.json({
      message: "Cron job completed",
      usersProcessed: recentUsers.length,
      digestsGenerated: digests.length,
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
