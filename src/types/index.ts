export interface NormalizedEmail {
  externalId: string;
  threadId?: string;
  from: string;
  fromName?: string;
  to: string[];
  cc: string[];
  subject: string;
  snippet?: string;
  bodyText?: string;
  bodyHtml?: string;
  receivedAt: Date;
  isRead: boolean;
  hasAttachments: boolean;
  labels: string[];
}

export interface SyncResult {
  emails: NormalizedEmail[];
  newSyncCursor?: string;
}

export interface ClassificationResult {
  priority: number;
  category: string;
  needsReply: boolean;
  needsApproval: boolean;
  isThreadActive: boolean;
  actionItems: { description: string; dueDate?: string }[];
  summary: string;
  confidence: number;
}

export interface AgentRunResult {
  runId: string;
  emailsFetched: number;
  emailsClassified: number;
  draftsGenerated: number;
  status: "completed" | "failed";
  errorMessage?: string;
}

export type EmailProvider = "gmail" | "outlook";

export type Priority = 1 | 2 | 3 | 4 | 5;

export type EmailCategory =
  | "approval"
  | "reply-needed"
  | "meeting"
  | "fyi"
  | "newsletter"
  | "notification"
  | "spam"
  | "personal";

export type DraftStatus = "pending" | "approved" | "sent" | "discarded";

// Phase 2 types

export interface EmailFilterParams {
  cursor?: string;
  limit?: number;
  priority?: number[];
  category?: EmailCategory;
  accountId?: string;
  dateFrom?: string;
  dateTo?: string;
  search?: string;
  actionableOnly?: boolean;
  threadId?: string;
}

export interface DashboardStats {
  needsReply: number;
  needsApproval: number;
  activeThreads: number;
  unclassified: number;
}

export interface AgentRunStatus {
  id: string;
  status: "running" | "completed" | "failed";
  trigger: "manual" | "cron";
  emailsFetched: number;
  emailsClassified: number;
  draftsGenerated: number;
  errorMessage?: string | null;
  startedAt: string;
  completedAt?: string | null;
}

export interface ClassificationInput {
  emailId: string;
  from: string;
  fromName?: string | null;
  to: string[];
  cc: string[];
  subject: string;
  snippet?: string | null;
  bodyText?: string | null;
  receivedAt: Date;
  labels: string[];
}

export interface BatchClassificationResult {
  emailId: string;
  classification: ClassificationResult;
}
