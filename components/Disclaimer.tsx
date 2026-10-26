import type { ReactNode } from "react";

/** Fine print, folded by default so panels stay short on a phone. */
export default function Disclaimer({ children }: { children: ReactNode }) {
  return (
    <details className="disc">
      <summary>À savoir</summary>
      <p>{children}</p>
    </details>
  );
}
