"use client";

import { useQuery, useInfiniteQuery } from "@tanstack/react-query";
import type { EmailFilterParams, DashboardStats } from "@/types";

interface EmailListItem {
  id: string;
  from: string;
  fromName: string | null;
  to: string[];
  subject: string;
  snippet: string | null;
  receivedAt: string;
  isRead: boolean;
  hasAttachments: boolean;
  account: {
    provider: string;
    email: string;
  };
  classification?: {
    priority: number;
    category: string;
    summary: string | null;
    needsReply: boolean;
    needsApproval: boolean;
  } | null;
}

interface EmailDetail {
  id: string;
  from: string;
  fromName: string | null;
  to: string[];
  cc: string[];
  subject: string;
  threadId?: string | null;
  bodyHtml: string | null;
  bodyText: string | null;
  receivedAt: string;
  isRead: boolean;
  hasAttachments: boolean;
  account: {
    provider: string;
    email: string;
  };
  classification?: {
    priority: number;
    category: string;
    summary: string | null;
    needsReply: boolean;
    needsApproval: boolean;
    actionItems: { description: string; dueDate?: string }[] | null;
  } | null;
}

interface EmailsResponse {
  emails: EmailListItem[];
  total: number;
  cursor?: string;
  stats?: DashboardStats;
}

function buildSearchParams(params?: EmailFilterParams, cursor?: string) {
  const searchParams = new URLSearchParams();
  if (cursor) searchParams.set("cursor", cursor);
  if (params?.limit) searchParams.set("limit", params.limit.toString());
  if (params?.priority?.length)
    searchParams.set("priority", params.priority.join(","));
  if (params?.category) searchParams.set("category", params.category);
  if (params?.accountId) searchParams.set("accountId", params.accountId);
  if (params?.dateFrom) searchParams.set("dateFrom", params.dateFrom);
  if (params?.dateTo) searchParams.set("dateTo", params.dateTo);
  if (params?.search) searchParams.set("search", params.search);
  if (params?.actionableOnly) searchParams.set("actionableOnly", "true");
  if (params?.needsReply) searchParams.set("needsReply", "true");
  if (params?.needsApproval) searchParams.set("needsApproval", "true");
  if (params?.isThreadActive) searchParams.set("isThreadActive", "true");
  if (params?.threadId) searchParams.set("threadId", params.threadId);
  if (params?.folder) searchParams.set("folder", params.folder);
  searchParams.set("includeStats", "true");
  return searchParams;
}

export function useEmails(params?: EmailFilterParams) {
  return useInfiniteQuery<EmailsResponse>({
    queryKey: ["emails", params],
    queryFn: async ({ pageParam }) => {
      const searchParams = buildSearchParams(params, pageParam as string | undefined);
      const res = await fetch(`/api/emails?${searchParams}`);
      if (!res.ok) throw new Error("Failed to fetch emails");
      return res.json();
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.cursor ?? undefined,
  });
}

export function useEmailDetail(id: string | null) {
  return useQuery<EmailDetail>({
    queryKey: ["email", id],
    queryFn: async () => {
      const res = await fetch(`/api/emails/${id}`);
      if (!res.ok) throw new Error("Failed to fetch email");
      return res.json();
    },
    enabled: !!id,
  });
}

export function useAccounts() {
  return useQuery<
    {
      id: string;
      provider: string;
      email: string;
      lastSyncAt: string | null;
      isActive: boolean;
      _count: { emails: number };
    }[]
  >({
    queryKey: ["accounts"],
    queryFn: async () => {
      const res = await fetch("/api/accounts");
      if (!res.ok) throw new Error("Failed to fetch accounts");
      return res.json();
    },
  });
}
