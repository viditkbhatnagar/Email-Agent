"use client";

import { Card, CardContent } from "@/components/ui/card";
import { Reply, ShieldAlert, MessageSquare, HelpCircle } from "lucide-react";
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
    key: "unclassified" as const,
    label: "Unclassified",
    icon: HelpCircle,
    colorClasses: "text-gray-600 bg-gray-50",
  },
];

export function SummaryCards({
  stats,
  isLoading,
  onCardClick,
}: SummaryCardsProps) {
  return (
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
                  {isLoading ? "..." : (stats?.[card.key] ?? 0)}
                </p>
                <p className="text-xs text-muted-foreground">{card.label}</p>
              </div>
            </CardContent>
          </Card>
        </button>
      ))}
    </div>
  );
}
