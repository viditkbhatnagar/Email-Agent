"use client";

import { format } from "date-fns";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select";
import { X, Reply, Paperclip, RefreshCw, Loader2, Clock, Check, RotateCcw, Star, ShieldCheck } from "lucide-react";
import { useEffect, useRef } from "react";
import { useReclassifyEmail, useHandleEmail, useOverrideClassification, useToggleVip } from "@/hooks/use-agent";
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
  isVipSender?: boolean;
  account: {
    provider: string;
    email: string;
  };
  classification?: {
    priority: number;
    effectivePriority?: number;
    category: string;
    confidence?: number | null;
    summary: string | null;
    needsReply: boolean;
    needsApproval: boolean;
    actionItems: { description: string; dueDate?: string }[] | null;
    deadline?: string | null;
    handled?: boolean;
    userOverride?: boolean;
    escalationReasons?: string[];
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

const categoryOptions = [
  "approval", "reply-needed", "task", "meeting", "fyi",
  "personal", "support", "finance", "travel", "shipping",
  "security", "social", "notification", "newsletter",
  "marketing", "spam",
];

export function EmailDetail({
  email,
  isLoading,
  onClose,
  onEmailSelect,
}: EmailDetailProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const reclassify = useReclassifyEmail();
  const handleEmail = useHandleEmail();
  const override = useOverrideClassification();
  const toggleVip = useToggleVip();

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

  const effectivePri = email.classification?.effectivePriority ?? email.classification?.priority;
  const priority = effectivePri != null
    ? priorityLabels[effectivePri]
    : null;
  const isHandled = email.classification?.handled ?? false;
  const isUserOverride = email.classification?.userOverride ?? false;

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
          {/* Classification badges + actions */}
          {email.classification && (
            <div className="space-y-2">
              {/* Priority and category badges row */}
              <div className="flex flex-wrap items-center gap-2">
                {/* Priority selector */}
                {priority && (
                  <Select
                    value={String(effectivePri)}
                    onValueChange={(v) =>
                      override.mutate({ emailId: email.id, priority: Number(v) })
                    }
                  >
                    <SelectTrigger className="w-auto h-6 text-xs gap-1 border-0 p-0">
                      <Badge variant={priority.variant}>{priority.label}</Badge>
                    </SelectTrigger>
                    <SelectContent>
                      {[1, 2, 3, 4, 5].map((p) => (
                        <SelectItem key={p} value={String(p)}>
                          {priorityLabels[p].label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
                {/* Escalation reasons */}
                {email.classification.escalationReasons &&
                  email.classification.escalationReasons.length > 0 && (
                  <span
                    className="text-[10px] text-orange-600 bg-orange-50 px-1.5 py-0.5 rounded"
                    title={email.classification.escalationReasons.join(", ")}
                  >
                    {email.classification.escalationReasons[0]}
                    {email.classification.escalationReasons.length > 1 &&
                      ` +${email.classification.escalationReasons.length - 1}`}
                  </span>
                )}
                {/* Category selector */}
                <Select
                  value={email.classification.category}
                  onValueChange={(v) =>
                    override.mutate({ emailId: email.id, category: v })
                  }
                >
                  <SelectTrigger className="w-auto h-6 text-xs gap-1 border-0 p-0">
                    <Badge
                      variant="outline"
                      className={categoryColors[email.classification.category] ?? ""}
                    >
                      {email.classification.category}
                    </Badge>
                  </SelectTrigger>
                  <SelectContent>
                    {categoryOptions.map((cat) => (
                      <SelectItem key={cat} value={cat}>
                        {cat}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {/* Confidence indicator */}
                {email.classification.confidence != null && (
                  <span
                    title={`AI confidence: ${Math.round(email.classification.confidence * 100)}%`}
                    className="flex items-center gap-1 text-[10px] text-muted-foreground"
                  >
                    <span
                      className={`inline-block h-2 w-2 rounded-full ${
                        email.classification.confidence >= 0.85
                          ? "bg-green-500"
                          : email.classification.confidence >= 0.65
                            ? "bg-amber-500"
                            : "bg-red-500"
                      }`}
                    />
                    {email.classification.confidence < 0.65 ? "AI uncertain" : ""}
                  </span>
                )}
                {email.classification.needsReply && !isHandled && (
                  <Badge variant="destructive" className="bg-amber-500">
                    <Reply className="mr-1 h-3 w-3" /> Needs Reply
                  </Badge>
                )}
                {email.classification.needsApproval && !isHandled && (
                  <Badge variant="destructive">Needs Approval</Badge>
                )}
                {email.classification.deadline && (
                  <Badge variant="outline" className="border-orange-400 text-orange-700 bg-orange-50">
                    <Clock className="mr-1 h-3 w-3" />
                    Due {new Date(email.classification.deadline).toLocaleDateString()}
                  </Badge>
                )}
                {isUserOverride && (
                  <Badge variant="outline" className="border-violet-400 text-violet-700 bg-violet-50 text-[10px]">
                    <ShieldCheck className="mr-1 h-3 w-3" /> Override
                  </Badge>
                )}
                {isHandled && (
                  <Badge variant="outline" className="border-green-400 text-green-700 bg-green-50 text-[10px]">
                    <Check className="mr-1 h-3 w-3" /> Handled
                  </Badge>
                )}
              </div>
              {/* Action buttons row */}
              <div className="flex items-center gap-2">
                <Button
                  variant={isHandled ? "outline" : "default"}
                  size="sm"
                  className="text-xs gap-1 h-7"
                  onClick={() =>
                    handleEmail.mutate({
                      emailId: email.id,
                      handled: !isHandled,
                    })
                  }
                  disabled={handleEmail.isPending}
                >
                  {handleEmail.isPending ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : isHandled ? (
                    <RotateCcw className="h-3 w-3" />
                  ) : (
                    <Check className="h-3 w-3" />
                  )}
                  {isHandled ? "Reopen" : "Mark Handled"}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-xs gap-1 h-7"
                  onClick={() => reclassify.mutate(email.id)}
                  disabled={reclassify.isPending || isUserOverride}
                  title={isUserOverride ? "Clear user override first" : "Re-classify with AI"}
                >
                  {reclassify.isPending ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <RefreshCw className="h-3 w-3" />
                  )}
                  Reclassify
                </Button>
              </div>
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
            <div className="flex gap-2 items-center">
              <span className="text-muted-foreground w-12 shrink-0">From</span>
              <span className="font-medium">
                {email.fromName
                  ? `${email.fromName} <${email.from}>`
                  : email.from}
              </span>
              <button
                onClick={() =>
                  toggleVip.mutate({
                    senderEmail: email.from,
                    isVip: !email.isVipSender,
                  })
                }
                className="shrink-0"
                title={email.isVipSender ? "Remove VIP" : "Mark as VIP"}
              >
                <Star
                  className={`h-4 w-4 transition-colors ${
                    email.isVipSender
                      ? "fill-yellow-400 text-yellow-400"
                      : "text-muted-foreground/40 hover:text-yellow-400"
                  }`}
                />
              </button>
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
