# 待定事项（用户已确认「先留着」）

> 这里只放**已经明确知道要做什么、但用户决定先不做**的事。
> 每条都要写清：为什么留着、什么时候该回来处理、处理时要注意什么。

---

## 1. 是否补发 npm 0.2.9 来体现「CI 修复」

**现状（2026-10-19 核实）**

- npm `latest = 0.2.8`，`lib/client.js` 3,359,253 B，与仓库 `main` 的产物 **哈希一致**。
- 0.2.8 之后只有一个提交 `afbc1c2`（`fix(ci): 测试不再写死 +08:00`），
  它**只改了 `test/` 和 `.github/workflows/test.yml`**。
- `package.json` 的 `files` **不包含 `test/`**，所以这两个文件根本不进 npm 包 ——
  用户装到的东西一个字节都没变。

**所以要决定的是纯版本号语义问题**

- 不发 0.2.9：包内容没变，没有用户的任何行为受影响；缺点只是「修了 CI」这件事在版本号上看不见。
- 发 0.2.9：内容与 0.2.8 逐字节相同，只改版本号。
  代价是要重新走一遍：`package.json` 改版本 → `build-all` → 全量测试 → 打包核对 → publish（需 2FA）
  → tag → GitHub Release 标 latest → 等市场每日快照刷新。

**用户决定**：先留着，不处理。**下次要发任何新功能时，直接把版本号写成 0.2.9 即可顺带覆盖**，
不必单独为这件事发一版。

---

## 2. 明天核对：市场「版本说明」弹窗是否已经显示 0.2.8

**背景**

市场弹窗的数据来自 `awesome-dsh-plugin.com/updates.json`（每日生成一次快照）。
0.2.8 发布前，那份快照里我们的条目是 `release.tag = v0.2.0`、`checkedAt = 2026-10-18` ——
根因是 GitHub 的 **Latest 标记一直停在 v0.2.0**（0.2.1~0.2.6 的 Release 建的时候没标 latest）。

**已修**

- `gh release edit v0.2.6 --latest`（先修历史）
- 0.2.8 的 Release 用 `--latest` 创建，正文取自 `docs/releases/v0.2.8.md`
- GitHub 的 `releases/latest` 现在返回 `v0.2.8`

**待验证**

- 拉 `https://awesome-dsh-plugin.com/updates.json`，看
  `https://github.com/wt0812/dsh-vocab-study` 这条的 `release.tag` 是否变成 `v0.2.8`、
  `checkedAt` 是否变成 `2026-10-19` 或之后。
- 若还是 v0.2.0：说明每日生成读的不是 GitHub latest，要继续查
  `dshmarket/lib/changelog.js` 那条降级链（`kind: release → commits → npm`）。
- 本地还有 1 小时进程内缓存（`NOTES_TTL_MS = 60*60*1000`），核对前先完整重启 DSH。

---

## 3. 已知仍未做的产品需求（用户提过、尚未开工）

- **背完一轮后，左侧空白区随机显示「已经背过的词 + 释义」并轮换**（不参与计分）。
  注意规格 `VOCAB-STUDY-SPEC.md:280` 与「面板永不自动展开」类条款，落地前要再对一遍规格。

- **再发一遍产品介绍文章**（用户原话：「再发一遍文章，这个就是纯介绍我产品了，给我文案」）。
