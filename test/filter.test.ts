import { describe, expect, it } from "vitest";
import { buildFilterSpec } from "../src/filter";

describe("buildFilterSpec", () => {
  it("Gmailの条件・検索式・処理へ変換する", () => {
    expect(
      buildFilterSpec(
        { from: "shop@example.com", to: "", subject: "限定 セール", body: "配信停止", query: "older_than:1y" },
        {
          markRead: true,
          archive: true,
          trash: false,
          star: false,
          important: false,
          labelId: "Label_42",
          newLabelName: "",
        },
      ),
    ).toEqual({
      criteria: {
        excludeChats: true,
        from: "shop@example.com",
        subject: "限定 セール",
        query: '"配信停止" older_than:1y',
      },
      action: {
        addLabelIds: ["Label_42"],
        removeLabelIds: ["UNREAD", "INBOX"],
      },
      searchQuery: 'from:"shop@example.com" subject:"限定 セール" "配信停止" older_than:1y',
    });
  });

  it("削除はTRASHラベルとして扱う", () => {
    const spec = buildFilterSpec(
      { from: "", to: "", subject: "", body: "invoice", query: "" },
      {
        markRead: false,
        archive: false,
        trash: true,
        star: false,
        important: false,
        labelId: "",
        newLabelName: "",
      },
    );
    expect(spec.action.addLabelIds).toEqual(["TRASH"]);
  });
});
