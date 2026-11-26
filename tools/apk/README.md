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


## QA 变体包（与日用同装）

同一源码可产出 QA 包，applicationId=`com.wordc.app.qa`，独立数据目录，可与日用包同时安装：

```bash
APK_APPLICATION_ID=com.wordc.app.qa \
APK_APP_LABEL='WordC QA' \
APK_NAME_PREFIX='WordC-QA' \
VERSION=0.16.0-dev VERSION_CODE=219 \
APK_DEST=/tmp/apk-qa bash tools/apk/build-apk.sh
```

- 日用构建默认不变（`com.wordc.app` / 原 label）。
- QA 包沿用同一固定签名证书；不提交 keystore/token。
- QA shell：`MOMO_PKG=com.wordc.app.qa sh tools/qa/android/smoke.sh ...`（默认已是 qa）。
