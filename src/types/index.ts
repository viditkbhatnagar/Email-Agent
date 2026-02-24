export interface AttachmentMeta {
  filename: string;
  mimeType: string;
  size?: number;
}

export interface SenderContext {
  totalEmails: number;
  lastEmailAt: Date | null;
  relationship: string | null;
  avgResponseTime: number | null;
}

export interface ThreadContext {
  threadId: string;
  messageCount: number;
  participants: string[];
  latestMessages: {
    from: string;
    fromName: string | null;
    subject: string;
    snippet: string | null;
    receivedAt: Date;
  }[];
  yourRepliesExist: boolean;
}

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
  attachments?: AttachmentMeta[];
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
  | "task"
  | "meeting"
  | "fyi"
  | "personal"
  | "support"
  | "finance"
  | "travel"
  | "shipping"
  | "security"
  | "social"
  | "notification"
  | "newsletter"
  | "marketing"
  | "spam";

export type DraftStatus = "pending" | "approved" | "sent" | "discarded";

// Phase 2 types

export type EmailFolder = "inbox" | "sent";

export interface EmailFilterParams {
  cursor?: string;
  limit?: number;
  folder?: EmailFolder;
  priority?: number[];
  category?: EmailCategory;
  accountId?: string;
  dateFrom?: string;
  dateTo?: string;
  search?: string;
  actionableOnly?: boolean;
  threadId?: string;
  needsReply?: boolean;
  needsApproval?: boolean;
  isThreadActive?: boolean;
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
  bodyHtml?: string | null;
  receivedAt: Date;
  labels: string[];
  threadContext?: ThreadContext | null;
  hasAttachments?: boolean;
  attachments?: AttachmentMeta[];
  senderContext?: SenderContext | null;
  isForwarded?: boolean;
}

export interface BatchClassificationResult {
  emailId: string;
  classification: ClassificationResult;
}
