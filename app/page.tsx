import Dashboard from "@/components/Dashboard";
import { INSTRUMENTS } from "@/config/instruments";

export const dynamic = "force-dynamic";

export default function Page() {
  return <Dashboard instruments={INSTRUMENTS} />;
}
