"use client";

import { useQuery } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";

interface ThreadEmail {
  id: string;
  from: string;
  fromName: string | null;
  subject: string;
  snippet: string | null;
  receivedAt: string;
}

interface ThreadChainProps {
  threadId: string | null | undefined;
  currentEmailId: string;
  onEmailSelect: (id: string) => void;
}

export function ThreadChain({
  threadId,
  currentEmailId,
  onEmailSelect,
}: ThreadChainProps) {
  const { data: response } = useQuery<{ emails: ThreadEmail[] }>({
    queryKey: ["thread", threadId],
    queryFn: async () => {
      const res = await fetch(
        `/api/emails?threadId=${threadId}&limit=20`
      );
      if (!res.ok) throw new Error("Failed to fetch thread");
      return res.json();
    },
    enabled: !!threadId,
  });

  const threadEmails = response?.emails;

  if (!threadId || !threadEmails || threadEmails.length <= 1) return null;

  return (
    <div className="rounded-lg border p-3">
      <p className="text-xs font-medium text-muted-foreground mb-2">
        Thread ({threadEmails.length} messages)
      </p>
      <div className="space-y-1.5">
        {threadEmails.map((email) => (
          <button
            key={email.id}
            onClick={() => onEmailSelect(email.id)}
            className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs transition-colors hover:bg-accent/50 ${
              email.id === currentEmailId ? "bg-accent" : ""
            }`}
          >
            <span className="truncate font-medium flex-1">
              {email.fromName || email.from}
            </span>
            <span className="shrink-0 text-muted-foreground">
              {formatDistanceToNow(new Date(email.receivedAt), {
                addSuffix: true,
              })}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
