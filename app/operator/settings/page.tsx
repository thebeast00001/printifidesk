import { DeskSettings } from "@/components/desk/faces";
import { NOINDEX } from "@/lib/seo";

export const metadata = { title: "Settings", robots: NOINDEX };

export default function DeskSettingsPage() {
  return <DeskSettings />;
}
