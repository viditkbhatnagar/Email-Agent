"use client";

import { useEffect, useState } from "react";
import { useSession, signOut } from "next-auth/react";
import { useQueryClient } from "@tanstack/react-query";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  LogOut,
  User,
  RefreshCw,
  Loader2,
  CheckCircle,
  XCircle,
} from "lucide-react";
import {
  useAgentRun,
  useAgentRunStatus,
  useAgentRuns,
  useAutoSync,
} from "@/hooks/use-agent";
import { formatDistanceToNow } from "date-fns";

export function Header() {
  const { data: session } = useSession();
  const queryClient = useQueryClient();
  const agentRun = useAgentRun();
  const { data: runs } = useAgentRuns();
  useAutoSync();
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const { data: runStatus } = useAgentRunStatus(activeRunId);

  // When a run starts, track it
  useEffect(() => {
    if (agentRun.data?.runId) {
      setActiveRunId(agentRun.data.runId);
    }
  }, [agentRun.data?.runId]);

  // When a run completes, invalidate email queries
  useEffect(() => {
    if (runStatus?.status === "completed" || runStatus?.status === "failed") {
      queryClient.invalidateQueries({ queryKey: ["emails"] });
      queryClient.invalidateQueries({ queryKey: ["agent-runs"] });
      const timer = setTimeout(() => setActiveRunId(null), 5000);
      return () => clearTimeout(timer);
    }
  }, [runStatus?.status, queryClient]);

  const isRunning = agentRun.isPending || runStatus?.status === "running";
  const lastRun = runs?.[0];

  const handleAnalyze = () => {
    if (isRunning) return;
    agentRun.mutate();
  };

  return (
    <header className="flex h-14 items-center justify-between border-b bg-card px-6">
      <div className="flex items-center gap-4">
        <h1 className="text-sm font-medium text-muted-foreground">
          Smart Email Dashboard
        </h1>
        {/* Last run info */}
        {lastRun && !isRunning && !activeRunId && (
          <span className="text-xs text-muted-foreground">
            Last analyzed{" "}
            {formatDistanceToNow(new Date(lastRun.startedAt), {
              addSuffix: true,
            })}
            {lastRun.emailsClassified > 0 &&
              ` (${lastRun.emailsClassified} classified)`}
          </span>
        )}
        {/* Active run progress */}
        {runStatus?.status === "running" && (
          <span className="text-xs text-blue-600 flex items-center gap-1">
            <Loader2 className="h-3 w-3 animate-spin" />
            Analyzing...
            {runStatus.emailsClassified > 0 &&
              ` (${runStatus.emailsClassified} classified)`}
          </span>
        )}
        {runStatus?.status === "completed" && activeRunId && (
          <span className="text-xs text-green-600 flex items-center gap-1">
            <CheckCircle className="h-3 w-3" />
            Done! {runStatus.emailsClassified} emails classified
          </span>
        )}
        {runStatus?.status === "failed" && activeRunId && (
          <span className="text-xs text-red-600 flex items-center gap-1">
            <XCircle className="h-3 w-3" />
            {runStatus.errorMessage || "Analysis failed"}
          </span>
        )}
      </div>
      <div className="flex items-center gap-3">
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="gap-2"
                disabled={isRunning}
                onClick={handleAnalyze}
              >
                {isRunning ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="h-3.5 w-3.5" />
                )}
                {isRunning ? "Analyzing..." : "Analyze Now"}
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              <p>Sync emails and classify with AI</p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              className="relative h-8 w-8 rounded-full"
            >
              <Avatar className="h-8 w-8">
                <AvatarImage
                  src={session?.user?.image ?? undefined}
                  alt={session?.user?.name ?? "User"}
                />
                <AvatarFallback>
                  <User className="h-4 w-4" />
                </AvatarFallback>
              </Avatar>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <div className="flex items-center gap-2 p-2">
              <div className="flex flex-col space-y-0.5">
                <p className="text-sm font-medium">{session?.user?.name}</p>
                <p className="text-xs text-muted-foreground">
                  {session?.user?.email}
                </p>
              </div>
            </div>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => signOut({ callbackUrl: "/login" })}
            >
              <LogOut className="mr-2 h-4 w-4" />
              Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
