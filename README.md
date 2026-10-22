# Session Atlas · Codex 会话地图

中文｜[English](README.en.md)

把 iTerm2 里并行运行的 Codex 会话放到一张本机地图上：找到等待你回应的线程，保存尚未完成的工作，关掉窗口后仍能回到原线程和目录继续。

[使用指南](docs/usage.md) · [版本与验证范围](docs/compatibility-and-distribution.md) · [反馈](https://github.com/peipei-labs/session-atlas/issues)

![多会话总览：匿名演示数据](docs/screenshots/overview.jpg)

## 先看界面

需要 Node.js 22.12+，在终端运行：

```sh
git clone https://github.com/peipei-labs/session-atlas.git
cd session-atlas
npm ci
VITE_SESSION_ATLAS_DEMO=1 npx vite --host 127.0.0.1 --port 4318
```

打开 <http://127.0.0.1:4318>。演示使用固定数据，不接入真实会话。

## 接入自己的终端

需要 macOS、iTerm2 3.6+（开启 Python API）、Python 3，以及通过自动协议检查的 Codex CLI。安装时会核对协议结构与初始化握手，验证范围见[兼容说明](docs/compatibility-and-distribution.md)。

```sh
npm run install:macos
```

打开 <http://127.0.0.1:4317>。浏览器中的发送、回答和中断仅用于 Atlas 管理的 Codex 线程。服务只在本机运行，保存短待续卡和恢复信息，不保存完整对话。

[安装、快捷键与卸载](docs/usage.md#macos-installation) · [待续与恢复](docs/session-continuation.md) · [已知问题](docs/known-issues.md)

[MIT](LICENSE) · [第三方声明](THIRD_PARTY_NOTICES.md)

友情链接：[LINUX DO](https://linux.do/)
