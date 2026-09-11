import { Container } from "@/components/container";
import { PageHeader } from "@/components/page-header";
import { StaggerIn } from "@/components/stagger-in";
import { ProfileView } from "@/components/profile-view";

export const metadata = { title: "Profile" };

export default function ProfilePage() {
  return (
    <StaggerIn>
      <PageHeader
        eyebrow="Print Counter"
        title="Your account"
        sub="Your totals, stored documents, and what the backend is actually doing."
      />

      <Container className="pt-3">
        <ProfileView />
      </Container>
    </StaggerIn>
  );
}
