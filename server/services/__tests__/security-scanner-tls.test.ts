import { describe, expect, it } from "vitest";
import {
  checkTlsCertificate,
  inspectTlsSocket,
} from "../security-scanner";

function fetchResultWith(tlsCert: ReturnType<typeof inspectTlsSocket>) {
  return {
    statusCode: 200,
    headers: {},
    body: "",
    finalUrl: "https://host/",
    redirectChain: [],
    tlsCert,
  };
}

describe("security scanner TLS certificate handling", () => {
  it("does not report a TLS finding when a resumed session returns an empty peer certificate", async () => {
    const tlsCert = inspectTlsSocket({
      getPeerCertificate: () => ({}),
      isSessionReused: () => true,
    });

    const findings = await checkTlsCertificate(
      "https://host/",
      fetchResultWith(tlsCert),
    );

    expect(tlsCert).toBeUndefined();
    expect(findings.filter((finding) => finding.ruleId.startsWith("tls-") || finding.ruleId === "invalid-tls-cert")).toEqual([]);
  });

  it.each([
    {
      label: "missing",
      socket: {
        getPeerCertificate: () => ({}),
        isSessionReused: () => false,
      },
    },
    {
      label: "expired",
      socket: {
        getPeerCertificate: () => ({
          subject: { CN: "host" },
          issuer: { O: "Test CA" },
          valid_from: "Jan 1 00:00:00 2020 GMT",
          valid_to: "Jan 2 00:00:00 2020 GMT",
        }),
        isSessionReused: () => false,
      },
    },
  ])("reports a Critical finding for a genuinely $label certificate", async ({ socket }) => {
    const tlsCert = inspectTlsSocket(socket, Date.UTC(2026, 0, 1));
    const findings = await checkTlsCertificate(
      "https://host/",
      fetchResultWith(tlsCert),
    );

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      ruleId: "invalid-tls-cert",
      severity: "Critical",
    });
  });
});