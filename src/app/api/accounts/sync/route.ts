import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { syncAllAccounts } from "@/lib/email-sync";

export async function POST() {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const result = await syncAllAccounts(session.user.id);

    return NextResponse.json(result);
  } catch (error) {
    console.error("Error syncing accounts:", error);
    return NextResponse.json(
      { error: "Failed to sync accounts" },
      { status: 500 }
    );
  }
}
