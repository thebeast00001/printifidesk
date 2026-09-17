import { Container } from "@/components/container";
import { TopBar } from "@/components/top-bar";
import { StatusIsland } from "@/components/status-island";
import { WidgetsRow } from "@/components/widgets-row";
import { UploadCard } from "@/components/upload-card";
import { Feed } from "@/components/feed";
import { StaggerIn } from "@/components/stagger-in";
import { PrivacyNote } from "@/components/privacy-note";
import { HowItWorks } from "@/components/how-it-works";
import { DuesNotice } from "@/components/dues-notice";
import { SiteFooter } from "@/components/site-footer";
import { canonical } from "@/lib/seo";

export const metadata = { alternates: { canonical: canonical("/") } };

export default function Home() {
  return (
    <StaggerIn>
      <TopBar />

      <Container className="pt-4 lg:pt-6">
        {/*
          On a phone this is one column in reading order: what's happening now,
          then what you can do next. On a laptop the live state moves to a rail
          that stays in view while you work through the documents beside it.
        */}
        {/*
          `minmax(0,1fr)` on the single-column track matters: a grid column
          defaults to min-content, and nowrap text inside (the island's
          truncated subtitle) would otherwise push the page wider than a phone.
        */}
        <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[minmax(0,1fr)_380px] lg:items-start lg:gap-10">
          <div className="order-2 flex min-w-0 flex-col gap-6 lg:order-1 lg:gap-8">
            <UploadCard />
            <Feed />
          </div>

          <aside className="order-1 flex min-w-0 flex-col gap-3.5 lg:order-2 lg:sticky lg:top-6 lg:gap-4">
            <DuesNotice />
            <StatusIsland />
            <WidgetsRow />
          </aside>
        </div>

        <PrivacyNote />
        <HowItWorks />
        <SiteFooter />
      </Container>
    </StaggerIn>
  );
}
