import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import MicrosoftEntraId from "next-auth/providers/microsoft-entra-id";
import { PrismaAdapter } from "@auth/prisma-adapter";
import { prisma } from "@/lib/prisma";

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: PrismaAdapter(prisma),
  providers: [
    Google({
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
      authorization: {
        params: {
          scope:
            "openid email profile https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send",
          access_type: "offline",
          prompt: "consent",
        },
      },
    }),
    MicrosoftEntraId({
      clientId: process.env.AZURE_CLIENT_ID!,
      clientSecret: process.env.AZURE_CLIENT_SECRET!,
      authorization: {
        params: {
          scope:
            "openid email profile offline_access https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/Mail.Send",
        },
      },
    }),
  ],
  session: {
    strategy: "jwt",
  },
  callbacks: {
    async jwt({ token, account }) {
      if (account) {
        token.accessToken = account.access_token;
        token.refreshToken = account.refresh_token;
        token.provider = account.provider;
        token.expiresAt = account.expires_at;
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.id = token.sub as string;
      }
      return session;
    },
  },
  events: {
    async signIn({ user, account }) {
      // This event fires AFTER the adapter has created/updated the user and account,
      // so user.id is guaranteed to be available
      if (!account || !user.email || !user.id) return;

      const provider = account.provider === "google" ? "gmail" : "outlook";

      try {
        await prisma.emailAccount.upsert({
          where: {
            userId_provider_email: {
              userId: user.id,
              provider,
              email: user.email,
            },
          },
          create: {
            userId: user.id,
            provider,
            email: user.email,
            accessToken: account.access_token ?? "",
            refreshToken: account.refresh_token ?? "",
            expiresAt: account.expires_at
              ? new Date(account.expires_at * 1000)
              : null,
          },
          update: {
            accessToken: account.access_token ?? "",
            refreshToken: account.refresh_token ?? "",
            expiresAt: account.expires_at
              ? new Date(account.expires_at * 1000)
              : null,
            isActive: true,
          },
        });
      } catch (error) {
        console.error("Failed to create EmailAccount:", error);
      }
    },
  },
  pages: {
    signIn: "/login",
  },
});
