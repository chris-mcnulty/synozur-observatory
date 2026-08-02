import React from "react";
import { Link, useLocation } from "wouter";
import { Home, Radar, ShieldCheck, Search, Menu } from "lucide-react";
import { cn } from "@/lib/utils";
import { getActiveAreaId } from "@/lib/areaNavigation";

interface MobileBottomNavProps {
  onOpenMenu: () => void;
  onOpenCommandPalette: () => void;
}

type TabItem =
  | { kind: "link"; label: string; href: string; icon: React.ComponentType<{ className?: string }>; match: (path: string) => boolean; testId: string }
  | { kind: "action"; label: string; icon: React.ComponentType<{ className?: string }>; onClick: () => void; testId: string };

/**
 * Persistent bottom tab bar rendered only on small and medium screens.
 * Provides 1-tap access to the 3 most common sections plus a Search action and
 * the full sidebar menu. Hidden on lg+ where the full sidebar is always visible.
 */
export default function MobileBottomNav({ onOpenMenu, onOpenCommandPalette }: MobileBottomNavProps) {
  const [location] = useLocation();

  const tabs: TabItem[] = [
    {
      kind: "link",
      label: "Home",
      href: "/app",
      icon: Home,
      match: (p) => getActiveAreaId(p) === "home",
      testId: "mobile-nav-home",
    },
    {
      kind: "link",
      label: "Observatory",
      href: "/app/observatory",
      icon: Radar,
      match: (p) => getActiveAreaId(p) === "observatory",
      testId: "mobile-nav-observatory",
    },
    {
      kind: "link",
      label: "Assessments",
      href: "/app/observatory/assessments",
      icon: ShieldCheck,
      match: (p) => p.startsWith("/app/observatory/assessments"),
      testId: "mobile-nav-assessments",
    },
    {
      kind: "action",
      label: "Search",
      icon: Search,
      onClick: onOpenCommandPalette,
      testId: "mobile-nav-search",
    },
    {
      kind: "action",
      label: "Menu",
      icon: Menu,
      onClick: onOpenMenu,
      testId: "mobile-nav-menu",
    },
  ];

  return (
    <nav
      aria-label="Primary mobile navigation"
      className="lg:hidden fixed bottom-0 inset-x-0 z-30 border-t border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80 pb-[env(safe-area-inset-bottom)]"
    >
      <ul className="flex items-stretch justify-around">
        {tabs.map((tab) => {
          const isActive = tab.kind === "link" && tab.match(location);
          const Icon = tab.icon;
          const content = (
            <span
              className={cn(
                "flex flex-col items-center justify-center gap-0.5 py-2 px-1 min-w-[56px] text-[10px] font-medium transition-colors",
                isActive ? "text-primary" : "text-muted-foreground hover:text-foreground"
              )}
            >
              <Icon className="h-5 w-5" />
              <span>{tab.label}</span>
            </span>
          );
          return (
            <li key={tab.label} className="flex-1">
              {tab.kind === "link" ? (
                <Link
                  href={tab.href}
                  data-testid={tab.testId}
                  aria-current={isActive ? "page" : undefined}
                  className="flex items-center justify-center w-full h-full"
                >
                  {content}
                </Link>
              ) : (
                <button
                  type="button"
                  onClick={tab.onClick}
                  data-testid={tab.testId}
                  className="flex items-center justify-center w-full h-full"
                >
                  {content}
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
