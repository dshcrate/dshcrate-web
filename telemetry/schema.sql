-- 每个安装每个 UTC 日最多一行；日活就是 COUNT(*)。
-- 同一 (day, id) 重复上报由主键忽略。
CREATE TABLE IF NOT EXISTS pings (
  day TEXT NOT NULL,
  id TEXT NOT NULL,
  v TEXT NOT NULL,
  hv TEXT,
  kind TEXT NOT NULL,
  region TEXT NOT NULL,
  PRIMARY KEY (day, id)
);
