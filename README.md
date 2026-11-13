# DSH 插件箱子

**[dshcrate.com](https://dshcrate.com)**

DeepSeek Harness（DSH）插件与工具目录，收录 4 万+ 个仓库，每日自动刷新。
不用再去 GitHub 一条条翻 README —— 打开就能按星标、下载量和更新活跃度看清哪个值得装。

![DSH 插件箱子](https://dshcrate.com/og.png)

## 能帮你做什么

- **全文搜索**：按插件名、简介、标签直接搜，不用一页页翻
- **分类筛选**：按用途分区浏览，几千条里也能快速找准方向
- **榜单**：按综合评分排序，好装、在维护、用得上的排在前面
- **收藏**：把想装的先存起来，回头再装
- **一键复制安装命令**：卡片上点「安装」直接拿到命令，粘进终端就能用
- **详情页**：README 摘要、版本、星数、最近提交时间，还有同作者的其他插件

## 为什么值得用

- **只收录能装的**：上游没写明 `dsh add` / `dsh install` 安装规格的仓库不进目录，省掉大量装了报错的坑
- **综合评分**：可装性、维护活跃、实用度、生态热度一起算，不是单纯按星标排
- **每天更新**：收录、评分、排序每天自动重跑，新插件会被发现，停更的项目也会沉下去

## 三步开始

1. 打开 **[dshcrate.com](https://dshcrate.com)**，搜索想找的功能，或从分类里浏览
2. 在卡片上点「安装」，复制命令
3. 粘贴进终端执行

## 把插件箱子装进 DSH

网页只能浏览；想在 DSH 客户端里直接搜索、查看详情并一键安装，装 `dsh-crate` 插件：

```sh
# 从 npm 安装（推荐）
dsh plugin --profile web add dsh-crate

# 想跟仓库最新代码
dsh plugin --profile web add github:dshcrate/dsh-crate
```

profile 不是 `web` 的话换个名字，例如 `--profile desktop`。装完重启 DSH，左侧菜单会出现「插件箱子」入口。

不想装插件也可以：把 `https://dshcrate.com/data/index.json` 加进官方「插件 → 发现 → 索引源」，一样能在官方发现页浏览这份目录。

## 提交你的插件

收录是自动的，另外有两条主动通道：

- 站内 **[提交插件](https://dshcrate.com/submit)**：填上仓库地址即可，审核后会出现在目录里
- GitHub Issue：**[新建 Issue](https://github.com/dshcrate/dshcrate-web/issues/new)**，标题以 `[插件提交]` 开头，正文写清仓库地址与安装方式，会自动同步进待审核列表

收录标准：上游仓库需明确写出 `dsh add` / `dsh install` 安装规格；全局安装命令与无效规格不会被收录。

## 说明

本站只做索引，不托管任何插件代码，插件版权归各作者所有。收录信息来自 GitHub 公开数据，仓库改名或删除后对应条目可能失效。
