// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatPanel } from "../../apps/web/src/components/chat/ChatPanel";
import { DocumentChecklist } from "../../apps/web/src/components/checklist/DocumentChecklist";
import { FactCard, FeesBody } from "../../apps/web/src/components/service/ServiceParts";
import { Layout } from "../../apps/web/src/components/layout/Layout";
import { I18nProvider } from "../../apps/web/src/i18n";
import type { ChecklistResponse } from "../../apps/web/src/services/api";

const wrap = (ui: React.ReactNode) => render(<I18nProvider><MemoryRouter>{ui}</MemoryRouter></I18nProvider>);
const doc = (name: string, requirement: string, condition: string | null = null) => ({ name, requirement, applies_to: null, condition, source_text: name, source_chunk_id: null });
// TEST FIXTURE data only.
const checklist = {
  service_id: "test-service", verification: "unverified", status: "published",
  mandatory: [doc("Address Proof", "mandatory")], conditional: [doc("Scanned form", "conditional", "incase of applying from PFC/CSC")],
  optional: [doc("Salary Slip", "optional")], unspecified: [], sources: [],
} as unknown as ChecklistResponse;

beforeEach(() => { localStorage.clear(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("document checklist", () => {
  it("groups mandatory / conditional / optional and shows the verbatim condition", () => {
    wrap(<DocumentChecklist checklist={checklist} serviceId="test-service" />);
    expect(screen.getByText("Mandatory")).toBeInTheDocument();
    expect(screen.getByText("Only in some cases")).toBeInTheDocument();
    expect(screen.getByText("Optional")).toBeInTheDocument();
    expect(screen.getByText(/incase of applying from PFC\/CSC/)).toBeInTheDocument();
  });
  it("tracks progress with keyboard-accessible checkboxes and persists locally", () => {
    wrap(<DocumentChecklist checklist={checklist} serviceId="test-service" />);
    expect(screen.getByText("0 of 1 ready")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: /Address Proof/ }));
    expect(screen.getByText("1 of 1 ready")).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem("sewasetu.checklist.test-service")!)).toEqual({ "Address Proof": true });
  });
  it("shows an explicit not-published state instead of an empty list", () => {
    wrap(<DocumentChecklist checklist={{ ...checklist, status: "not_published", mandatory: [], conditional: [], optional: [] }} serviceId="x" />);
    expect(screen.getByText("Not published in the official source")).toBeInTheDocument();
  });
});

describe("service cards", () => {
  it("renders unknown fees as 'not published', never as a number", () => {
    wrap(<FactCard title="Fees" published={false} />);
    expect(screen.getByText("Not published in the official source")).toBeInTheDocument();
    expect(screen.queryByText(/₹/)).toBeNull();
  });
  it("formats published fees and keeps conditions", () => {
    wrap(<FeesBody fees={{ status: "published", amount: null, currency: "INR", conditions: [], source_chunk_ids: [], items: [{ label: "Printing charge", amount: 10, unit: "per page", condition: "in case of printing", raw_text: "x" }] }} />);
    expect(screen.getByText("₹10 per page")).toBeInTheDocument();
    expect(screen.getByText(/in case of printing/)).toBeInTheDocument();
  });
});

describe("layout and language", () => {
  it("shows the independent-service notice, a skip link and switches language", () => {
    wrap(<Layout />);
    expect(screen.getByText(/not an official Government of Assam website/i)).toBeInTheDocument();
    expect(screen.getByText("Skip to main content")).toHaveAttribute("href", "#main");
    fireEvent.click(screen.getByRole("button", { name: "हिन्दी" }));
    expect(document.documentElement.lang).toBe("hi");
    expect(screen.getByRole("button", { name: "हिन्दी" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("link", { name: "सेवाएँ" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "অসমীয়া" }));
    expect(screen.getByRole("link", { name: "সেৱাসমূহ" })).toBeInTheDocument();
  });
});

describe("chat panel", () => {
  const answer = {
    answer: "Address Proof is mandatory [S1].\n- Identity Proof", language: "en", verification: "unverified", knowledge_release: "r1", disclaimer: "Please verify on the official portal.",
    sources: [{ ref: "S1", title: "Income Certificate — page", url: "https://sewasetu.assam.gov.in/x", section: "Requirements tab", retrieved_at: "2026-11-11T10:00:00Z", last_verified_at: null, verification: "unverified", cited: true }],
    related_services: [{ service_id: "svc", service_name: "Income Certificate" }],
  };

  it("sends the question to the Worker API only, shows the answer, citation, verification and official link", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(answer), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    wrap(<ChatPanel />);
    fireEvent.change(screen.getByLabelText("Type your question…"), { target: { value: "documents for income certificate" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect((await screen.findAllByText(/Official portal text – not yet reviewed/)).length).toBeGreaterThanOrEqual(1); // answer badge + source badge
    const link = screen.getByRole("link", { name: /Income Certificate — page/ });
    expect(link).toHaveAttribute("href", "https://sewasetu.assam.gov.in/x");
    expect(link).toHaveAttribute("rel", expect.stringContaining("noopener"));
    expect(screen.getByRole("link", { name: "Source S1" })).toHaveAttribute("href", "#src-S1");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/v1/chat");
    expect(JSON.parse(init.body as string)).toMatchObject({ question: "documents for income certificate", language: "en", conversation: [] });
    expect(JSON.stringify(init.headers)).not.toMatch(/authorization|api[-_]?key/i); // no secrets in the browser
  });

  it("shows a friendly, localized error for rate limiting and keeps the app usable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { code: "rate_limited", message: "x", request_id: "r" } }), { status: 429 })));
    wrap(<ChatPanel />);
    fireEvent.change(screen.getByLabelText("Type your question…"), { target: { value: "fees" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText(/Too many requests/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).toBeDisabled()); // empty input => disabled, not stuck pending
  });

  it("shows the degraded notice when the AI summary is unavailable and Enter submits", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ...answer, degraded: true, answer: "Unavailable." }), { status: 200 })));
    wrap(<ChatPanel />);
    const box = screen.getByLabelText("Type your question…");
    fireEvent.change(box, { target: { value: "fees" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(await screen.findByText(/AI summary is unavailable/)).toBeInTheDocument();
  });
});
