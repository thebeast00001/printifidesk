"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth, useClerk } from "@clerk/nextjs";
import { AnimatePresence, motion } from "motion/react";
import { ArrowLeft, KeyRound, Loader2, LogIn, MailCheck, UserPlus } from "lucide-react";
import Link from "next/link";
import { sameOriginPath } from "@/lib/surface";
import { cn, easeIos } from "@/lib/utils";

type Mode = "sign-in" | "create" | "forgot";

/**
 * The desk's door: email and password.
 *
 * Deliberately not the student's Google button and not Clerk's modal — the
 * desk is a different product with a different key. Three flows, all
 * Clerk's own resource API, so Clerk still does the hashing, the breach
 * check, the email codes and the session:
 *
 *   sign in   → signIn.create({ strategy: "password" })
 *   create    → signUp.create + an emailed code
 *   forgot    → signIn.create({ strategy: "reset_password_email_code" }) +
 *               attemptFirstFactor with the code and the new password
 *
 * Each ends in setActive(), and from then on the session is exactly what a
 * Google one is: RLS, is_staff() and the write guard see no difference.
 */
export function DeskDoor({ next }: { next: string }) {
  const router = useRouter();
  const clerk = useClerk();
  const { isLoaded, isSignedIn } = useAuth();
  const [mode, setMode] = useState<Mode>("sign-in");
  const target = sameOriginPath(next, "/operator");

  // Already in: the door is behind you.
  useEffect(() => {
    if (isLoaded && isSignedIn) router.replace(target);
  }, [isLoaded, isSignedIn, router, target]);

  if (!isLoaded || isSignedIn) {
    return (
      <Shell>
        <p className="m-0 flex items-center gap-2 text-[13px] text-muted">
          <Loader2 size={15} className="animate-spin" />
          One moment…
        </p>
      </Shell>
    );
  }

  async function activate(sessionId: string | null) {
    if (!sessionId) throw new Error("Clerk didn't complete the sign-in.");
    await clerk.setActive({ session: sessionId });
    router.replace(target);
  }

  return (
    <Shell>
      <AnimatePresence mode="wait" initial={false}>
        {mode === "sign-in" ? (
          <Pane key="in">
            <SignInPane
              onDone={activate}
              onCreate={() => setMode("create")}
              onForgot={() => setMode("forgot")}
            />
          </Pane>
        ) : mode === "create" ? (
          <Pane key="create">
            <CreatePane onDone={activate} onBack={() => setMode("sign-in")} />
          </Pane>
        ) : (
          <Pane key="forgot">
            <ForgotPane onDone={activate} onBack={() => setMode("sign-in")} />
          </Pane>
        )}
      </AnimatePresence>
      {/* Clerk's bot check renders here during account creation. Without this
          element a custom sign-up on an instance with bot protection fails. */}
      <div id="clerk-captcha" className="mt-3 empty:hidden" />
    </Shell>
  );
}

/* ---------- sign in ---------- */

function SignInPane({
  onDone,
  onCreate,
  onForgot,
}: {
  onDone: (sessionId: string | null) => Promise<void>;
  onCreate: () => void;
  onForgot: () => void;
}) {
  const clerk = useClerk();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!clerk.client) return;
    setBusy(true);
    setError(null);
    try {
      const result = await clerk.client.signIn.create({
        strategy: "password",
        identifier: email.trim(),
        password,
      });
      if (result.status === "complete") return await onDone(result.createdSessionId);
      if (result.status === "needs_second_factor") {
        throw new Error("This account has two-step verification on, which the desk door doesn't do yet.");
      }
      throw new Error(`Sign-in stopped at "${result.status}".`);
    } catch (e) {
      setError(clerkMessage(e));
      setBusy(false);
    }
  }

  return (
    <>
      <Heading icon={<LogIn size={13} strokeWidth={2.4} />} eyebrow="Printifi Desk" title="Sign in" />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        className="mt-4 flex flex-col gap-2"
      >
        <Field
          type="email"
          autoComplete="email"
          value={email}
          onChange={setEmail}
          placeholder="Email"
          label="Email"
          autoFocus
        />
        <Field
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={setPassword}
          placeholder="Password"
          label="Password"
        />
        <Primary busy={busy} disabled={!email.trim() || !password}>
          Sign in
        </Primary>
      </form>
      {error && <Problem>{error}</Problem>}
      <div className="mt-4 flex flex-wrap justify-between gap-x-4 gap-y-1.5 text-[12px] text-muted">
        <button onClick={onForgot} className="font-semibold underline-offset-2 hover:underline">
          Forgot password
        </button>
        <button onClick={onCreate} className="font-semibold underline-offset-2 hover:underline">
          Create a desk account
        </button>
      </div>
      <p className="m-0 mt-3 text-[11px] leading-relaxed text-muted">
        Signed in with Google before? <i>Forgot password</i> sets one for that same account.
        Getting onto a desk still takes a join code from whoever runs it.
      </p>
    </>
  );
}

/* ---------- create account ---------- */

function CreatePane({
  onDone,
  onBack,
}: {
  onDone: (sessionId: string | null) => Promise<void>;
  onBack: () => void;
}) {
  const clerk = useClerk();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [stage, setStage] = useState<"details" | "code">("details");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    if (!clerk.client) return;
    setBusy(true);
    setError(null);
    try {
      const [firstName, ...rest] = name.trim().split(/\s+/);
      await clerk.client.signUp.create({
        emailAddress: email.trim(),
        password,
        firstName: firstName || undefined,
        lastName: rest.join(" ") || undefined,
      });
      await clerk.client.signUp.prepareEmailAddressVerification({ strategy: "email_code" });
      setStage("code");
    } catch (e) {
      setError(clerkMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function verify() {
    if (!clerk.client) return;
    setBusy(true);
    setError(null);
    try {
      const result = await clerk.client.signUp.attemptEmailAddressVerification({ code: code.trim() });
      if (result.status === "complete") return await onDone(result.createdSessionId);
      throw new Error(
        result.missingFields.length
          ? `Clerk still wants: ${result.missingFields.join(", ")}.`
          : `Sign-up stopped at "${result.status}".`,
      );
    } catch (e) {
      setError(clerkMessage(e));
      setBusy(false);
    }
  }

  return (
    <>
      <Back onClick={stage === "code" ? () => setStage("details") : onBack} />
      <Heading
        icon={<UserPlus size={13} strokeWidth={2.4} />}
        eyebrow="Printifi Desk"
        title={stage === "details" ? "Create a desk account" : "Check your email"}
      />
      {stage === "details" ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void start();
          }}
          className="mt-4 flex flex-col gap-2"
        >
          <Field value={name} onChange={setName} placeholder="Your name" label="Name" autoComplete="name" autoFocus />
          <Field type="email" autoComplete="email" value={email} onChange={setEmail} placeholder="Email" label="Email" />
          <Field
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={setPassword}
            placeholder="Password"
            label="Password"
          />
          <Primary busy={busy} disabled={!name.trim() || !email.trim() || !password}>
            Continue
          </Primary>
          <p className="m-0 text-[11px] leading-relaxed text-muted">
            Your name is what the staff list and <i>Handled by</i> show. The password rules are
            Clerk&apos;s; it says so if one isn&apos;t met. Creating an account agrees to the{" "}
            <Link href="/terms" className="underline-offset-2 hover:underline">terms</Link> and the{" "}
            <Link href="/privacy" className="underline-offset-2 hover:underline">privacy policy</Link>.
          </p>
        </form>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void verify();
          }}
          className="mt-4 flex flex-col gap-2"
        >
          <p className="m-0 flex items-start gap-2 text-[12.5px] leading-relaxed text-muted">
            <MailCheck size={15} strokeWidth={2.2} className="mt-px shrink-0" />
            A six-digit code went to <b className="text-ink-soft">{email.trim()}</b>.
          </p>
          <Field
            value={code}
            onChange={(v) => setCode(v.replace(/\D/g, "").slice(0, 6))}
            placeholder="Code"
            label="Code"
            inputMode="numeric"
            autoComplete="one-time-code"
            mono
            autoFocus
          />
          <Primary busy={busy} disabled={code.length < 6}>
            Create account
          </Primary>
        </form>
      )}
      {error && <Problem>{error}</Problem>}
    </>
  );
}

/* ---------- forgot password ---------- */

function ForgotPane({
  onDone,
  onBack,
}: {
  onDone: (sessionId: string | null) => Promise<void>;
  onBack: () => void;
}) {
  const clerk = useClerk();
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [stage, setStage] = useState<"email" | "code">("email");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send() {
    if (!clerk.client) return;
    setBusy(true);
    setError(null);
    try {
      await clerk.client.signIn.create({
        strategy: "reset_password_email_code",
        identifier: email.trim(),
      });
      setStage("code");
    } catch (e) {
      setError(clerkMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function reset() {
    if (!clerk.client) return;
    setBusy(true);
    setError(null);
    try {
      let result = await clerk.client.signIn.attemptFirstFactor({
        strategy: "reset_password_email_code",
        code: code.trim(),
        password,
      });
      // Some instances take the code first and the password as a second step.
      if (result.status === "needs_new_password") {
        result = await clerk.client.signIn.resetPassword({ password, signOutOfOtherSessions: true });
      }
      if (result.status === "complete") return await onDone(result.createdSessionId);
      throw new Error(`Reset stopped at "${result.status}".`);
    } catch (e) {
      setError(clerkMessage(e));
      setBusy(false);
    }
  }

  return (
    <>
      <Back onClick={stage === "code" ? () => setStage("email") : onBack} />
      <Heading
        icon={<KeyRound size={13} strokeWidth={2.4} />}
        eyebrow="Printifi Desk"
        title={stage === "email" ? "Set a new password" : "Check your email"}
      />
      {stage === "email" ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
          className="mt-4 flex flex-col gap-2"
        >
          <Field type="email" autoComplete="email" value={email} onChange={setEmail} placeholder="Email" label="Email" autoFocus />
          <Primary busy={busy} disabled={!email.trim()}>
            Send a code
          </Primary>
          <p className="m-0 text-[11px] leading-relaxed text-muted">
            Works for an account made with Google, too — it gets a password it didn&apos;t have.
          </p>
        </form>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void reset();
          }}
          className="mt-4 flex flex-col gap-2"
        >
          <p className="m-0 flex items-start gap-2 text-[12.5px] leading-relaxed text-muted">
            <MailCheck size={15} strokeWidth={2.2} className="mt-px shrink-0" />
            A six-digit code went to <b className="text-ink-soft">{email.trim()}</b>.
          </p>
          <Field
            value={code}
            onChange={(v) => setCode(v.replace(/\D/g, "").slice(0, 6))}
            placeholder="Code"
            label="Code"
            inputMode="numeric"
            autoComplete="one-time-code"
            mono
            autoFocus
          />
          <Field
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={setPassword}
            placeholder="New password"
            label="New password"
          />
          <Primary busy={busy} disabled={code.length < 6 || !password}>
            Set password and sign in
          </Primary>
        </form>
      )}
      {error && <Problem>{error}</Problem>}
    </>
  );
}

/* ---------- pieces ---------- */

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-[420px] rounded-[24px] border border-line bg-surface p-5 shadow-card lg:p-6">
      {children}
    </div>
  );
}

function Pane({ children }: { children: React.ReactNode }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -6 }}
      transition={{ duration: 0.2, ease: easeIos }}
    >
      {children}
    </motion.div>
  );
}

function Heading({ icon, eyebrow, title }: { icon: React.ReactNode; eyebrow: string; title: string }) {
  return (
    <>
      <p className="label-caps m-0 flex items-center gap-1.5">
        {icon}
        {eyebrow}
      </p>
      <h2 className="font-heading m-0 mt-1 text-[24px] font-bold">{title}</h2>
    </>
  );
}

function Back({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="mb-3 flex items-center gap-1.5 text-[12.5px] font-semibold text-muted transition-colors hover:text-ink"
    >
      <ArrowLeft size={14} strokeWidth={2.2} />
      Back
    </button>
  );
}

function Field({
  value,
  onChange,
  label,
  placeholder,
  type = "text",
  autoComplete,
  inputMode,
  autoFocus,
  mono,
}: {
  value: string;
  onChange: (v: string) => void;
  label: string;
  placeholder: string;
  type?: string;
  autoComplete?: string;
  inputMode?: "numeric" | "text" | "email";
  autoFocus?: boolean;
  mono?: boolean;
}) {
  return (
    <input
      type={type}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      aria-label={label}
      autoComplete={autoComplete}
      inputMode={inputMode}
      autoFocus={autoFocus}
      spellCheck={false}
      className={cn(
        "h-12 w-full rounded-xl border border-line bg-surface-sunk px-3.5 text-[14px] outline-none focus:border-ink",
        mono && "font-mono text-[18px] tracking-[0.18em]",
      )}
    />
  );
}

function Primary({ busy, disabled, children }: { busy: boolean; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button
      type="submit"
      disabled={busy || disabled}
      className="mt-1 flex h-12 items-center justify-center gap-2 rounded-xl bg-ink px-4 text-[14px] font-semibold text-paper disabled:opacity-40"
    >
      {busy && <Loader2 size={15} className="animate-spin" />}
      {children}
    </button>
  );
}

function Problem({ children }: { children: React.ReactNode }) {
  return <p className="m-0 mt-3 text-[12.5px] font-semibold text-clay-ink dark:text-clay">{children}</p>;
}

/**
 * Clerk's errors carry the useful sentence in `errors[0].longMessage`; a
 * plain Error carries it in `message`. Either way, the person sees Clerk's
 * own reason — "Passwords must be 15 characters or more" — not a paraphrase.
 */
function clerkMessage(e: unknown): string {
  const errors = (e as { errors?: { longMessage?: string; message?: string }[] })?.errors;
  const first = errors?.[0];
  if (first?.longMessage) return first.longMessage;
  if (first?.message) return first.message;
  if (e instanceof Error) return e.message;
  return "Something went wrong.";
}
