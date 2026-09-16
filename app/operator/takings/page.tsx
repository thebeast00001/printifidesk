import { DeskTakings } from "@/components/desk/faces";
import { NOINDEX } from "@/lib/seo";

export const metadata = { title: "Takings", robots: NOINDEX };

export default function TakingsPage() {
  return <DeskTakings />;
}
