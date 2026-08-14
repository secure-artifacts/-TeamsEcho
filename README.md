# TeamsEcho v1.2.5

专为 Microsoft Teams 打造的轻量化桌面自动化辅助工具。

## 隐私、安全与运行权限

TeamsEcho 的自动化仅在本机执行。首次运行时，请在 macOS 的“系统设置 → 隐私与安全性 → 辅助功能”中授予应用控制键盘的权限；未公证构建如被 Gatekeeper 拦截，可在“应用程序”中右键选择“打开”。

## 模式与稳定性基线

| 模式 | 推荐稳定档位 | 键序 |
|---|---:|---|
| 稳妥模式 | 6 档 | `@ → 左移 → 粘贴 → 1 → 删除 → 回车` |
| 极速模式 | 8 档 | `@ → 粘贴 → 1 → 删除 → 回车` |

极速模式 9 档使用极速模式 8 档的候选搜索等待下限作为最小保护，但仍属于测试档；10 档不建议用于正式批量操作。

## 构件证明与 Release 验证

v1.2.5 发布工作流采用 Draft Release → 上传最终命名资产 → `actions/attest@v4` 证明最终字节流 → 发布 Draft 的顺序。发布资产固定为 `TeamsEcho-macos-vX.Y.Z.zip`、`TeamsEcho-intel-vX.Y.Z.zip` 与 `TeamsEcho-windows-vX.Y.Z.zip`，并附带 SHA-256 清单。

发布后可执行：

```bash
gh attestation verify TeamsEcho-macos-v1.2.5.zip --repo secure-artifacts/-TeamsEcho
gh attestation verify TeamsEcho-intel-v1.2.5.zip --repo secure-artifacts/-TeamsEcho
gh attestation verify TeamsEcho-windows-v1.2.5.zip --repo secure-artifacts/-TeamsEcho
```

## 窗口体验
主窗口支持自由调整大小，并会在正常退出后记住上次使用的窗口宽高；再次启动时自动恢复。为保护表单布局，最小尺寸为 760×520。
