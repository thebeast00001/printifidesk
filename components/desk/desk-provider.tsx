"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { useOperatorQueue } from "@/hooks/use-tracking";
import { useAuthKey } from "@/hooks/use-auth-key";
import { isPairedDevice } from "@/lib/desk-auth";
import { listStaff } from "@/lib/desk";
import { myRunnerStatus, type RunnerStatus } from "@/lib/delivery";
import { useApp } from "@/lib/store";
import { operatorNames, type Operator, type OrderRow , myRole, type StaffRole } from "@/lib/orders";

type Backend = ReturnType<typeof useOperatorQueue>["backend"];

interface DeskValue {
  backend: Backend;
  operatorId: string | null;
  /** Every desk this person is on; more than one shows a switcher. */
  operatorIds: string[];
  /** Their names, by id, for that switcher. */
  deskNames: Record<string, string>;
  operator: Operator | null;
  queue: OrderRow[];
  reload: () => Promise<void>;
  userId: string | null;
  /** This browser holds a desk pairing token. */
  paired: boolean;
  /** This person has set a PIN for the current desk. */
  hasPin: boolean;
  /** 0039: owner or staff on this desk. Owner until known, so nothing flashes hidden for the person who set the desk up. */
  role: StaffRole;
  /** 0046: where this account stands with delivery — "unknown" until asked. */
  runner: RunnerStatus | "unknown";
  refreshPin: () => Promise<void>;
  refreshRunner: () => Promise<void>;
  chooseDesk: (id: string) => void;
}

const DeskContext = createContext<DeskValue | null>(null);

const CHOICE_KEY = "printify.desk.current";

/**
 * One subscription for the whole desk site.
 *
 * The queue, the operator row and the realtime socket are held here, above
 * the pages, so moving between the queue, takings and settings doesn't tear
 * the socket down and re-open it — the same reason the dock never leaves the
 * screen.
 */
export function DeskProvider({ children }: { children: React.ReactNode }) {
  const { userId } = useAuth();
  // Read after mount: localStorage isn't there on the server, and a value
  // that differs between the two renders is a hydration mismatch.
  const [preferred, setPreferred] = useState<string | null>(null);
  const [paired, setPaired] = useState(false);
  const [hasPin, setHasPin] = useState(false);
  const [role, setRole] = useState<StaffRole>("owner");
  const setPending = useApp((s) => s.setOperatorPending);

  useEffect(() => {
    setPaired(isPairedDevice());
    try {
      setPreferred(localStorage.getItem(CHOICE_KEY));
    } catch {
      // Storage blocked: the first desk it is.
    }
  }, []);

  const { backend, operatorId, operatorIds, operator, queue, reload } = useOperatorQueue(preferred);
  const [deskNames, setDeskNames] = useState<Record<string, string>>({});
  useEffect(() => {
    if (operatorIds.length < 2) return setDeskNames((d) => (Object.keys(d).length ? {} : d));
    void operatorNames(operatorIds).then(setDeskNames);
  }, [operatorIds]);

  const refreshPin = useCallback(async () => {
    if (!operatorId || !userId) return setHasPin(false);
    const rows = await listStaff(operatorId);
    setHasPin(rows.some((r) => r.user_id === userId && r.has_pin));
  }, [operatorId, userId]);

  useEffect(() => {
    void refreshPin();
  }, [refreshPin]);

  useEffect(() => {
    if (!operatorId) return;
    let alive = true;
    void myRole(operatorId).then((r) => alive && setRole(r));
    return () => {
      alive = false;
    };
  }, [operatorId, userId]);

  // 0046: a runner is an account the admin granted; the site asks once per
  // sign-in, and again after a request or an approval.
  const authKey = useAuthKey();
  const [runner, setRunner] = useState<RunnerStatus | "unknown">("unknown");
  const refreshRunner = useCallback(async () => {
    setRunner(await myRunnerStatus());
  // oxlint-disable-next-line react-hooks/exhaustive-deps -- re-made when the signed-in identity changes (useAuthKey)
  }, [authKey]);
  useEffect(() => {
    if (backend.state !== "ready") return setRunner("unknown");
    void refreshRunner();
  }, [backend.state, refreshRunner]);

  // The dock draws the faces this account has: a desk's, deliveries, or both.
  const setFaces = useApp((s) => s.setDeskFaces);
  useEffect(() => {
    if (backend.state !== "ready" || runner === "unknown") return setFaces(null);
    setFaces({ desk: Boolean(operatorId), deliveries: runner === "active" });
  }, [backend.state, operatorId, runner, setFaces]);

  // Leaving the desk site clears the dock badge, so the student-side dock
  // never shows a stale operator count.
  useEffect(() => () => {
    setPending(null);
    setFaces(null);
  }, [setPending, setFaces]);

  const chooseDesk = useCallback((id: string) => {
    setPreferred(id);
    try {
      localStorage.setItem(CHOICE_KEY, id);
    } catch {
      // Fine — it lasts for this page load.
    }
  }, []);

  return (
    <DeskContext.Provider
      value={{
        backend,
        operatorId,
        operatorIds,
        deskNames,
        operator,
        queue,
        reload,
        userId: userId ?? null,
        paired,
        hasPin,
        role,
        runner,
        refreshPin,
        refreshRunner,
        chooseDesk,
      }}
    >
      {children}
    </DeskContext.Provider>
  );
}

export function useDesk(): DeskValue {
  const value = useContext(DeskContext);
  if (!value) throw new Error("useDesk() needs a <DeskProvider> above it.");
  return value;
}

/** The pages only render once the shell has a desk; this narrows the type. */
export function useDeskReady(): DeskValue & { operator: Operator; operatorId: string } {
  const value = useDesk();
  if (!value.operator || !value.operatorId) {
    throw new Error("This page renders only once the desk is loaded.");
  }
  return value as DeskValue & { operator: Operator; operatorId: string };
}
