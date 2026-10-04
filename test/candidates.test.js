import { describe, expect, it } from "vitest";
import { subjectCandidates } from "../public/candidates.js";

describe("subjectCandidates", () => {
  it("件名から日付と注文番号を除いた候補を返す", () => {
    expect(subjectCandidates("【発送】2026年10月4日のご注文番号 AB-123456 お知らせ")).toEqual([
      "【発送】2026年10月4日のご注文番号 AB-123456 お知らせ",
      "発送 お知らせ",
    ]);
  });
});
