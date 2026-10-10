# onlymanes.ai/test —— V1 内测页（临时）

公开地址：https://onlymanes.ai/test/

## 这是什么

onlymanes.ai V1 个人智能的临时测试页。当前为前端界面 + 身份切换；
后端（Cloudflare Workers + 免费模型 API）上线后，页面通过 `localStorage.om_api`
配置的地址连接 `/api/chat`。

## 访问统计

独立访客统计暂用 GitHub traffic API（仓库自带，无需额外部署）：

```
gh-api GET /repos/onlymanes/test/traffic/views
```

返回 14 天内的 views / uniques。每日快照由 Muse 的 cron 存档到
`~/workspace/onlymanes.ai/stats/`，以保留 14 天窗口之外的历史。
是否真人：现阶段以后端 beacon 的 UA/行为启发式判断（待 Worker 上线）；
目前 traffic 数据仅作粗略参考。

## 部署

本仓库 `main` 分支根目录 → GitHub Pages → 自动落在 onlymanes.ai/test/。
