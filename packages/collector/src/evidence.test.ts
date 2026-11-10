import assert from "node:assert/strict";
import { test } from "node:test";

import { isPlaceholderCommand, isPlaceholderSpec } from "./evidence.ts";

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

test("isPlaceholderCommand：占位模板命令被识别", () => {
  const placeholders = [
    "dsh plugin --profile web add github:<owner>/<repo>",
    "dsh plugin --profile web add github:<owner>/dsh-jiahao-mode",
    "dsh plugin --profile web add github:Neriah-Ado/dsh-resident-theme#<40位commit>",
    "dsh plugin --profile web add github:iptodays/dsh-plugins#<完整commit>",
  ];
  for (const cmd of placeholders) assert.equal(isPlaceholderCommand(cmd), true, cmd);
});

test("isPlaceholderCommand：普通命令与进程替换不受影响", () => {
  const real: Array<string | null> = [
    "dsh plugin --profile web add dsh-crate",
    "dsh plugin --profile web add github:dshcrate/dsh-crate#main",
    "bash <(curl -sL https://raw.githubusercontent.com/yuukiLike/zeromd/main/install-remote.sh)",
    null,
  ];
  for (const cmd of real) assert.equal(isPlaceholderCommand(cmd), false, String(cmd));
});
