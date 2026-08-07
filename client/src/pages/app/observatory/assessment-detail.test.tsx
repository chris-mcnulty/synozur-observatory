// @vitest-environment jsdom
/**
 * Frontend tests for the partial-scan warning banner in ObservatoryAssessmentDetail.
 *
 * Strategy: mount the real component with all external dependencies mocked so
 * we exercise the actual JSX condition (assessment-detail.tsx ~line 342) rather
 * than a copy of it. The tests confirm:
 *
 *   1. data-testid="card-partial-scan-warning" renders when scan-status returns
 *      { partial: true } and the scan is not running.
 *   2. The banner is absent when { partial: false }.
 *   3. The banner is absent when the partial field is omitted.
 *   4. The banner is absent while a scan is still active (scanRunning=true),
 *      even if partial=true is set on stale data.
 */

import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

// ── Module mocks (must be declared before the import under test) ──────────────

vi.mock("wouter", () => ({
  useParams: () => ({ id: "asmnt-test" }),
  useLocation: () => ["/app/observatory/assessments/asmnt-test", vi.fn()],
  Link: ({ children, href, className }: any) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: vi.fn(),
  useMutation: vi.fn(),
  useQueryClient: vi.fn(),
}));

vi.mock("@/lib/queryClient", () => ({ apiRequest: vi.fn() }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/lib/userContext", () => ({
  useUser: () => ({ user: { role: "Domain Admin" } }),
}));
vi.mock("@/components/layout/AppLayout", () => ({
  default: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="mock-app-layout">{children}</div>
  ),
}));
// performance-scan is a sibling module imported by the component under test
vi.mock("./performance-scan", () => ({ default: () => null }));

// ── Imports AFTER mocks ───────────────────────────────────────────────────────

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import ObservatoryAssessmentDetail from "./assessment-detail";

// ── Fixtures ──────────────────────────────────────────────────────────────────

/** Minimal assessment shape that satisfies the component's Detail interface. */
const BASE_ASSESSMENT = {
  id: "asmnt-test",
  title: "A11y Audit",
  type: "accessibility",
  status: "completed",
  assessorName: null,
  team: null,
  startDate: null,
  endDate: null,
  overallScore: null,
  executiveSummary: null,
  scope: null,
  outOfScope: null,
  applicationId: "app-1",
  scanSchedule: "disabled" as const,
  application: { id: "app-1", name: "Portal", appUrl: "https://portal.example.com" },
  version: null,
  findings: [],
  evidence: [],
};

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Wire up the useQuery, useMutation, and useQueryClient mocks.
 * The component calls useQuery twice (assessment detail + scan status);
 * we distinguish them by the query key string.
 */
function setupMocks(scanStatusData: Record<string, unknown> | undefined) {
  vi.mocked(useQueryClient).mockReturnValue({
    invalidateQueries: vi.fn(),
  } as any);

  const stubMutation = {
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
    isPending: false,
    isSuccess: false,
    isError: false,
    reset: vi.fn(),
  };
  vi.mocked(useMutation).mockReturnValue(stubMutation as any);

  vi.mocked(useQuery).mockImplementation((opts: any) => {
    const key = String(opts?.queryKey?.[0] ?? "");
    if (key.includes("scan-status")) {
      return { data: scanStatusData, isLoading: false } as any;
    }
    // Assessment detail query
    return { data: BASE_ASSESSMENT, isLoading: false } as any;
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("ObservatoryAssessmentDetail — partial-scan warning banner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders the amber partial-scan warning banner when scan-status has partial=true and no scan is running", () => {
    setupMocks({
      status: "not_found",
      scannable: true,
      partial: true,
      scannedPages: 3,
      discoveredPages: 8,
    });

    render(<ObservatoryAssessmentDetail />);

    // Banner must be present
    expect(screen.getByTestId("card-partial-scan-warning")).toBeTruthy();
    // Must show page counts in the new "Scanned X of Y discovered pages" wording
    expect(screen.getByText(/scanned 3 of 8 discovered pages/i)).toBeTruthy();
  });

  it("shows the server-provided page limit in the banner when pageLimit is returned by scan-status", () => {
    setupMocks({
      status: "not_found",
      scannable: true,
      partial: true,
      scannedPages: 3,
      discoveredPages: 8,
      pageLimit: 20,
    });

    render(<ObservatoryAssessmentDetail />);

    expect(screen.getByTestId("card-partial-scan-warning")).toBeTruthy();
    // The "(limit: N)" segment must appear alongside the page counts
    expect(screen.getByText(/scanned 3 of 8 discovered pages \(limit: 20\)/i)).toBeTruthy();
  });

  it("does NOT render the banner when scan-status has partial=false", () => {
    setupMocks({
      status: "not_found",
      scannable: true,
      partial: false,
      scannedPages: 5,
      discoveredPages: 5,
    });

    render(<ObservatoryAssessmentDetail />);

    expect(screen.queryByTestId("card-partial-scan-warning")).toBeNull();
  });

  it("does NOT render the banner when scan-status omits the partial field entirely", () => {
    setupMocks({
      status: "not_found",
      scannable: true,
      // no partial field
    });

    render(<ObservatoryAssessmentDetail />);

    expect(screen.queryByTestId("card-partial-scan-warning")).toBeNull();
  });

  it("does NOT render the banner while a scan is active, even if stale data carries partial=true", () => {
    // scanRunning = status === "active" → banner condition short-circuits
    setupMocks({
      status: "active",
      scannable: true,
      partial: true,
      scannedPages: 2,
      discoveredPages: 10,
    });

    render(<ObservatoryAssessmentDetail />);

    expect(screen.queryByTestId("card-partial-scan-warning")).toBeNull();
  });

  it("does NOT render the banner while a scan is queued (pending), even if partial=true", () => {
    setupMocks({
      status: "pending",
      scannable: true,
      partial: true,
      scannedPages: 1,
      discoveredPages: 5,
    });

    render(<ObservatoryAssessmentDetail />);

    expect(screen.queryByTestId("card-partial-scan-warning")).toBeNull();
  });
});
