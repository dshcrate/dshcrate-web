import assert from "node:assert/strict";
import { test } from "node:test";

import { isPlaceholderSpec } from "./evidence.ts";

test("isPlaceholderSpec：README 占位模板被识别", () => {
  const placeholders = [
    "github:owner/repo",
    "github:user/repo",
    "github:your-name/pkg",
    "github:xxx/anything",
    "github:<owner>/<repo>",
    "github:<owner>/dsh-jiahao-mode",
    "git+https://github.com/<org>/skill-injector-plugin.git",
  ];
  for (const spec of placeholders) assert.equal(isPlaceholderSpec(spec), true, spec);
});

test("isPlaceholderSpec：真实规格不受影响", () => {
  const real = [
    "github:Ericwong5021/deepseek-plugin-store",
    "github:dshcrate/dsh-crate",
    "git+https://github.com/dshcrate/dsh-crate.git",
    "dsh-crate",
    "@scope/pkg@1.2.3",
  ];
  for (const spec of real) assert.equal(isPlaceholderSpec(spec), false, spec);
});
