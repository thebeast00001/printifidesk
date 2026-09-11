import { Container } from "@/components/container";
import { PageHeader } from "@/components/page-header";
import { StaggerIn } from "@/components/stagger-in";
import {
  AccountSettings,
  AppearanceSettings,
  NotificationSettings,
  PrivacySettings,
} from "@/components/settings-panels";
import { OperatorPicker } from "@/components/operator-picker";
import { ConnectionBanner } from "@/components/connection-banner";

export const metadata = { title: "Settings · Print Counter" };

export default function SettingsPage() {
  return (
    <StaggerIn>
      <PageHeader
        eyebrow="Print Counter"
        title="Settings"
        sub="Appearance, your details, and what happens to your files."
      />

      <Container className="pt-3">
        <div className="flex max-w-[720px] flex-col gap-7">
          <ConnectionBanner />
          <AppearanceSettings />
          <OperatorPicker />
          <AccountSettings />
          <NotificationSettings />
          <PrivacySettings />
        </div>
      </Container>
    </StaggerIn>
  );
}
