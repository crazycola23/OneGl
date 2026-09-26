import assert from "node:assert/strict";
import test from "node:test";

import { normalizeLegacyCitationEnums } from "../src/db/persist.js";

test("两个有据可查的历史枚举值被映射成现行合法值", () => {
  // 2026-09-23 之前采集器写过这两个自创值，文档 8.1 有记录：
  //   relationStatus "resolved" 想表达「匹配成功」= 后来的 matched
  //   sourceType "icon" 是千问的 favicon 引用路径 = 页面上真实可见的引用入口 = 后来的 visible
  const { citations, migrated } = normalizeLegacyCitationEnums([
    { url: "https://a.example", relationStatus: "resolved", sourceType: "icon" },
  ]);
  assert.equal(citations[0].relationStatus, "matched");
  assert.equal(citations[0].sourceType, "visible");
  assert.deepEqual(migrated.sort(), ["relationStatus:resolved->matched", "sourceType:icon->visible"]);
});

test("现行合法值原样通过，且不记成一次映射", () => {
  const { citations, migrated } = normalizeLegacyCitationEnums([
    { url: "https://a.example", relationStatus: "matched", sourceType: "visible" },
    { url: "https://b.example", relationStatus: "unresolved", sourceType: "retrieved" },
  ]);
  assert.equal(citations[0].relationStatus, "matched");
  assert.equal(citations[1].sourceType, "retrieved");
  assert.deepEqual(migrated, [], "合法值不该被算作兼容映射");
});

test("兼容层只认这两个历史值，别的非法值照样原样留着给校验去拒", () => {
  // 这条是这个改动里最要紧的一条：兼容层一旦变成「什么都收」，fail-closed 的方向就反了。
  const { citations, migrated } = normalizeLegacyCitationEnums([
    { url: "https://a.example", relationStatus: "guessed", sourceType: "invented" },
  ]);
  assert.equal(citations[0].relationStatus, "guessed");
  assert.equal(citations[0].sourceType, "invented");
  assert.deepEqual(migrated, []);
});

test("缺值 / 空值不被改写成任何东西", () => {
  const { citations, migrated } = normalizeLegacyCitationEnums([
    { url: "https://a.example" },
    { url: "https://b.example", relationStatus: null, sourceType: null },
    null,
  ]);
  assert.equal(citations[0].relationStatus, undefined);
  assert.equal(citations[1].relationStatus, null);
  assert.equal(citations[2], null);
  assert.deepEqual(migrated, []);
});

test("不就地修改传入的对象", () => {
  // 重放路径会把同一份 artifact 反复读进来，就地改会让第二次读到的值跟磁盘上的不一致。
  const original = { url: "https://a.example", relationStatus: "resolved", sourceType: "icon" };
  const { citations } = normalizeLegacyCitationEnums([original]);
  assert.equal(original.relationStatus, "resolved", "入参必须保持原样");
  assert.equal(original.sourceType, "icon", "入参必须保持原样");
  assert.notEqual(citations[0], original, "应当返回新对象");
});
