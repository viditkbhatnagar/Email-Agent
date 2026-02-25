"use client";

import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Reply, ShieldAlert, MessageSquare, AlertTriangle } from "lucide-react";
import { categoryColors } from "@/lib/category-colors";
import type { DashboardStats } from "@/types";

interface SummaryCardsProps {
  stats: DashboardStats | null | undefined;
  isLoading?: boolean;
  onCardClick: (filter: string) => void;
}

const cards = [
  {
    key: "needsReply" as const,
    label: "Needs Reply",
    icon: Reply,
    colorClasses: "text-red-600 bg-red-50",
  },
  {
    key: "needsApproval" as const,
    label: "Needs Approval",
    icon: ShieldAlert,
    colorClasses: "text-amber-600 bg-amber-50",
  },
  {
    key: "activeThreads" as const,
    label: "Active Threads",
    icon: MessageSquare,
    colorClasses: "text-blue-600 bg-blue-50",
  },
  {
    key: "urgent" as const,
    label: "Urgent (P1+P2)",
    icon: AlertTriangle,
    colorClasses: "text-red-600 bg-red-50",
  },
];

// Display order for category chips
const CATEGORY_ORDER = [
  "approval", "reply-needed", "task", "meeting",
  "fyi", "personal", "support", "finance",
  "travel", "shipping", "security", "social",
  "notification", "newsletter", "marketing", "spam",
];

function getCardValue(
  key: string,
  stats: DashboardStats | null | undefined
): number {
  if (!stats) return 0;
  if (key === "urgent") {
    const pc = stats.priorityCounts;
    return (pc?.[1] ?? 0) + (pc?.[2] ?? 0);
  }
  return (stats as unknown as Record<string, number>)[key] ?? 0;
}

export function SummaryCards({
  stats,
  isLoading,
  onCardClick,
}: SummaryCardsProps) {
  const categoryCounts = stats?.categoryCounts;
  const sortedCategories = categoryCounts
    ? CATEGORY_ORDER.filter((cat) => (categoryCounts[cat] ?? 0) > 0)
    : [];

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-4 gap-3">
        {cards.map((card) => (
          <button
            key={card.key}
            onClick={() => onCardClick(card.key)}
            className="text-left"
          >
            <Card className="py-3 hover:border-primary/30 transition-colors cursor-pointer">
              <CardContent className="flex items-center gap-3 px-4">
                <div
                  className={`flex h-9 w-9 items-center justify-center rounded-lg ${card.colorClasses}`}
                >
                  <card.icon className="h-4 w-4" />
                </div>
                <div>
                  <p className="text-2xl font-bold">
                    {isLoading ? "..." : getCardValue(card.key, stats)}
                  </p>
                  <p className="text-xs text-muted-foreground">{card.label}</p>
                </div>
              </CardContent>
            </Card>
          </button>
        ))}
      </div>
      {sortedCategories.length > 0 && (
        <div className="flex items-center gap-1.5 flex-wrap px-1">
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground mr-1">
            Categories
          </span>
          {sortedCategories.map((cat) => (
            <button
              key={cat}
              onClick={() => onCardClick(`category:${cat}`)}
              className="transition-opacity hover:opacity-80"
            >
              <Badge
                variant="outline"
                className={`text-[10px] py-0 h-5 gap-1 cursor-pointer ${categoryColors[cat] ?? ""}`}
              >
                {cat}
                <span className="font-bold">{categoryCounts![cat]}</span>
              </Badge>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
