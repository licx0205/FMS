# 管理系统部署指南（MySQL 版）

这是一个基于**腾讯云 CloudBase** 的通用管理系统骨架：Vue 前端 + 云函数后端 + **MySQL 数据库**。

## 项目结构

```
admin-system/
├── cloudbaserc.json              部署配置（需填环境ID）
├── cloudfunctions/
│   └── data-api/                 后端云函数
│       ├── index.js              登录 + MySQL 增删改查逻辑
│       └── package.json
└── web/
    └── index.html                前端管理界面（单文件）
```

## 功能

- 登录鉴权（默认账号 `admin` / 密码 `admin123`）
- 数据列表、搜索、新增、编辑、删除
- 数据持久化存储在 MySQL 的 `records` 表（云函数首次运行自动建表）

## 数据库连接

后端云函数通过 `mysql2` 连接你的 MySQL：

- host: `172.17.0.8`
- port: `3306`
- user: `root`
- database: `test-d2g8lzeup3f63654a`

**⚠️ 部署前必须先做一件事：** 打开 `cloudfunctions/data-api/index.js`，把顶部 `DB_CONFIG` 里的 `password` 填成你的 MySQL 密码（目前是空字符串）。

## 部署步骤

### 第 1 步：部署云函数

云函数推荐用控制台部署（免命令行）：

1. 登录 [CloudBase 控制台](https://console.cloud.tencent.com/tcb)，进入你的环境
2. 左侧「云函数」→「新建云函数」
3. 函数名填 `data-api`，运行环境选 **Node.js 16**
4. 上传方式：把 `admin-system/cloudfunctions/data-api/index.js` 的内容粘贴到在线编辑器
5. 依赖：需安装 `mysql2`（控制台一般支持在线安装依赖，或上传 ZIP 含 node_modules）

### 第 2 步：部署前端

1. 控制台左侧「静态网站托管」→ 上传 `admin-system/web/index.html`
2. 记下托管给你的访问域名（形如 `xxx.tcloudbaseapp.com`）

### 第 3 步：填入环境 ID

打开 `web/index.html`，找到 `cloudbase.init({ env: "替换为你的环境ID" })`，把 `替换为你的环境ID` 改成你的真实环境 ID。

> 若云函数和前端在同一个环境，也可以改用 `cloudbase.init({ env: "..." })` 后，前端仍通过 `callFunction` 调用，无需其他配置。

### 第 4 步：访问

浏览器打开托管域名，用 `admin` / `admin123` 登录即可。第一次点「新增记录」时，云函数会自动创建 `records` 表。

## 上线前必改（安全）

- **MySQL 密码**：填入 `index.js` 的 `DB_CONFIG.password`。
- **管理员密码**：修改 `index.js` 顶部的 `ADMIN_PASS`。
- 数据库 `root` 账号的 `%` 主机权限建议收敛为仅内网（生产环境）。

## 扩展方向

- 增加更多实体：在 `records` 表基础上加 `extra` 字段承载扩展数据，或新建表并复制云函数逻辑。
- 接入微信登录 / 手机号验证，替换当前的简易 token 鉴权。
- 增加字段：在 `web/index.html` 的新增/编辑弹窗里加输入项。
