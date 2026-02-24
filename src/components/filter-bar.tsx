"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Search, X, Filter } from "lucide-react";
import type { EmailFilterParams, EmailCategory } from "@/types";

interface FilterBarProps {
  filters: EmailFilterParams;
  onFiltersChange: (filters: EmailFilterParams) => void;
  accounts?: { id: string; email: string; provider: string }[];
}

const priorityOptions = [
  { value: 1, label: "P1", color: "bg-red-500" },
  { value: 2, label: "P2", color: "bg-amber-500" },
  { value: 3, label: "P3", color: "bg-blue-500" },
  { value: 4, label: "P4", color: "bg-gray-400" },
  { value: 5, label: "P5", color: "bg-gray-200" },
];

const categoryOptions: { value: EmailCategory; label: string }[] = [
  // Action-oriented
  { value: "approval", label: "Approval" },
  { value: "reply-needed", label: "Reply Needed" },
  { value: "task", label: "Task" },
  { value: "meeting", label: "Meeting" },
  // Informational
  { value: "fyi", label: "FYI" },
  { value: "personal", label: "Personal" },
  { value: "support", label: "Support" },
  // Transactional
  { value: "finance", label: "Finance" },
  { value: "travel", label: "Travel" },
  { value: "shipping", label: "Shipping" },
  { value: "security", label: "Security" },
  // Automated / bulk
  { value: "social", label: "Social" },
  { value: "notification", label: "Notification" },
  { value: "newsletter", label: "Newsletter" },
  { value: "marketing", label: "Marketing" },
  { value: "spam", label: "Spam" },
];

export function FilterBar({
  filters,
  onFiltersChange,
  accounts,
}: FilterBarProps) {
  const [searchInput, setSearchInput] = useState(filters.search ?? "");

  const updateFilter = (
    key: keyof EmailFilterParams,
    value: unknown
  ) => {
    onFiltersChange({ ...filters, [key]: value });
  };

  const togglePriority = (p: number) => {
    const current = filters.priority ?? [];
    const next = current.includes(p)
      ? current.filter((v) => v !== p)
      : [...current, p];
    updateFilter("priority", next.length > 0 ? next : undefined);
  };

  const clearFilters = () => {
    setSearchInput("");
    onFiltersChange({ limit: filters.limit });
  };

  const hasActiveFilters = !!(
    filters.priority?.length ||
    filters.category ||
    filters.accountId ||
    filters.search ||
    filters.actionableOnly
  );

  const handleSearchSubmit = () => {
    updateFilter("search", searchInput || undefined);
  };

  return (
    <div className="space-y-2 border-b px-4 py-3">
      {/* Top row: search + category + account + actionable toggle */}
      <div className="flex items-center gap-2">
        <div className="relative flex-1 max-w-xs">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            placeholder="Search emails..."
            className="pl-8 h-8 text-sm"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSearchSubmit()}
          />
        </div>

        <Select
          value={filters.category ?? "all"}
          onValueChange={(v) =>
            updateFilter("category", v === "all" ? undefined : v)
          }
        >
          <SelectTrigger className="w-[140px] h-8 text-sm">
            <SelectValue placeholder="Category" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Categories</SelectItem>
            {categoryOptions.map((c) => (
              <SelectItem key={c.value} value={c.value}>
                {c.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {accounts && accounts.length > 1 && (
          <Select
            value={filters.accountId ?? "all"}
            onValueChange={(v) =>
              updateFilter("accountId", v === "all" ? undefined : v)
            }
          >
            <SelectTrigger className="w-[180px] h-8 text-sm">
              <SelectValue placeholder="Account" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Accounts</SelectItem>
              {accounts.map((a) => (
                <SelectItem key={a.id} value={a.id}>
                  {a.email}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        <Button
          variant={filters.actionableOnly ? "default" : "outline"}
          size="sm"
          className="text-xs gap-1.5 h-8"
          onClick={() =>
            updateFilter("actionableOnly", !filters.actionableOnly || undefined)
          }
        >
          <Filter className="h-3 w-3" />
          Actionable Only
        </Button>

        {hasActiveFilters && (
          <Button
            variant="ghost"
            size="sm"
            onClick={clearFilters}
            className="text-xs gap-1 h-8"
          >
            <X className="h-3 w-3" />
            Clear
          </Button>
        )}
      </div>

      {/* Priority pills row */}
      <div className="flex items-center gap-1.5">
        <span className="text-xs text-muted-foreground mr-1">Priority:</span>
        {priorityOptions.map((p) => {
          const isActive = filters.priority?.includes(p.value);
          return (
            <button key={p.value} onClick={() => togglePriority(p.value)}>
              <Badge
                variant={isActive ? "default" : "outline"}
                className="text-[10px] gap-1 cursor-pointer"
              >
                <span
                  className={`h-1.5 w-1.5 rounded-full ${p.color}`}
                />
                {p.label}
              </Badge>
            </button>
          );
        })}
      </div>
    </div>
  );
}
