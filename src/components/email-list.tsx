"use client";

import { formatDistanceToNow } from "date-fns";
import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { Paperclip } from "lucide-react";

interface EmailItem {
  id: string;
  from: string;
  fromName: string | null;
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

interface EmailListProps {
  emails: EmailItem[];
  selectedId?: string;
  onSelect: (id: string) => void;
  isLoading?: boolean;
}

const priorityColors: Record<number, string> = {
  1: "bg-red-500",
  2: "bg-amber-500",
  3: "bg-blue-500",
  4: "bg-gray-400",
  5: "bg-gray-200",
};

export function EmailList({
  emails,
  selectedId,
  onSelect,
  isLoading,
}: EmailListProps) {
  if (isLoading) {
    return (
      <div className="space-y-2 p-4">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="flex gap-3 rounded-lg border p-3">
            <Skeleton className="h-2 w-2 rounded-full mt-2" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-4 w-1/3" />
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-3 w-full" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (emails.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
        <Inbox className="h-12 w-12 mb-3 opacity-30" />
        <p className="text-sm font-medium">No emails yet</p>
        <p className="text-xs mt-1">Connect an account in Settings to get started</p>
      </div>
    );
  }

  return (
    <ScrollArea className="h-full">
      <div className="space-y-1 p-2">
        {emails.map((email) => (
          <button
            key={email.id}
            onClick={() => onSelect(email.id)}
            className={cn(
              "flex w-full gap-3 rounded-lg border p-3 text-left transition-colors hover:bg-accent/50",
              selectedId === email.id && "bg-accent border-primary/20",
              !email.isRead && "bg-primary/[0.02] border-primary/10"
            )}
          >
            {email.classification && (
              <div
                className={cn(
                  "mt-1.5 h-2 w-2 shrink-0 rounded-full",
                  priorityColors[email.classification.priority] ?? "bg-gray-300"
                )}
              />
            )}
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-2">
                <span
                  className={cn(
                    "truncate text-sm",
                    !email.isRead ? "font-semibold" : "font-medium"
                  )}
                >
                  {email.fromName || email.from}
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {formatDistanceToNow(new Date(email.receivedAt), {
                    addSuffix: true,
                  })}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <p
                  className={cn(
                    "truncate text-sm",
                    !email.isRead
                      ? "text-foreground"
                      : "text-muted-foreground"
                  )}
                >
                  {email.subject || "(no subject)"}
                </p>
                {email.hasAttachments && (
                  <Paperclip className="h-3 w-3 shrink-0 text-muted-foreground" />
                )}
              </div>
              <p className="mt-0.5 truncate text-xs text-muted-foreground">
                {email.classification?.summary ?? email.snippet}
              </p>
              <div className="mt-1 flex items-center gap-1.5 flex-wrap">
                <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  {email.account.provider}
                </span>
                {email.classification?.category && (
                  <Badge variant="outline" className="text-[10px] py-0 h-4">
                    {email.classification.category}
                  </Badge>
                )}
                {email.classification?.needsReply && (
                  <Badge variant="destructive" className="text-[10px] py-0 h-4 bg-amber-500">
                    Reply
                  </Badge>
                )}
                {email.classification?.needsApproval && (
                  <Badge variant="destructive" className="text-[10px] py-0 h-4">
                    Approval
                  </Badge>
                )}
              </div>
            </div>
          </button>
        ))}
      </div>
    </ScrollArea>
  );
}

function Inbox({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="22 12 16 12 14 15 10 15 8 12 2 12" />
      <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
    </svg>
  );
}
