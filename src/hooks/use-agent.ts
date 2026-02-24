"use client";

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
