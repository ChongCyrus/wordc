# tools/apk · Android WebView 壳（源码）

把 PWA `dist/` 打进一个最小 WebView APK 的脚本（无需 Android Studio/Gradle）。

- **不包含**签名密钥（`.secrets/`）、Android 工具链（`toolchain/` 下的 `android.jar`/`r8.jar`）、
  构建产物（`assets/pwa/`、`build/`）与任何 APK；这些需你自备或自行生成。
- 依赖：JDK 17、`aapt`/`zipalign`/`apksigner`/`zip`、`android.jar`（API 23 编译桩）、`r8.jar`（提供 d8）。
- 首次运行会自动生成 **你自己的** keystore（自签，用于本地安装）；也可通过环境变量
  `APK_KEYSTORE` / `APK_KEYSTORE_PASS` / `APK_KEY_ALIAS` 注入。
- 用法：先 `pnpm build` 生成 `dist/`，再 `bash tools/apk/build-apk.sh`（可选 `APK_DEST=<目录>`）。
- 本仓库**不发布 APK**；公开版包名为 `com.wordc.app`，请自行承担分发与合规责任。
- 不含任何官方图标/截图/素材；图标为本项目自制。
