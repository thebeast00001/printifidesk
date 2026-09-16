import { DeskQueue } from "@/components/desk/faces";
import { NOINDEX } from "@/lib/seo";

export const metadata = { title: "Queue", robots: NOINDEX };

export default function QueuePage() {
  return <DeskQueue />;
}
