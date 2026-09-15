"use client";

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
import { OpenSwitch } from "./open-switch";
import { useDeskReady } from "./desk-provider";

/**
 * The three faces of the desk, each its own page. They render only inside
 * the shell, once a desk is loaded — the shell handles every other state.
 */

export function DeskQueue() {
  const { operator } = useDeskReady();
  return <OperatorPortal operator={operator} />;
}

export function DeskTakings() {
  const { operator, reload } = useDeskReady();
  return (
    <div className="flex flex-col gap-4">
      <OperatorDay operator={operator} />
      <FeePanel operator={operator} />
      <CloseoutPanel operator={operator} onClosed={reload} />
    </div>
  );
}

export function DeskSettings() {
  const { operator, reload, userId, hasPin, refreshPin } = useDeskReady();
  return (
    <div className="flex flex-col gap-4">
      <OpenSwitch operator={operator} onChanged={reload} />
      <OperatorPricing operator={operator} onSaved={reload} />
      <StockPanel operator={operator} onChanged={reload} />
      <ShelfPanel operator={operator} onSaved={reload} />
      <StaffPanel operator={operator} me={userId} />
      <DevicePanel operator={operator} hasPin={hasPin} onPinChanged={refreshPin} />
      <AccountPanel />
    </div>
  );
}
