"use client";

import { Lock } from "lucide-react";
import { OperatorPortal } from "../operator-portal";
import { OperatorPricing } from "../operator-pricing";
import { OperatorDay } from "../operator-day";
import { CloseoutPanel } from "../operator/closeout";
import { StaffPanel } from "../operator/staff-panel";
import { StockPanel } from "../operator/stock-panel";
import { ShelfPanel } from "@/components/operator/shelf-panel";
import { DevicePanel } from "../operator/device-panel";
import { AccountPanel } from "./account-panel";
import { FeePanel } from "./fee-panel";
import { PayoutPanel } from "./payout-panel";
import { OpenSwitch } from "./open-switch";
import { useDeskReady } from "./desk-provider";

/**
 * The three faces of the desk, each its own page. They render only inside
 * the shell, once a desk is loaded — the shell handles every other state.
 *
 * Since 0039 a desk has an owner and staff. Staff run the queue, flip the
 * switch, count stock and set their own PIN; rates, payments, hours,
 * extras, staff, devices and the takings are the owner's. The database
 * refuses the rest to staff whatever this shows; this just doesn't show
 * them forms that would be refused.
 */

export function DeskQueue() {
  const { operator, role } = useDeskReady();
  return <OperatorPortal operator={operator} owner={role === "owner"} />;
}

function OwnersOnly({ what }: { what: string }) {
  return (
    <section className="flex items-start gap-3 rounded-[20px] border border-line bg-surface p-4 text-[13px] leading-relaxed text-muted lg:p-5">
      <Lock size={15} strokeWidth={2.2} className="mt-0.5 shrink-0" />
      <span>
        {what} are the desk owner&apos;s. If you should be an owner here, ask them to change your role under
        <b className="font-semibold text-ink"> Staff</b>.
      </span>
    </section>
  );
}

export function DeskTakings() {
  const { operator, reload, role } = useDeskReady();
  if (role !== "owner") return <OwnersOnly what="Takings, the ledger and the day's cash-up" />;
  return (
    <div className="flex flex-col gap-4">
      <OperatorDay operator={operator} />
      <PayoutPanel operator={operator} />
      <FeePanel operator={operator} />
      <CloseoutPanel operator={operator} onClosed={reload} />
    </div>
  );
}

export function DeskSettings() {
  const { operator, reload, userId, hasPin, refreshPin, role } = useDeskReady();
  const owner = role === "owner";
  return (
    <div className="flex flex-col gap-4">
      <OpenSwitch operator={operator} onChanged={reload} />
      {owner ? <OperatorPricing operator={operator} onSaved={reload} /> : <OwnersOnly what="Rates, extras, hours and payment details" />}
      <StockPanel operator={operator} onChanged={reload} />
      {owner && <ShelfPanel operator={operator} onSaved={reload} />}
      <StaffPanel operator={operator} me={userId} role={role} />
      <DevicePanel operator={operator} hasPin={hasPin} onPinChanged={refreshPin} owner={owner} />
      <AccountPanel />
    </div>
  );
}
