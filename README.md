# 📌 TeamsEcho v1.2.1

专为 Microsoft Teams 打造的轻量化、高效率桌面自动化辅助工具。

## 🔒 隐私安全与运行校验规范
1. **零留存机制**：本软件不进行任何形式的写盘操作或网络上传，完全在本地内存运作。
2. **首次运行引导**：由于未付费进行商用公证，首次运行若被 Gatekeeper 拦截，请**右键点击软件选择「打开」**。并且在首次运行时，请确保在 macOS 的 `系统设置 -> 隐私与安全性 -> 辅助功能` 中赋予本地应用程序以控制键盘流的权限。

## ✅ 构件证明（SLSA Build Provenance）
从 v1.1.4 起，Release 发布流程会在 `publish` job 内、上传到 GitHub Releases 之前，对最终产物文件（`release-dir/*.zip`）执行 `actions/attest-build-provenance@v2` 签名。
- 签名与发布在**同一个 job** 内完成，不经过二次打包或跨 job 传输，避免 SHA-256 漂移。
- 相关写权限（`id-token`、`attestations`）仅授予 `publish` 这一个 job，`build` job 仍保持只读的 `contents: read`。
- 你可以在 Release 页面通过 `gh attestation verify` 或 GitHub 的 Attestations 面板核实产物来源。