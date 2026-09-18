import { Deliveries } from "@/components/desk/deliveries";
import { NOINDEX } from "@/lib/seo";

export const metadata = { title: "Deliveries", robots: NOINDEX };

/**
 * The runner's page (0046), beside the queue for an account that is on a
 * desk and delivers. An account that only delivers never reaches this
 * route by name — the shell shows it Deliveries whatever the address.
 */
export default function DeliveriesPage() {
  return <Deliveries />;
}
