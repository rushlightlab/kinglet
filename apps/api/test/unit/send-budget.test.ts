import { describe, expect, it } from "vitest";
import { createSendBudget } from "../../src/notifications/send-budget.ts";

describe("createSendBudget", () => {
  it("allows a full burst, then records the first suppressed send only", () => {
    const budget = createSendBudget(3);
    const now = 1_000_000;

    expect([1, 2, 3].map(() => budget.take("p1\nc1", now))).toEqual(["send", "send", "send"]);
    expect(budget.take("p1\nc1", now)).toBe("suppress-and-record");
    expect(budget.take("p1\nc1", now)).toBe("suppress");
  });

  it("refills over time and records the next suppression run again", () => {
    const budget = createSendBudget(60);
    const now = 1_000_000;

    for (let i = 0; i < 60; i++) budget.take("k", now);

    expect(budget.take("k", now)).toBe("suppress-and-record");
    // 60 per minute refills one token per second.
    expect(budget.take("k", now + 1_000)).toBe("send");
    expect(budget.take("k", now + 1_000)).toBe("suppress-and-record");
  });

  it("keeps separate budgets per key, so one project cannot use another's", () => {
    const budget = createSendBudget(1);
    const now = 1_000_000;

    expect(budget.take("project-a\nchannel", now)).toBe("send");
    expect(budget.take("project-a\nchannel", now)).toBe("suppress-and-record");
    expect(budget.take("project-b\nchannel", now)).toBe("send");
  });
});
