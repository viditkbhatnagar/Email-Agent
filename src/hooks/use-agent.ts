"use client";

import { useEffect, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { AgentRunStatus } from "@/types";

export function useAgentRun() {
  return useMutation<{ runId: string; status: string }, Error>({
    mutationFn: async () => {
      const res = await fetch("/api/agent/run", { method: "POST" });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to start agent run");
      }
      return res.json();
    },
    onSuccess: () => {
      toast.success("Analysis started");
    },
    onError: (error) => {
      toast.error(error.message || "Failed to start analysis");
    },
  });
}

export function useAgentRunStatus(runId: string | null) {
  return useQuery<AgentRunStatus>({
    queryKey: ["agent-run", runId],
    queryFn: async () => {
      const res = await fetch(`/api/agent/runs/${runId}`);
      if (!res.ok) throw new Error("Failed to fetch run status");
      return res.json();
    },
    enabled: !!runId,
    refetchInterval: (query) => {
      const data = query.state.data;
      if (data?.status === "running") return 2000;
      return false;
    },
  });
}

export function useAgentRuns() {
  return useQuery<AgentRunStatus[]>({
    queryKey: ["agent-runs"],
    queryFn: async () => {
      const res = await fetch("/api/agent/run");
      if (!res.ok) throw new Error("Failed to fetch agent runs");
      return res.json();
    },
  });
}

// Module-level lock shared between auto-sync and manual sync
let syncLock = false;

const SYNC_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

export function useAutoSync() {
  const queryClient = useQueryClient();

  useEffect(() => {
    const sync = async () => {
      if (syncLock) return;
      syncLock = true;
      try {
        const res = await fetch("/api/accounts/sync", { method: "POST" });
        if (res.ok) {
          const data = await res.json();
          if (data.totalFetched > 0) {
            queryClient.invalidateQueries({ queryKey: ["emails"] });
          }
        }
      } catch {
        // Silent fail — background sync shouldn't disrupt the user
      } finally {
        syncLock = false;
      }
    };

    const id = setInterval(sync, SYNC_INTERVAL_MS);
    return () => clearInterval(id);
  }, [queryClient]);
}

export function useManualSync() {
  const queryClient = useQueryClient();

  return useMutation<{ totalFetched: number }, Error, { forceFullSync?: boolean } | void>({
    mutationFn: async (params) => {
      if (syncLock) throw new Error("Sync already in progress");
      syncLock = true;
      try {
        const res = await fetch("/api/accounts/sync", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ forceFullSync: params?.forceFullSync ?? false }),
        });
        if (!res.ok) throw new Error("Failed to sync");
        return res.json();
      } finally {
        syncLock = false;
      }
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["emails"] });
      if (data.totalFetched > 0) {
        toast.success(`Fetched ${data.totalFetched} new email${data.totalFetched === 1 ? "" : "s"}`);
      } else {
        toast.success("Inbox is up to date");
      }
    },
    onError: (error) => {
      if (error.message === "Sync already in progress") {
        toast.info("Sync already in progress");
      } else {
        toast.error("Failed to fetch latest emails");
      }
    },
  });
}

export function useReclassifyEmail() {
  const queryClient = useQueryClient();

  return useMutation<unknown, Error, string>({
    mutationFn: async (emailId: string) => {
      const res = await fetch(`/api/emails/${emailId}/classify`, {
        method: "PATCH",
      });
      if (!res.ok) throw new Error("Failed to reclassify");
      return res.json();
    },
    onSuccess: (_, emailId) => {
      toast.success("Email reclassified");
      queryClient.invalidateQueries({ queryKey: ["email", emailId] });
      queryClient.invalidateQueries({ queryKey: ["emails"] });
    },
    onError: () => {
      toast.error("Failed to reclassify email");
    },
  });
}
