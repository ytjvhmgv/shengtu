# 焰池 FluxPool — Node / Docker / Northflank

## 那三个 GitHub 变量是可选的

| 变量 | 放哪 | 要不要 |
|---|---|---|
| `NORTHFLANK_API_TOKEN` | GitHub Secrets | **可选**。只给 GitHub Actions 远程通知 Northflank 换镜像 |
| `NORTHFLANK_PROJECT_ID` | GitHub Secrets | **可选**。同上 |
| `NORTHFLANK_SERVICE_ID` | GitHub Secrets | **可选**。同上 |
| `PORT` / `DATA_DIR` / `ACCESS_KEY` / `POOL_JSON` | **Northflank 服务环境变量** | 运行时用，在 Northflank 控制台填 |

应用不会去读 `NORTHFLANK_*`。号池、密码、端口都在 Northflank 里配即可。

推荐：**Northflank 直接连 GitHub 构建**，不必填那三个 API 变量。

---

## 推荐：Northflank 连仓库自己构建

1. 把代码推到 GitHub
2. Northflank → Create service → **Build from GitHub** → 选这个仓库
3. Dockerfile 路径：`Dockerfile`，端口 **8080**
4. 在 Northflank 这个服务的 **Environment / Secrets** 里加：

| 名字 | 值 |
|---|---|
| `PORT` | `8080` |
| `ACCESS_KEY` | 访问密码，可选 |
| `DEFAULT_MODEL` | `flux-2-klein-4b` |
| `POOL_JSON` | 整个 `pool.json` 文件内容 |
| `UPSTASH_REDIS_REST_URL` | Upstash REST URL，例如 `https://xxx.upstash.io` |
| `UPSTASH_REDIS_REST_TOKEN` | Upstash REST Token |

配了 Upstash 后 **不用挂磁盘**。号池额度状态和出图任务都写 Redis（任务 1 小时过期）。

Upstash：https://console.upstash.com/ → Create Redis → 复制 REST URL / Token。

5. 如果不用 Upstash，才需要磁盘挂 `/data`，并设 `DATA_DIR=/data`。

这样 GitHub Secrets 里 **不用** 配 Northflank token / project / service。

---

## 可选：GitHub Actions 打镜像再推 Northflank

只有当你要「GitHub 构建 → GHCR → 用 API 让 Northflank 换镜像」时，才需要那三个：

- `NORTHFLANK_API_TOKEN`
- `NORTHFLANK_PROJECT_ID`
- `NORTHFLANK_SERVICE_ID`

不填也能构建并推 `ghcr.io/<用户>/<仓库>:latest`。然后在 Northflank 用 **External image** 填这个镜像地址，自己点 Deploy 也行。

若要用 Actions 把号池打进镜像，再加 GitHub Secret `POOL_JSON`。否则把号池放 Northflank 环境变量更干净。

---

本地：

```powershell
cd C:\Users\Lenovo\Desktop\codex-program\cloudflare-flux-pool
node server.mjs
```

http://127.0.0.1:8080
