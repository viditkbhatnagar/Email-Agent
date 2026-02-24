"use client";

import { signIn } from "next-auth/react";
import { useAccounts } from "@/hooks/use-emails";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { formatDistanceToNow } from "date-fns";
import { Mail, Plus, RefreshCw, Loader2 } from "lucide-react";
import { toast } from "sonner";

export default function SettingsPage() {
  const { data: accounts, isLoading } = useAccounts();
  const queryClient = useQueryClient();

  const syncMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/accounts/sync", { method: "POST" });
      if (!res.ok) throw new Error("Sync failed");
      return res.json();
    },
    onSuccess: (data) => {
      toast.success(`Synced ${data.totalFetched} emails`);
      queryClient.invalidateQueries({ queryKey: ["emails"] });
      queryClient.invalidateQueries({ queryKey: ["accounts"] });
    },
    onError: () => {
      toast.error("Failed to sync accounts");
    },
  });

  return (
    <div className="p-6 max-w-2xl space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Settings</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Manage your connected email accounts and preferences.
        </p>
      </div>

      <Separator />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Connected Accounts</CardTitle>
          <CardDescription>
            Connect your email accounts to start analyzing emails.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {isLoading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading accounts...
            </div>
          ) : accounts && accounts.length > 0 ? (
            <>
              {accounts.map((account) => (
                <div
                  key={account.id}
                  className="flex items-center justify-between rounded-lg border p-3"
                >
                  <div className="flex items-center gap-3">
                    <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-muted">
                      <Mail className="h-4 w-4" />
                    </div>
                    <div>
                      <p className="text-sm font-medium">{account.email}</p>
                      <div className="flex items-center gap-2 mt-0.5">
                        <Badge variant="outline" className="text-[10px]">
                          {account.provider}
                        </Badge>
                        <span className="text-xs text-muted-foreground">
                          {account._count.emails} emails
                        </span>
                        {account.lastSyncAt && (
                          <span className="text-xs text-muted-foreground">
                            Synced{" "}
                            {formatDistanceToNow(new Date(account.lastSyncAt), {
                              addSuffix: true,
                            })}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                  {account.isActive && (
                    <Badge variant="secondary" className="text-green-700 bg-green-50">
                      Active
                    </Badge>
                  )}
                </div>
              ))}
              <Button
                variant="outline"
                size="sm"
                className="gap-2"
                onClick={() => syncMutation.mutate()}
                disabled={syncMutation.isPending}
              >
                {syncMutation.isPending ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="h-3.5 w-3.5" />
                )}
                Sync All Accounts
              </Button>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              No accounts connected yet.
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Add Account</CardTitle>
          <CardDescription>
            Connect a new email account to analyze.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Button
            variant="outline"
            className="w-full h-11 justify-start gap-3"
            onClick={() => signIn("google", { callbackUrl: "/settings" })}
          >
            <Plus className="h-4 w-4" />
            Connect Gmail Account
          </Button>
          <Button
            variant="outline"
            className="w-full h-11 justify-start gap-3"
            onClick={() =>
              signIn("microsoft-entra-id", { callbackUrl: "/settings" })
            }
          >
            <Plus className="h-4 w-4" />
            Connect Microsoft Account
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
