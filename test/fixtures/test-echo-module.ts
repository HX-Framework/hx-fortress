import type { Module } from "../../src/host/types";

export default function createModule(): Module {
  return {
    id: "test_echo",
    onMessage(data) {
      return { ok: true, payload: data.payload };
    },
  };
}
