"use client";

import { useState } from "react";
import { formatDistanceToNow } from "date-fns";
import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Paperclip, Check } from "lucide-react";
import { categoryColors } from "@/lib/category-colors";
import { useBulkAction } from "@/hooks/use-agent";

interface EmailItem {
  id: string;
  from: string;
  fromName: string | null;
  to?: string[];
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
    effectivePriority?: number;
    category: string;
    summary: string | null;
    needsReply: boolean;
    needsApproval: boolean;
    deadline?: string | null;
    handled?: boolean;
    userOverride?: boolean;
  } | null;
}

interface EmailListProps {
  emails: EmailItem[];
  selectedId?: string;
  onSelect: (id: string) => void;
  isLoading?: boolean;
  hasMore?: boolean;
  isLoadingMore?: boolean;
  onLoadMore?: () => void;
  folder?: "inbox" | "sent";
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
  hasMore,
  isLoadingMore,
  onLoadMore,
  folder = "inbox",
}: EmailListProps) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const bulkAction = useBulkAction();

  const toggleSelect = (id: string, e: React.MouseEvent) => {
    if (!e.ctrlKey && !e.metaKey && !e.shiftKey) return false;
    e.preventDefault();
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    return true;
  };

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
        <p className="text-sm font-medium">
          {folder === "sent" ? "No sent emails" : "No emails yet"}
        </p>
        <p className="text-xs mt-1">
          {folder === "sent"
            ? "Sent emails will appear here"
            : "Connect an account in Settings to get started"}
        </p>
      </div>
    );
  }

  return (
    <ScrollArea className="h-full">
      <div className="space-y-1 p-2">
        {emails.map((email) => {
          const isHandled = email.classification?.handled ?? false;
          const isSelected = selectedIds.has(email.id);

          return (
            <button
              key={email.id}
              onClick={(e) => {
                if (!toggleSelect(email.id, e)) {
                  onSelect(email.id);
                }
              }}
              className={cn(
                "flex w-full gap-3 rounded-lg border p-3 text-left transition-colors hover:bg-accent/50",
                selectedId === email.id && "bg-accent border-primary/20",
                !email.isRead && !isHandled && "bg-primary/[0.02] border-primary/10",
                isHandled && "opacity-60",
                isSelected && "ring-2 ring-primary/50"
              )}
            >
              {email.classification && (
                <div className="flex flex-col items-center gap-1 mt-1">
                  <div
                    className={cn(
                      "h-2 w-2 shrink-0 rounded-full",
                      priorityColors[email.classification.effectivePriority ?? email.classification.priority] ?? "bg-gray-300"
                    )}
                  />
                  {isHandled && (
                    <Check className="h-3 w-3 text-green-600" />
                  )}
                </div>
              )}
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <span
                    className={cn(
                      "truncate text-sm",
                      !email.isRead && !isHandled ? "font-semibold" : "font-medium"
                    )}
                  >
                    {folder === "sent"
                      ? `To: ${email.to?.[0] ?? "unknown"}`
                      : email.fromName || email.from}
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
                      !email.isRead && !isHandled
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
                  {email.classification?.category ? (
                    <Badge
                      variant="outline"
                      className={cn(
                        "text-[10px] py-0 h-4",
                        categoryColors[email.classification.category] ?? ""
                      )}
                    >
                      {email.classification.category}
                    </Badge>
                  ) : !email.classification && (
                    <Badge variant="outline" className="text-[10px] py-0 h-4 border-slate-300 text-slate-500">
                      Pending
                    </Badge>
                  )}
                  {email.classification?.needsReply && !isHandled && (
                    <Badge variant="destructive" className="text-[10px] py-0 h-4 bg-amber-500">
                      Reply
                    </Badge>
                  )}
                  {email.classification?.needsApproval && !isHandled && (
                    <Badge variant="destructive" className="text-[10px] py-0 h-4">
                      Approval
                    </Badge>
                  )}
                  {email.classification?.userOverride && (
                    <Badge variant="outline" className="text-[10px] py-0 h-4 border-violet-300 text-violet-600">
                      Override
                    </Badge>
                  )}
                </div>
              </div>
            </button>
          );
        })}
        {hasMore && (
          <button
            onClick={onLoadMore}
            disabled={isLoadingMore}
            className="w-full py-3 text-sm text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
          >
            {isLoadingMore ? "Loading..." : "Load more emails"}
          </button>
        )}
      </div>

      {/* Bulk action bar */}
      {selectedIds.size > 0 && (
        <div className="sticky bottom-0 mx-2 mb-2 rounded-lg border bg-background shadow-lg p-3 flex items-center gap-2">
          <span className="text-sm font-medium">
            {selectedIds.size} selected
          </span>
          <Button
            size="sm"
            className="text-xs h-7"
            onClick={() => {
              bulkAction.mutate({
                emailIds: [...selectedIds],
                action: "handle",
              });
              setSelectedIds(new Set());
            }}
            disabled={bulkAction.isPending}
          >
            <Check className="h-3 w-3 mr-1" />
            Mark Handled
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="text-xs h-7"
            onClick={() => setSelectedIds(new Set())}
          >
            Cancel
          </Button>
        </div>
      )}
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
