# antigravity-usage-source（Paseo 插件）

在 Paseo 的「使用情况」面板里给 Antigravity CLI（`agy`）加一张卡片：Gemini 与 Claude/GPT 两组的
5 小时限额和每周限额，各自带重置时间。只读 `agy` 自己打印的额度，不碰会话、登录态或配置。

## 数据口径

| 面板字段 | 来源 | 说明 |
| --- | --- | --- |
| Gemini 5-hour / weekly | `agy -p "/quota"` 第 1、2 行 | CLI 给的是**剩余百分比**，面板按「已使用 = 100 − 剩余」显示 |
| Claude/GPT 5-hour / weekly | 同一条输出的第 3、4 行 | 同上 |
| 重置时间 | 每行第 4 列（UTC ISO） | 原样交给 Paseo，面板显示「将在 N 后重置」 |

`agy -p "/quota"` 的真实输出（2026-11-10 实测，制表符分隔）：

```text
Gemini Models	Weekly Limit Remaining	13%	2026-11-13T23:43:48Z
Gemini Models	Five Hour Limit Remaining	90%	2026-11-10T10:33:10Z
Claude and GPT models	Weekly Limit Remaining	26%	2026-11-16T23:55:50Z
Claude and GPT models	Five Hour Limit Remaining	56%	2026-11-10T10:48:07Z
```

额度是 `agy` 自己通过已登录的 Google 账号刷出来的（CLI 内部 `quota_manager` → `fetchQuotaStatus`），
所以插件**不读 token、不读 keychain、不自己拼内网 RPC**：拿到的就是 CLI UI 里那一份数。
实测 `/quota` 只回这四行、不新建 conversation（`~/.gemini/antigravity-cli/conversations/` 数量不变）。

## 为什么不直接读 CLI 的缓存

`agy` **不把额度落盘**：跑一次 `/quota` 前后对比 `~/.gemini` 下所有文件的 mtime，只有
`log/`、`cache/onboarding.json`、`conversation_summaries.db` 变了，没有任何 quota 文件；
`quota_manager.go` 的刷新结果只活在 CLI 进程内存里。所以“读 CLI 缓存”没有可读对象，缓存只能由插件自己做。
（另一条熟路是拿 keychain 里的 OAuth token 直接打 `cloudcode-pa` 的配额 RPC，但 keychain 条目
service `gemini` / account `antigravity` 对非 CLI 进程会弹授权框，且回包是私有 proto——以后要提速再评估。）

插件内的缓存策略：

- 第一次有人在面板上看这张卡：spawn 一次 CLI（约 6–7 秒），拿到就存进内存快照。
- 之后每次刷新面板读快照（实测整张列表 0.5 秒，之前 5–7 秒），卡片多一行「额度刷新：agy 后台刷新，N 分钟前」。
- 有人用面板时，插件每 15 分钟在后台重跑一次 CLI，把快照续上；**30 分钟没人看就停**，不跑后台进程。
- daemon 重启 / 插件 reload 后第一次看会再花一次 CLI 启动时间，属于预期。

## 安装与验收

```bash
cd paseo-plugins/antigravity-usage-source
npm install                       # 只有 devDependencies，供 daemon 解析 @getpaseo/*
npm run typecheck
node --test server/*.test.ts
paseo plugin install ./paseo-plugins/antigravity-usage-source
paseo plugin ls                   # 要求 antigravity-usage-source = running
paseo usage ls                    # Antigravity 行应为 available，带四条窗口
```

面板入口：侧栏底部「使用情况」（或 `paseo usage`）。服务端把结果缓存 5 分钟，点卡片右上角刷新可强制重取。

## 已知限制

- **只做账号额度，不做单轮 token**：agy 的逐轮 token（input / cached / output / thought）由 `agy-acp`
  从 conversation DB 的 `gen_metadata` 上报给 Paseo，`live-usage` 插件已经在读同一份数据；这里不重复做。
- **每次刷新会拉起一次 `agy` 进程**（实测冷启 5–7 秒）→ 已按上一节改成“首次一次 + 15 分钟后台续期 + 30 分钟无访问停”，
  面板走的是内存快照；只有冷启动或快照过旧（>1 小时）时才会同步等一次 CLI。
- 输出格式是 CLI 的打印文本，`agy` 大版本升级后要重跑上面的验收；解析规则集中在 `server/usage.ts`
  的 `parseQuotaOutput`，单测里有真实输出的 fixture。
- 找不到 `agy` 二进制时卡片显示不可用；查找顺序是 `$AGY_BIN` → `~/.local/bin/agy` →
  `/opt/homebrew/bin/agy` → `/usr/local/bin/agy`。
- 登录过期时 CLI 会报未登录，插件归为「不可用」，重新在终端 `agy` 登录一次即可，不需要重装插件。
