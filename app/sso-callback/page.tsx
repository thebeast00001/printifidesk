import { AuthenticateWithRedirectCallback } from "@clerk/nextjs";
import { Loader2 } from "lucide-react";

export const metadata = { title: "Signing in" };

/**
 * Where Google sends the browser back. Clerk finishes the exchange here —
 * creating the account on a first visit — and then goes to the address the
 * button asked for. Nothing to see; a spinner so the wait reads as one.
 */
export default function SsoCallbackPage() {
  return (
    <div className="grid min-h-[60dvh] place-items-center">
      <p className="m-0 flex items-center gap-2 text-[13px] text-muted">
        <Loader2 size={15} className="animate-spin" />
        Signing you in…
      </p>
      <AuthenticateWithRedirectCallback />
    </div>
  );
}
