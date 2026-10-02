# dsh-session-browser

**DSH Desktop 插件** —— 会话浏览器，支持轮次级导航、消息跳转与可恢复的删除（回收站）。

适配 **DSH Desktop 0.2.0-rc.2**（源码 tag `dsh-v0.2.0-rc.2`）。

## 功能

- **四页签会话列表**：未归档 / 未分组 / 已归档 / 已删除
  - 「未分组」与 DSH 侧边栏同口径：不属于任何工作区的会话
  - 「已删除」是本插件自带的回收站，删除是**可恢复的逻辑删除**
- **轮次级导航**：列出选中会话的全部用户提问，点击跳转并滚动到目标消息
- **消息跳转**：自动加载历史窗口再定位锚点，长会话里也能回得去
- **六操作排**：归档 / 移出归档 / 删除 / 恢复删除 / 移动 / 迁移，一行平排，按页签自动禁用
- **回收站恢复**：删除时快照会话名称与项目目录，恢复时放回**原项目工作区**并还原删除前的归档状态
- **标题同步**：与主界面侧边栏使用同一数据源

## 安装

### 方式一：插件页安装（推荐）

打开 DSH Desktop →「插件」页 → 安装，输入以下任一 spec：

| spec | 说明 |
|---|---|
| `github:C-H-C-H/dsh-session-browser` | 从 GitHub 直接装；**本机需能直连 GitHub**（该地址不走 npm 镜像） |
| `dsh-session-browser` | 若已发布到 npm，直接输入包名 |

安装完成后在插件页启用，重启 DSH Desktop。

### 方式二：本地目录安装（当前采用）

1. 把**整个仓库目录**（含 `package.json`、`cordis.patch.yml`、`lib/`）放到 profile 的 `node_modules` 下：

   ```
   C:\Users\<你>\.dsh\profiles\desktop\node_modules\dsh-session-browser\
   ```

   > 注意是整个目录，不是只拷 `lib/`。

2. 编辑 `C:\Users\<你>\.dsh\profiles\desktop\package.json`，**两处**都要加：

   ```jsonc
   {
     "dependencies": {
       "dsh-session-browser": "file:./node_modules/dsh-session-browser"
     },
     "dsh": {
       "profile": {
         "bundles": [
           /* … 已有条目 … */,
           "dsh-session-browser"
         ]
       }
     }
   }
   ```

3. **完全退出**并重启 DSH Desktop。侧边栏出现「会话浏览」按钮即成功。

### 卸载

profile `package.json` 删掉上述两处注册 + 删除 `node_modules` 下的目录 + 重启 DSH。

## ⚠️ 改动后何时需要重启

本插件是双半结构，**两半的生效方式不同**：

| 文件 | 运行位置 | 生效方式 |
|---|---|---|
| `lib/client.js` | 渲染进程 | **关闭并重开会话浏览面板**即可 |
| `lib/index.mjs` | **DSH 主进程**（启动时 import） | **必须完全退出并重启 DSH** |

只改客户端却去重启 DSH 是浪费；改了宿主却只重开面板，则会看到"改了没反应"的假象（症状通常是页签内容异常，且界面不报错）。

面板顶部若出现 `⚠ 插件宿主未重载`，就是宿主仍是旧代码。

## 开发者

```bash
git clone https://github.com/C-H-C-H/dsh-session-browser.git
cd dsh-session-browser
npm install
```

源码在 `src/`，产物在 `lib/`，二者需手工同步（仓库无构建工具链）。测试逐个文件运行：

```bash
node test/trash-restore.test.mjs        # 其余 *.test.mjs 同理
```

## 文件结构

```
dsh-session-browser/
├── cordis.patch.yml      # DSH 注册配置
├── package.json          # 含 dsh 字段（DSH 识别插件的依据）
├── lib/
│   ├── index.mjs         # 宿主半（API 路由，主进程）
│   └── client.js         # 客户端半（面板 UI，渲染进程）
├── src/
│   ├── index.ts          # 宿主半 TypeScript 源码
│   └── client/index.ts   # 客户端半 TypeScript 源码
└── test/                 # 9 个测试文件，92 条用例
```

## 许可证

MIT