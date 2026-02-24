"use client";

import { useState, useCallback, useMemo } from "react";
import { useEmails, useEmailDetail, useAccounts } from "@/hooks/use-emails";
import { useManualSync } from "@/hooks/use-agent";
import { EmailList } from "@/components/email-list";
import { EmailDetail } from "@/components/email-detail";
import { SummaryCards } from "@/components/summary-cards";
import { FilterBar } from "@/components/filter-bar";
import { Button } from "@/components/ui/button";
import { RefreshCw, Loader2 } from "lucide-react";
import type { EmailFilterParams, EmailFolder } from "@/types";

export default function InboxPage() {
  const [selectedEmailId, setSelectedEmailId] = useState<string | null>(null);
  const [folder, setFolder] = useState<EmailFolder>("inbox");
  const [filters, setFilters] = useState<EmailFilterParams>({ limit: 50 });
  const manualSync = useManualSync();

  const mergedFilters = useMemo(
    () => ({ ...filters, folder }),
    [filters, folder]
  );

  const {
    data,
    isLoading,
    hasNextPage,
    isFetchingNextPage,
    fetchNextPage,
  } = useEmails(mergedFilters);
  const { data: emailDetail, isLoading: isDetailLoading } =
    useEmailDetail(selectedEmailId);
  const { data: accounts } = useAccounts();

  const allEmails = useMemo(
    () => data?.pages.flatMap((page) => page.emails) ?? [],
    [data]
  );
  const stats = data?.pages[0]?.stats;
  const total = data?.pages[0]?.total;

  const handleSummaryCardClick = useCallback((filter: string) => {
    setFolder("inbox");
    switch (filter) {
      case "needsReply":
        setFilters((prev) => ({
          ...prev,
          needsReply: true,
          needsApproval: undefined,
          isThreadActive: undefined,
          actionableOnly: false,
          priority: undefined,
          category: undefined,
        }));
        break;
      case "needsApproval":
        setFilters((prev) => ({
          ...prev,
          needsApproval: true,
          needsReply: undefined,
          isThreadActive: undefined,
          actionableOnly: false,
          priority: undefined,
          category: undefined,
        }));
        break;
      case "activeThreads":
        setFilters((prev) => ({
          ...prev,
          isThreadActive: true,
          needsReply: undefined,
          needsApproval: undefined,
          actionableOnly: false,
          priority: undefined,
          category: undefined,
        }));
        break;
      case "unclassified":
        setFilters({ limit: 50 });
        break;
    }
  }, []);

  const handleFolderChange = (f: EmailFolder) => {
    setFolder(f);
    setSelectedEmailId(null);
    setFilters({ limit: 50 });
  };

  return (
    <div className="flex h-full flex-col">
      {/* Summary cards */}
      <div className="border-b px-4 py-3">
        <SummaryCards
          stats={stats}
          isLoading={isLoading}
          onCardClick={handleSummaryCardClick}
        />
      </div>

      {/* Main content area */}
      <div className="flex flex-1 overflow-hidden">
        <div className="w-full max-w-xl border-r flex flex-col">
          <FilterBar
            filters={filters}
            onFiltersChange={setFilters}
            accounts={accounts?.map((a) => ({
              id: a.id,
              email: a.email,
              provider: a.provider,
            }))}
          />
          {/* Folder tabs + Fetch Latest */}
          <div className="flex items-center justify-between border-b px-4 py-2">
            <div className="flex items-center gap-1">
              <button
                onClick={() => handleFolderChange("inbox")}
                className={`px-3 py-1 text-sm rounded-md transition-colors ${
                  folder === "inbox"
                    ? "bg-primary text-primary-foreground font-semibold"
                    : "text-muted-foreground hover:text-foreground hover:bg-accent"
                }`}
              >
                Inbox
                {folder === "inbox" && total ? (
                  <span className="ml-1.5 font-normal opacity-80">
                    ({allEmails.length} of {total})
                  </span>
                ) : null}
              </button>
              <button
                onClick={() => handleFolderChange("sent")}
                className={`px-3 py-1 text-sm rounded-md transition-colors ${
                  folder === "sent"
                    ? "bg-primary text-primary-foreground font-semibold"
                    : "text-muted-foreground hover:text-foreground hover:bg-accent"
                }`}
              >
                Sent
                {folder === "sent" && total ? (
                  <span className="ml-1.5 font-normal opacity-80">
                    ({allEmails.length} of {total})
                  </span>
                ) : null}
              </button>
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="gap-1.5 text-xs h-7"
              disabled={manualSync.isPending}
              onClick={() => manualSync.mutate()}
            >
              {manualSync.isPending ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <RefreshCw className="h-3 w-3" />
              )}
              {manualSync.isPending ? "Syncing..." : "Fetch Latest"}
            </Button>
          </div>
          <div className="flex-1 overflow-hidden">
            <EmailList
              emails={allEmails}
              selectedId={selectedEmailId ?? undefined}
              onSelect={setSelectedEmailId}
              isLoading={isLoading}
              hasMore={hasNextPage}
              isLoadingMore={isFetchingNextPage}
              onLoadMore={() => fetchNextPage()}
              folder={folder}
            />
          </div>
        </div>
        <div className="flex-1 overflow-hidden">
          <EmailDetail
            email={emailDetail ?? null}
            isLoading={isDetailLoading && !!selectedEmailId}
            onClose={() => setSelectedEmailId(null)}
            onEmailSelect={setSelectedEmailId}
          />
        </div>
      </div>
    </div>
  );
}
