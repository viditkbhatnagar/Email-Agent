"use client";

import { useState, useCallback } from "react";
import { useEmails, useEmailDetail, useAccounts } from "@/hooks/use-emails";
import { EmailList } from "@/components/email-list";
import { EmailDetail } from "@/components/email-detail";
import { SummaryCards } from "@/components/summary-cards";
import { FilterBar } from "@/components/filter-bar";
import type { EmailFilterParams } from "@/types";

export default function InboxPage() {
  const [selectedEmailId, setSelectedEmailId] = useState<string | null>(null);
  const [filters, setFilters] = useState<EmailFilterParams>({ limit: 50 });

  const { data, isLoading } = useEmails(filters);
  const { data: emailDetail, isLoading: isDetailLoading } =
    useEmailDetail(selectedEmailId);
  const { data: accounts } = useAccounts();

  const handleSummaryCardClick = useCallback((filter: string) => {
    switch (filter) {
      case "needsReply":
        setFilters((prev) => ({
          ...prev,
          actionableOnly: true,
          priority: undefined,
          category: "reply-needed",
        }));
        break;
      case "needsApproval":
        setFilters((prev) => ({
          ...prev,
          actionableOnly: true,
          priority: undefined,
          category: "approval",
        }));
        break;
      case "activeThreads":
        setFilters((prev) => ({
          ...prev,
          priority: [1, 2],
          actionableOnly: false,
          category: undefined,
        }));
        break;
      case "unclassified":
        setFilters({ limit: 50 });
        break;
    }
  }, []);

  return (
    <div className="flex h-full flex-col">
      {/* Summary cards */}
      <div className="border-b px-4 py-3">
        <SummaryCards
          stats={data?.stats}
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
          <div className="flex items-center justify-between border-b px-4 py-2">
            <h2 className="text-sm font-semibold">
              Inbox
              {data?.total ? (
                <span className="ml-2 text-muted-foreground font-normal">
                  ({data.emails.length} of {data.total})
                </span>
              ) : null}
            </h2>
          </div>
          <div className="flex-1 overflow-hidden">
            <EmailList
              emails={data?.emails ?? []}
              selectedId={selectedEmailId ?? undefined}
              onSelect={setSelectedEmailId}
              isLoading={isLoading}
            />
          </div>
        </div>
        <div className="flex-1">
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
