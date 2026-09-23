# Hermes 定位记忆（OwnTracks + Cloudflare Worker）

定位记忆是 `userProfile` 下的独立旁路，默认关闭。它不会写入 L1/L2/L3、Reward 或 Skill，也不会把坐标交给 LLM、飞书或 Cloudflare。Cloudflare D1 只暂存 OwnTracks 已加密的 JSON 信封，本机解密后才进行地点判断。

## 开关语义

只有以下两个开关同时为 `true` 时功能才运行：

```yaml
userProfile:
  enabled: true
  location:
    enabled: true
    relayUrl: "https://pigmemory-location-relay.<account>.workers.dev"
```

任何一个开关关闭时，本机停止轮询、上下文注入和飞书通知，删除本机尚未处理的密文，并调用 `/control/revoke` 撤销 Worker 收集租约及清空 D1 队列。已经形成的语义地点、访问和每日摘要保留。异常退出时无法主动撤销，但 Worker 租约最长十分钟后自动失效，新请求仍返回成功并直接丢弃。

此开关不能停止 iPhone 的定位和耗电；如需彻底停止，还要在 OwnTracks 中关闭监控。

## Cloudflare 免费部署

不需要域名，直接使用 `workers.dev`：

```bash
cd location-worker
cp wrangler.toml.example wrangler.toml
npx wrangler d1 create pigmemory-location-relay
# 将输出的 database_id 写入 wrangler.toml
npx wrangler d1 execute pigmemory-location-relay --remote --file schema.sql
npx wrangler secret put LOCATION_RELAY_USERNAME
npx wrangler secret put LOCATION_RELAY_PASSWORD
npx wrangler secret put LOCATION_RELAY_CONTROL_TOKEN
npx wrangler deploy
```

三个 secret 只应通过 Wrangler/Dashboard 配置，不要写进 `wrangler.toml`、部署清单或备份清单。Worker 端点如下：

- `POST /pub`：OwnTracks Basic 鉴权入口；只接受 `_type=encrypted`。
- `POST /pull`：Bearer 鉴权，批量领取五分钟租约。
- `POST /ack`：只有本机完整处理成功后才确认删除。
- `POST /control/lease`：PigMemory 每五分钟续期十分钟。
- `POST /control/revoke`：立即停止收集并清空 D1 密文。

D1 最多保留密文七天，并在发布、拉取和续租时机会式清理。Worker 不持有 OwnTracks 解密密钥，也不保存 HTTP 标识头、用户名、设备名或明文坐标。

## 本机 secret

在启动 Hermes/PigMemory 的进程环境中配置：

```bash
export PIGMEMORY_LOCATION_CONTROL_TOKEN='与 Worker 相同的控制 token'
export PIGMEMORY_LOCATION_ENCRYPTION_KEY='OwnTracks encryptionKey（1–32 UTF-8 字节）'
# 可选；未设置时从 encryption key 派生用途隔离的 HMAC
export PIGMEMORY_LOCATION_HMAC_KEY='独立随机 HMAC key'
```

`LOCATION_RELAY_USERNAME/PASSWORD` 只用于 iPhone 到 Worker，不需要交给 PigMemory。解密/HMAC key 不进入 YAML、Worker 或普通日志。

## OwnTracks iPhone 设置

1. Connection Mode 选 HTTP，URL 为 `https://<worker>.workers.dev/pub`。
2. 用户名和密码使用 Worker 的 Basic 鉴权 secret。
3. 设置与本机完全一致的 `encryptionKey`，确认发出的 JSON 外层是 `_type: encrypted`。
4. 建议 Move 模式、位移阈值 250 米、最长上报间隔 10 分钟。

到达判定为 200 米内至少三个有效样本并持续 20 分钟；离开判定为连续两个样本在 350 米外且跨度至少 10 分钟。精度差于 200 米和乱序样本只进入短期审计，不改变状态。参数均可在 YAML 中调整。

新地点稳定停留 30 分钟后，飞书发送一次命名卡片。按 `地点名｜城市` 回复即可；已命名地点的到达/离开只发送确定性短消息，不调用 LLM。用户上下文和每日摘要只出现语义地点，不出现坐标。

## 数据与回退

原始密文和坐标在成功处理七天后清理；失败项保留在本机等待诊断/重试。长期 `semantic_places` 只保存名称、城市和 geohash-7 邻域 HMAC，`location_visits` 只保存语义地点与到离时间。

本次实施前备份位于：

```text
/home/leslie/backups/pigmemory/location-feature-20260810T053841Z/
```

先只读检查：

```bash
node scripts/location-rollback.mjs inspect \
  --backup /home/leslie/backups/pigmemory/location-feature-20260810T053841Z
```

回退顺序：

1. `soft-disable`：关闭开关并尽力撤销 Worker；不删历史地点。
2. `prepare-code`：把旧源码解到 `/tmp` 候选目录，人工比较后再恢复并重启；不会覆盖当前源码。
3. `purge-location`：仅显式清空定位专用表，普通记忆不受影响。
4. `prepare-database`：只生成 `data/memos.restore-candidate.db` 并校验，不覆盖当前库。整库替换会丢失备份后产生的所有普通记忆，只能作为数据库损坏时的最后手段。

每个有写入影响的动作都要求命令行确认词；脚本不会自动用备份覆盖 `data/memos.db`。
