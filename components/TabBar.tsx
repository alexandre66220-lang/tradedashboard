import type { ReactNode } from "react";
import type { Light } from "@/lib/trafficlight";

export type TabId = "forecast" | "trade" | "journal" | "alerts";

const icon = (d: ReactNode) => (
  <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    {d}
  </svg>
);

export const TABS: Array<{ id: TabId; label: string; icon: ReactNode }> = [
  { id: "forecast", label: "Prévision", icon: icon(<polyline points="3 17 9 11 13 15 21 6" />) },
  {
    id: "trade",
    label: "Trade",
    icon: icon(
      <>
        <circle cx="12" cy="12" r="8" />
        <circle cx="12" cy="12" r="3" />
      </>,
    ),
  },
  {
    id: "journal",
    label: "Journal",
    icon: icon(
      <>
        <path d="M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3z" />
        <line x1="9" y1="9" x2="15" y2="9" />
        <line x1="9" y1="13" x2="15" y2="13" />
      </>,
    ),
  },
  {
    id: "alerts",
    label: "Alertes",
    icon: icon(
      <>
        <path d="M6 9a6 6 0 0 1 12 0c0 6 2 7 2 7H4s2-1 2-7" />
        <path d="M10 20a2 2 0 0 0 4 0" />
      </>,
    ),
  },
];

/** Section switcher: fixed at the bottom of the screen on phones, a row of buttons under the chart on desktop. */
export default function TabBar({ tab, onTab, light }: { tab: TabId; onTab: (t: TabId) => void; light: Light }) {
  return (
    <nav className="tabbar" role="tablist" aria-label="Sections">
      {TABS.map((t) => (
        <button
          key={t.id}
          role="tab"
          id={`tab-${t.id}`}
          aria-selected={tab === t.id}
          aria-controls={`panel-${t.id}`}
          className={`tab${tab === t.id ? " on" : ""}${t.id === "forecast" ? " only-mobile" : ""}`}
          onClick={() => onTab(t.id)}
        >
          {t.icon}
          <span>{t.label}</span>
          {t.id === "trade" && light !== "green" && <i className={`dot-badge ${light}`} aria-label={light === "red" ? "Pas de trade maintenant" : "Prudence"} />}
        </button>
      ))}
    </nav>
  );
}
