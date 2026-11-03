import assert from "node:assert/strict";
import { test } from "node:test";
import { memorySection, memoryStoreIds } from "./memory";

test("memoryStoreIds keeps the own store first", () => {
  const r = memoryStoreIds(["sage"], { own: "m_otto", shared: "m_sh", byAgent: { sage: "m_sage" } });
  assert.deepEqual(r.ids, ["m_otto", "m_sh", "m_sage"]);
  assert.deepEqual(r.missing, []);
});

test("memoryStoreIds skips a peer that isn't deployed", () => {
  const r = memoryStoreIds(["sage"], { own: "m_otto", shared: "m_sh", byAgent: {} });
  assert.deepEqual(r.ids, ["m_otto", "m_sh"]);
  assert.deepEqual(r.missing, ["sage"]);
});

test("memorySection names each peer mount", () => {
  const otto = memorySection("otto", ["sage"]);
  assert.ok(otto.includes("/mnt/memory/sage-memory/"));
  assert.ok(otto.includes("read-only"));
  assert.ok(otto.includes("/mnt/memory/otto-memory/notes/working.md"));
  const mira = memorySection("mira", []);
  assert.ok(mira.includes("Two memory stores"));
  assert.ok(!mira.includes("sage"));
});
