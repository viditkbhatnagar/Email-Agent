"use client";

import { format } from "date-fns";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { ScrollArea } from "@/components/ui/scroll-area";
import { X, Reply, Paperclip, RefreshCw, Loader2 } from "lucide-react";
import { useEffect, useRef } from "react";
import { useReclassifyEmail } from "@/hooks/use-agent";
import { ThreadChain } from "@/components/thread-chain";
import { categoryColors } from "@/lib/category-colors";

interface EmailDetailData {
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

interface EmailDetailProps {
  email: EmailDetailData | null;
  isLoading?: boolean;
  onClose: () => void;
  onEmailSelect?: (id: string) => void;
}

const priorityLabels: Record<
  number,
  { label: string; variant: "default" | "secondary" | "destructive" | "outline" }
> = {
  1: { label: "P1 - Immediate", variant: "destructive" },
  2: { label: "P2 - Important", variant: "default" },
  3: { label: "P3 - Moderate", variant: "secondary" },
  4: { label: "P4 - Low", variant: "outline" },
  5: { label: "P5 - Noise", variant: "outline" },
};

export function EmailDetail({
  email,
  isLoading,
  onClose,
  onEmailSelect,
}: EmailDetailProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const reclassify = useReclassifyEmail();

  useEffect(() => {
    if (email?.bodyHtml && iframeRef.current) {
      const doc = iframeRef.current.contentDocument;
      if (doc) {
        doc.open();
        doc.write(`
          <!DOCTYPE html>
          <html>
          <head>
            <style>
              body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; font-size: 14px; line-height: 1.6; color: #333; margin: 16px; }
              img { max-width: 100%; height: auto; }
              a { color: #2563eb; }
              pre { background: #f5f5f5; padding: 12px; border-radius: 6px; overflow-x: auto; }
            </style>
          </head>
          <body>${email.bodyHtml}</body>
          </html>
        `);
        doc.close();

        // Auto-resize iframe
        const resizeObserver = new ResizeObserver(() => {
          if (iframeRef.current && doc.body) {
            iframeRef.current.style.height = doc.body.scrollHeight + "px";
          }
        });
        if (doc.body) resizeObserver.observe(doc.body);
        return () => resizeObserver.disconnect();
      }
    }
  }, [email?.bodyHtml]);

  if (isLoading) {
    return (
      <div className="flex flex-col h-full border-l">
        <div className="flex items-center justify-between border-b p-4">
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-8 w-8" />
        </div>
        <div className="space-y-4 p-6">
          <Skeleton className="h-4 w-1/3" />
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-32 w-full" />
        </div>
      </div>
    );
  }

  if (!email) {
    return (
      <div className="flex h-full items-center justify-center border-l text-muted-foreground">
        <p className="text-sm">Select an email to view</p>
      </div>
    );
  }

  const priority = email.classification
    ? priorityLabels[email.classification.priority]
    : null;

  return (
    <div className="flex h-full flex-col border-l">
      <div className="flex items-center justify-between border-b px-4 py-3">
        <h2 className="text-sm font-semibold truncate pr-4">
          {email.subject || "(no subject)"}
        </h2>
        <Button
          variant="ghost"
          size="icon"
          onClick={onClose}
          className="shrink-0"
        >
          <X className="h-4 w-4" />
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="p-4 space-y-4">
          {/* Classification badges + reclassify button */}
          {email.classification && (
            <div className="flex flex-wrap items-center gap-2">
              {priority && (
                <Badge variant={priority.variant}>{priority.label}</Badge>
              )}
              <Badge
                variant="outline"
                className={categoryColors[email.classification.category] ?? ""}
              >
                {email.classification.category}
              </Badge>
              {email.classification.needsReply && (
                <Badge variant="destructive" className="bg-amber-500">
                  <Reply className="mr-1 h-3 w-3" /> Needs Reply
                </Badge>
              )}
              {email.classification.needsApproval && (
                <Badge variant="destructive">Needs Approval</Badge>
              )}
              <Button
                variant="ghost"
                size="sm"
                className="ml-auto text-xs gap-1 h-7"
                onClick={() => reclassify.mutate(email.id)}
                disabled={reclassify.isPending}
              >
                {reclassify.isPending ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <RefreshCw className="h-3 w-3" />
                )}
                Reclassify
              </Button>
            </div>
          )}

          {/* AI Summary */}
          {email.classification?.summary && (
            <div className="rounded-lg bg-muted/50 p-3">
              <p className="text-xs font-medium text-muted-foreground mb-1">
                AI Summary
              </p>
              <p className="text-sm">{email.classification.summary}</p>
            </div>
          )}

          {/* Sender & recipients */}
          <div className="space-y-1.5 text-sm">
            <div className="flex gap-2">
              <span className="text-muted-foreground w-12 shrink-0">From</span>
              <span className="font-medium">
                {email.fromName
                  ? `${email.fromName} <${email.from}>`
                  : email.from}
              </span>
            </div>
            <div className="flex gap-2">
              <span className="text-muted-foreground w-12 shrink-0">To</span>
              <span>{email.to.join(", ")}</span>
            </div>
            {email.cc.length > 0 && (
              <div className="flex gap-2">
                <span className="text-muted-foreground w-12 shrink-0">CC</span>
                <span>{email.cc.join(", ")}</span>
              </div>
            )}
            <div className="flex gap-2">
              <span className="text-muted-foreground w-12 shrink-0">Date</span>
              <span>
                {format(new Date(email.receivedAt), "PPP 'at' p")}
              </span>
            </div>
            {email.hasAttachments && (
              <div className="flex items-center gap-1 text-muted-foreground">
                <Paperclip className="h-3.5 w-3.5" />
                <span>Has attachments</span>
              </div>
            )}
          </div>

          {/* Action items */}
          {email.classification?.actionItems &&
            Array.isArray(email.classification.actionItems) &&
            email.classification.actionItems.length > 0 && (
              <div className="rounded-lg border p-3">
                <p className="text-xs font-medium text-muted-foreground mb-2">
                  Action Items
                </p>
                <ul className="space-y-1">
                  {email.classification.actionItems.map(
                    (
                      item: { description: string; dueDate?: string },
                      i: number
                    ) => (
                      <li
                        key={i}
                        className="flex items-start gap-2 text-sm"
                      >
                        <input
                          type="checkbox"
                          className="mt-0.5 rounded"
                          readOnly
                        />
                        <span>{item.description}</span>
                        {item.dueDate && (
                          <Badge
                            variant="outline"
                            className="text-[10px] ml-auto"
                          >
                            Due: {item.dueDate}
                          </Badge>
                        )}
                      </li>
                    )
                  )}
                </ul>
              </div>
            )}

          {/* Thread chain */}
          <ThreadChain
            threadId={email.threadId}
            currentEmailId={email.id}
            onEmailSelect={onEmailSelect ?? (() => {})}
          />

          {/* Email body */}
          <div className="border-t pt-4">
            {email.bodyHtml ? (
              <iframe
                ref={iframeRef}
                className="w-full border-0"
                sandbox="allow-same-origin"
                title="Email content"
                style={{ minHeight: "200px" }}
              />
            ) : (
              <pre className="whitespace-pre-wrap text-sm font-sans">
                {email.bodyText}
              </pre>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
