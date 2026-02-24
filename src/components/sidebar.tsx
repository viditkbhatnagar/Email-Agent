"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { Inbox, FileEdit, BarChart3, Settings, Mail } from "lucide-react";

const navItems = [
  { label: "Inbox", href: "/", icon: Inbox, enabled: true },
  { label: "Drafts", href: "/drafts", icon: FileEdit, enabled: false },
  { label: "Analytics", href: "/analytics", icon: BarChart3, enabled: false },
  { label: "Settings", href: "/settings", icon: Settings, enabled: true },
];

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="flex h-full w-64 flex-col border-r bg-card">
      <div className="flex h-14 items-center gap-2 border-b px-4">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary">
          <Mail className="h-4 w-4 text-primary-foreground" />
        </div>
        <span className="font-semibold text-lg">MailPilot</span>
      </div>
      <nav className="flex-1 space-y-1 p-3">
        {navItems.map((item) => {
          const isActive =
            item.href === "/"
              ? pathname === "/"
              : pathname.startsWith(item.href);

          return (
            <Link
              key={item.href}
              href={item.enabled ? item.href : "#"}
              className={cn(
                "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                isActive
                  ? "bg-primary/10 text-primary"
                  : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                !item.enabled && "pointer-events-none opacity-40"
              )}
            >
              <item.icon className="h-4 w-4" />
              {item.label}
              {!item.enabled && (
                <span className="ml-auto text-[10px] uppercase tracking-wider text-muted-foreground">
                  Soon
                </span>
              )}
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
