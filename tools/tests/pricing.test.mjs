import { test } from "node:test";
import assert from "node:assert/strict";
import "../../shared/pricing.js";

const P = globalThis.SV_PRICING;
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

test("openai rows use gpt-4o-mini rates", () => {
  close(P.estCost({ provider: "openai", inTok: 1e6, outTok: 1e6 }), 0.15 + 0.60);
});

test("claude sonnet rows (any non-haiku model) use $3/$15", () => {
  close(P.estCost({ provider: "claude", model: "claude-sonnet-5", inTok: 1e6, outTok: 1e6 }), 3 + 15);
  // Legacy rows without a model field keep the sonnet rates (no undercount).
  close(P.estCost({ provider: "claude", inTok: 1e6, outTok: 1e6 }), 3 + 15);
});

test("claude haiku rows use $1/$5", () => {
  close(P.estCost({ provider: "claude", model: "claude-haiku-4-5", inTok: 1e6, outTok: 1e6 }), 1 + 5);
});

test("cache read/write bill at 10%/125% of the MODEL's input rate", () => {
  close(P.estCost({ provider: "claude", model: "claude-haiku-4-5", cacheR: 1e6, cacheW: 1e6 }), 1 * 0.1 + 1 * 1.25);
  close(P.estCost({ provider: "claude", model: "claude-sonnet-5", cacheR: 1e6, cacheW: 1e6 }), 3 * 0.1 + 3 * 1.25);
});
