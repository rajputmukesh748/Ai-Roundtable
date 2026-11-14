import { Suspense } from "react";
import DebateView from "./DebateView";

export default function Page() {
  return (
    <Suspense fallback={<p>Loading…</p>}>
      <DebateView />
    </Suspense>
  );
}
