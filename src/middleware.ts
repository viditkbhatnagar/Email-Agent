export { auth as middleware } from "@/lib/auth";

export const config = {
  matcher: [
    // Match all routes except static files, api/auth, and public assets
    "/((?!api/auth|api/agent/cron|_next/static|_next/image|favicon.ico|login).*)",
  ],
};
