# dsh-session-browser

DSH Desktop 插件 —— 会话浏览器，支持轮次级导航和消息跳转。

## 功能

- **会话浏览面板**：可拖拽、可调大小的浮动面板
- **会话列表**：显示所有会话标题、更新时间，支持搜索过滤
- **轮次列表**：显示选中会话的所有用户提问（轮次）
- **消息跳转**：点击轮次自动加载历史并滚动到目标消息
- **标题同步**：与主界面侧边栏使用同一数据源
- **折叠展开**：自动展开工作区组和会话溢出

## 安装

### 从源码构建

```bash
git clone https://github.com/user/dsh-session-browser.git
cd dsh-session-browser
npm install
```

### 安装到 DSH Desktop

1. 将 `lib/` 目录复制到 DSH Desktop 配置目录的插件文件夹中
2. 在 `package.json` 的 `dsh.bundle.patch` 字段中注册插件
3. 重启 DSH Desktop

## 文件结构

```
dsh-session-browser/
├── cordis.patch.yml      # Cordis 插件注册配置
├── package.json          # 项目配置
├── lib/
│   ├── index.mjs         # 宿主端（API 路由）
│   └── client.js         # 客户端（UI 组件）
└── src/
    ├── index.ts          # 宿主端 TypeScript 源码
    └── client/
        └── index.ts      # 客户端 TypeScript 源码
```

## 技术栈

- DSH Desktop Plugin System (Cordis IoC)
- React (via DSH Desktop)
- ModuleLoader Format (客户端)
- TypeScript (源码)

## 许可证

MIT
