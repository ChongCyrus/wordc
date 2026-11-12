package com.wordc.app;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.lang.reflect.Field;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Iterator;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;

import org.json.JSONArray;
import org.json.JSONObject;
import java.util.HashMap;
import java.util.Map;

/**
 * 最小 WebView 壳：把 assets/pwa/ 下的 PWA 以真实 https origin 提供给 WebView，
 * 并提供原生文件能力（task-33）：
 *
 * 1) 导出：JS 调 `MomoBridge.saveBase64File(fileName, mime, base64)` → 写入系统「下载」目录下
 *    `WordC/`；API 29+ 用 MediaStore.Downloads（IS_PENDING 事务、无需权限），
 *    API 24–28 用公共 Downloads 目录 + 运行时 WRITE_EXTERNAL_STORAGE；
 *    返回 `ok:<绝对路径>` / `err:<原因>`，IO 在 WebView 的 JS 桥线程执行（非主线程），异常不抛给 JS。
 * 2) 导入：实现 WebChromeClient.onShowFileChooser（ACTION_GET_CONTENT）+ onActivityResult，
 *    Web 侧标准 `<input type=file>` 即可选文件。
 *
 * 为什么不用 file://：file:// 是 opaque origin，IndexedDB 等存储可用性不一致；
 * 这里伪装成 https://appassets.local/...（安全上下文），在 shouldInterceptRequest 里从
 * APK 的 assets/pwa/ 读文件返回。
 */
public class MainActivity extends Activity {

    private static final String ORIGIN = "https://appassets.local";
    private static final String START_URL = ORIGIN + "/index.html";
    private static final String ASSET_ROOT = "pwa/";

    /** 导出目录名（系统「下载」下的子目录） */
    private static final String SAVE_DIR_NAME = "WordC";
    private static final int REQ_FILE_CHOOSER = 1001;
    private static final int REQ_WRITE_STORAGE = 1002;

    private WebView webView;
    /** 文件选择回调（一次性） */
    private ValueCallback<Uri[]> filePathCallback;

    /** AiApi（AI 生成内容直连）后台线程池与在途请求表（task-72） */
    private final ExecutorService aiExecutor = Executors.newCachedThreadPool();
    private final ConcurrentHashMap<String, Future<?>> aiFutures = new ConcurrentHashMap<String, Future<?>>();
    private final ConcurrentHashMap<String, HttpURLConnection> aiConnections =
            new ConcurrentHashMap<String, HttpURLConnection>();
    private static final String AI_PREFS = "momo_ai";
    private static final String AI_HOSTS_KEY = "allowed_hosts";
    private static final String AI_DEFAULT_HOST = "api.deepseek.com";
    private static final int AI_TIMEOUT_MS = 60000;
    private static final int AI_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

    /** MomoApi（MaiMemo API 原生直连）后台线程池与在途请求表 */
    private final ExecutorService apiExecutor = Executors.newCachedThreadPool();
    private final ConcurrentHashMap<String, Future<?>> apiFutures = new ConcurrentHashMap<String, Future<?>>();
    private final ConcurrentHashMap<String, HttpURLConnection> apiConnections =
            new ConcurrentHashMap<String, HttpURLConnection>();

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        webView = new WebView(this);
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);          // localStorage / sessionStorage
        settings.setDatabaseEnabled(true);            // 兼容旧 WebView 的 IndexedDB 开关
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setMediaPlaybackRequiresUserGesture(true);
        settings.setSupportZoom(false);
        settings.setBuiltInZoomControls(false);
        settings.setUseWideViewPort(true);
        settings.setLoadWithOverviewMode(true);
        settings.setTextZoom(100);                    // 尊重页面自身字号设置

        // 原生文件导出桥（JS 通过 window.MomoBridge 调用）
        webView.addJavascriptInterface(new FileBridge(), "MomoBridge");
        // MaiMemo API 原生直连桥（CORS 绕行；白名单只允许 open.maimemo.com）
        webView.addJavascriptInterface(new MomoApiBridge(), "MomoApi");
        // AI 生成内容原生直连桥（独立 allowlist，默认只允许 api.deepseek.com；自定义 host 需原生确认）
        webView.addJavascriptInterface(new AiApiBridge(), "AiApi");

        // 原生文件导入（<input type=file>）
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                             FileChooserParams params) {
                if (filePathCallback != null) {
                    filePathCallback.onReceiveValue(null);
                    filePathCallback = null;
                }
                filePathCallback = callback;

                Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);

                String[] acceptTypes = params != null ? params.getAcceptTypes() : null;
                if (acceptTypes != null && acceptTypes.length > 0) {
                    String first = acceptTypes[0] == null ? "" : acceptTypes[0].trim();
                    intent.setType(first.isEmpty() || "*/*".equals(first) ? "*/*" : first);
                    if (acceptTypes.length > 1) {
                        intent.putExtra(Intent.EXTRA_MIME_TYPES, acceptTypes);
                    }
                } else {
                    intent.setType("*/*");
                }
                if (params != null
                        && params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE) {
                    intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                }

                try {
                    startActivityForResult(Intent.createChooser(intent, "选择文件"), REQ_FILE_CHOOSER);
                } catch (ActivityNotFoundException e) {
                    filePathCallback = null;
                    try {
                        callback.onReceiveValue(null);
                    } catch (Throwable ignored) {
                    }
                    return false;
                }
                return true;
            }
        });

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (uri != null && "appassets.local".equals(uri.getHost())) {
                    return serveFromAssets(uri);
                }
                return null;
            }

            // 用 String 版本重载：API 23 编译桩里没有 WebResourceRequest 版本（API 24+ 才有），
            // 系统在 API 24+ 会同时回调带 WebResourceRequest 的重载，String 版本仍会被调用，行为一致。
            @SuppressWarnings("deprecation")
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                if (url == null) return false;
                Uri uri = Uri.parse(url);
                if ("appassets.local".equals(uri.getHost())) return false; // 站内，交给 WebView
                // 外部链接（如词库许可/资料链接）交给系统浏览器，避免把壳变成浏览器
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, uri));
                } catch (Exception ignored) {
                }
                return true;
            }
        });

        setContentView(webView);
        webView.loadUrl(START_URL);
    }

    // =====================================================================
    // 原生文件导出桥
    // =====================================================================

    /**
     * JS 桥：`window.MomoBridge.isNativeApp()` / `window.MomoBridge.saveBase64File(...)`。
     * @JavascriptInterface 方法在 WebView 的 JavaBridge 线程执行（非主线程），可直接做 IO；
     * 任何异常都转成 `err:` 字符串返回，绝不抛给 JS。
     */
    private class FileBridge {

        @JavascriptInterface
        public String isNativeApp() {
            return "momo-apk";
        }

        @JavascriptInterface
        public String saveBase64File(String fileName, String mime, String base64) {
            if (fileName == null || fileName.trim().isEmpty()) return "err:文件名不能为空";
            if (base64 == null || base64.isEmpty()) return "err:文件内容为空";

            final byte[] data;
            try {
                data = Base64.decode(base64, Base64.DEFAULT);
            } catch (IllegalArgumentException e) {
                return "err:base64 解码失败";
            }
            if (data.length == 0) return "err:文件内容为空";

            String safeName = sanitizeFileName(fileName);
            String safeMime = (mime == null || mime.trim().isEmpty())
                    ? "application/octet-stream" : mime.trim();

            try {
                if (Build.VERSION.SDK_INT >= 29) {
                    return saveViaMediaStore(safeName, safeMime, data);
                }
                return saveViaPublicDir(safeName, data);
            } catch (Throwable t) {
                String msg = t.getMessage();
                return "err:" + t.getClass().getSimpleName() + (msg == null ? "" : ":" + msg);
            }
        }
    }

    /** 文件名净化：去掉路径分隔符/非法字符，限制长度 */
    private static String sanitizeFileName(String raw) {
        String name = raw.trim().replaceAll("[\\\\/:*?\"<>|\\r\\n\\t]", "_");
        name = name.replaceAll("^[. ]+", "");
        if (name.isEmpty()) name = "backup.bin";
        if (name.length() > 96) {
            int dot = name.lastIndexOf('.');
            if (dot > 0 && name.length() - dot <= 16) {
                name = name.substring(0, 96 - (name.length() - dot)) + name.substring(dot);
            } else {
                name = name.substring(0, 96);
            }
        }
        return name;
    }

    /** API 29+：MediaStore.Downloads + RELATIVE_PATH + IS_PENDING（无需存储权限） */
    private String saveViaMediaStore(String fileName, String mime, byte[] data) {
        ContentResolver resolver = getContentResolver();
        Uri collection = downloadsCollection();
        String finalName = uniqueNameInDownloads(fileName);

        ContentValues values = new ContentValues();
        values.put(MediaStore.MediaColumns.DISPLAY_NAME, finalName);
        values.put(MediaStore.MediaColumns.MIME_TYPE, mime);
        // RELATIVE_PATH / IS_PENDING 是 API 29 的列，用字符串列名避免在 API 23 编译桩上引用常量
        values.put("relative_path", Environment.DIRECTORY_DOWNLOADS + "/" + SAVE_DIR_NAME);
        values.put("is_pending", 1);

        Uri item = resolver.insert(collection, values);
        if (item == null) return "err:无法创建下载文件（MediaStore 返回空）";

        OutputStream out = null;
        try {
            out = resolver.openOutputStream(item);
            if (out == null) {
                resolver.delete(item, null, null);
                return "err:无法写入下载文件";
            }
            out.write(data);
            out.flush();
        } catch (IOException e) {
            try {
                resolver.delete(item, null, null);
            } catch (Throwable ignored) {
            }
            return "err:写入失败:" + e.getClass().getSimpleName();
        } finally {
            if (out != null) {
                try {
                    out.close();
                } catch (IOException ignored) {
                }
            }
        }

        ContentValues done = new ContentValues();
        done.put("is_pending", 0);
        resolver.update(item, done, null, null);
        return "ok:" + publicFilePath(finalName);
    }

    /** MediaStore.Downloads.EXTERNAL_CONTENT_URI（API 29 才有的类，用反射避免编译期依赖） */
    private Uri downloadsCollection() {
        try {
            Class<?> cls = Class.forName("android.provider.MediaStore$Downloads");
            Field field = cls.getField("EXTERNAL_CONTENT_URI");
            Object value = field.get(null);
            if (value instanceof Uri) return (Uri) value;
        } catch (Throwable ignored) {
        }
        // 兜底：Downloads 的 MediaStore 集合 uri 就是 content://media/external/downloads
        return Uri.parse("content://media/external/downloads");
    }

    /** API 24–28：公共 Downloads 目录直接写文件 + 运行时存储权限 */
    @SuppressWarnings("deprecation")
    private String saveViaPublicDir(String fileName, byte[] data) {
        if (checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE)
                != PackageManager.PERMISSION_GRANTED) {
            // 权限申请必须在主线程；返回 err 让 JS 提示用户并在授权后重试
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    if (Build.VERSION.SDK_INT < 29) {
                        requestPermissions(
                                new String[]{Manifest.permission.WRITE_EXTERNAL_STORAGE},
                                REQ_WRITE_STORAGE);
                    }
                }
            });
            return "err:需要存储权限，请在系统弹窗中允许后重试";
        }
        File dir = new File(
                Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS),
                SAVE_DIR_NAME);
        if (!dir.exists() && !dir.mkdirs()) {
            return "err:无法创建下载目录（请检查存储权限）";
        }
        File target = new File(dir, uniqueNameInDir(dir, fileName));
        FileOutputStream out = null;
        try {
            out = new FileOutputStream(target);
            out.write(data);
            out.flush();
        } catch (IOException e) {
            return "err:写入失败:" + e.getClass().getSimpleName();
        } finally {
            if (out != null) {
                try {
                    out.close();
                } catch (IOException ignored) {
                }
            }
        }
        return "ok:" + target.getAbsolutePath();
    }

    /** 用户可见路径（API 29+ MediaStore 的 RELATIVE_PATH 最终也落在这里） */
    @SuppressWarnings("deprecation")
    private String publicFilePath(String fileName) {
        File dir = new File(
                Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS),
                SAVE_DIR_NAME);
        return new File(dir, fileName).getAbsolutePath();
    }

    private String uniqueNameInDownloads(String fileName) {
        File dir = new File(
                Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS),
                SAVE_DIR_NAME);
        return uniqueNameInDir(dir, fileName);
    }

    /** 重名加 (1)(2)… 后缀（1000 次上限防死循环） */
    private static String uniqueNameInDir(File dir, String fileName) {
        String base = fileName;
        String ext = "";
        int dot = fileName.lastIndexOf('.');
        if (dot > 0 && fileName.length() - dot <= 16) {
            base = fileName.substring(0, dot);
            ext = fileName.substring(dot);
        }
        File candidate = new File(dir, fileName);
        int index = 0;
        while (candidate.exists() && index < 1000) {
            index++;
            candidate = new File(dir, base + "(" + index + ")" + ext);
        }
        return candidate.getName();
    }

    // =====================================================================
    // 文件选择回传
    // =====================================================================

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == REQ_FILE_CHOOSER) {
            ValueCallback<Uri[]> callback = filePathCallback;
            filePathCallback = null;
            if (callback == null) {
                super.onActivityResult(requestCode, resultCode, data);
                return;
            }
            Uri[] results = null;
            if (resultCode == RESULT_OK && data != null) {
                ClipData clip = data.getClipData();
                if (clip != null && clip.getItemCount() > 0) {
                    ArrayList<Uri> uris = new ArrayList<Uri>();
                    for (int i = 0; i < clip.getItemCount(); i++) {
                        Uri uri = clip.getItemAt(i).getUri();
                        if (uri != null) uris.add(uri);
                    }
                    if (!uris.isEmpty()) results = uris.toArray(new Uri[0]);
                } else if (data.getData() != null) {
                    results = new Uri[]{data.getData()};
                }
            }
            try {
                callback.onReceiveValue(results);
            } catch (Throwable ignored) {
            }
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        // 授权结果不影响壳状态：JS 在 err 回调后自行重试 saveBase64File 即可
        if (requestCode == REQ_WRITE_STORAGE) return;
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
    }

    // =====================================================================
    // AI 生成内容原生直连桥（task-72）—— 独立于 MomoApi
    //
    // JS: window.AiApi.request(requestId, method, url, headersJson, body)
    //     回调 window.__aiApiCallback(requestId, resultJson)
    //     window.AiApi.addHost(host, requestId) → 原生确认对话框 → window.__aiApiHostResult(requestId, "ok"|"denied"|"invalid")
    //
    // 安全：
    // - 仅 https；host 必须在原生 allowlist（默认 api.deepseek.com + 用户确认添加的 host）；
    // - 不跟随重定向；60s 超时；8MB 响应上限；
    // - **不打印/不落盘 Authorization**；SharedPreferences 只存 host 名单，不存 Key。
    // =====================================================================

    private class AiApiBridge {

        @JavascriptInterface
        public String isNativeApp() {
            return "ai-apk";
        }

        @JavascriptInterface
        public String allowedHosts() {
            return new JSONArray(allowedAiHosts()).toString();
        }

        /**
         * 请求添加自定义 AI host：必须经用户原生确认（防注入页面静默扩大白名单）。
         * 结果通过 window.__aiApiHostResult(requestId, "ok"|"denied"|"invalid") 回调。
         */
        @JavascriptInterface
        public void addHost(final String rawHost, final String requestId) {
            if (requestId == null || requestId.isEmpty()) return;
            final String host = normalizeAiHost(rawHost);
            if (host == null) {
                postHostResult(requestId, "invalid");
                return;
            }
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    try {
                        new AlertDialog.Builder(MainActivity.this)
                                .setTitle("允许 AI 服务地址？")
                                .setMessage("即将允许连接 https://" + host + "\n\n"
                                        + "仅在你信任该服务时添加；它会收到你输入的单词内容与 API Key。")
                                .setNegativeButton("取消", new android.content.DialogInterface.OnClickListener() {
                                    @Override
                                    public void onClick(android.content.DialogInterface dialog, int which) {
                                        postHostResult(requestId, "denied");
                                    }
                                })
                                .setPositiveButton("允许", new android.content.DialogInterface.OnClickListener() {
                                    @Override
                                    public void onClick(android.content.DialogInterface dialog, int which) {
                                        addAllowedAiHost(host);
                                        postHostResult(requestId, "ok");
                                    }
                                })
                                .setOnCancelListener(new android.content.DialogInterface.OnCancelListener() {
                                    @Override
                                    public void onCancel(android.content.DialogInterface dialog) {
                                        postHostResult(requestId, "denied");
                                    }
                                })
                                .show();
                    } catch (Throwable t) {
                        postHostResult(requestId, "invalid");
                    }
                }
            });
        }

        @JavascriptInterface
        public void request(final String requestId, final String method,
                            final String url, final String headersJson, final String body) {
            if (requestId == null || requestId.isEmpty()) return;
            final String verb = method == null ? "POST" : method.trim().toUpperCase(Locale.US);
            if (!"POST".equals(verb)) {
                postAiResult(requestId, aiErrorResult("AI 只允许 POST"));
                return;
            }
            URL parsed;
            try {
                parsed = new URL(url == null ? "" : url);
            } catch (Exception e) {
                postAiResult(requestId, aiErrorResult("URL 无效"));
                return;
            }
            if (!"https".equalsIgnoreCase(parsed.getProtocol()) || parsed.getUserInfo() != null) {
                postAiResult(requestId, aiErrorResult("只允许 https 且不带 userinfo"));
                return;
            }
            int port = parsed.getPort();
            if (port != -1 && port != 443) {
                postAiResult(requestId, aiErrorResult("只允许 443 端口"));
                return;
            }
            if (!isAllowedAiHost(parsed.getHost())) {
                postAiResult(requestId, aiErrorResult("host 不在白名单（请先在设置中确认添加）"));
                return;
            }
            final String target = url;
            Future<?> future = aiExecutor.submit(new Runnable() {
                @Override
                public void run() {
                    executeAiRequest(requestId, target, headersJson, body);
                }
            });
            aiFutures.put(requestId, future);
        }

        @JavascriptInterface
        public void cancel(String requestId) {
            if (requestId == null) return;
            Future<?> future = aiFutures.remove(requestId);
            if (future != null) future.cancel(true);
            HttpURLConnection conn = aiConnections.remove(requestId);
            if (conn != null) {
                try {
                    conn.disconnect();
                } catch (Throwable ignored) {
                }
            }
        }
    }

    private SharedPreferences aiPrefs() {
        return getSharedPreferences(AI_PREFS, MODE_PRIVATE);
    }

    private Set<String> allowedAiHosts() {
        Set<String> hosts = new HashSet<String>();
        hosts.add(AI_DEFAULT_HOST);
        Set<String> stored = aiPrefs().getStringSet(AI_HOSTS_KEY, null);
        if (stored != null) {
            for (String h : stored) {
                if (h != null && !h.isEmpty()) hosts.add(h.toLowerCase(Locale.US));
            }
        }
        return hosts;
    }

    private boolean isAllowedAiHost(String host) {
        if (host == null) return false;
        return allowedAiHosts().contains(host.toLowerCase(Locale.US));
    }

    private void addAllowedAiHost(String host) {
        Set<String> next = new HashSet<String>(allowedAiHosts());
        next.add(host.toLowerCase(Locale.US));
        aiPrefs().edit().putStringSet(AI_HOSTS_KEY, next).apply();
    }

    /** 合法 host：域名（含点）、无协议/路径/端口、非 localhost/私网字面量 */
    private static String normalizeAiHost(String raw) {
        if (raw == null) return null;
        String host = raw.trim().toLowerCase(Locale.US);
        if (host.startsWith("http://") || host.startsWith("https://") || host.contains("/")) return null;
        if (host.endsWith(".")) host = host.substring(0, host.length() - 1);
        if (host.isEmpty() || host.length() > 253 || !host.contains(".")) return null;
        if (!host.matches("[a-z0-9.-]+")) return null;
        if (host.equals("localhost") || host.endsWith(".localhost")) return null;
        if (host.matches("^(\\d{1,3}\\.){3}\\d{1,3}$")) return null; // 拒绝裸 IP（含私网）
        return host;
    }

    private void executeAiRequest(String requestId, String rawUrl, String headersJson, String body) {
        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) new URL(rawUrl).openConnection();
            conn.setConnectTimeout(AI_TIMEOUT_MS);
            conn.setReadTimeout(AI_TIMEOUT_MS);
            conn.setInstanceFollowRedirects(false);
            conn.setRequestMethod("POST");
            conn.setRequestProperty("Accept", "application/json");
            if (headersJson != null && !headersJson.isEmpty()) {
                JSONObject headers = new JSONObject(headersJson);
                java.util.Iterator<String> keys = headers.keys();
                while (keys.hasNext()) {
                    String key = keys.next();
                    if (key == null) continue;
                    String lower = key.toLowerCase(Locale.US);
                    if ("host".equals(lower) || "content-length".equals(lower) || "connection".equals(lower)) continue;
                    String value = headers.optString(key, null);
                    if (value != null) conn.setRequestProperty(key, value);
                }
            }
            conn.setDoOutput(true);
            byte[] payload = body == null ? new byte[0] : body.getBytes("UTF-8");
            if (payload.length > 0) {
                OutputStream out = conn.getOutputStream();
                try {
                    out.write(payload);
                    out.flush();
                } finally {
                    try {
                        out.close();
                    } catch (IOException ignored) {
                    }
                }
            }
            aiConnections.put(requestId, conn);
            int status = conn.getResponseCode();
            InputStream in = status >= 400 ? conn.getErrorStream() : conn.getInputStream();
            String text = readText(in, AI_MAX_RESPONSE_BYTES);
            JSONObject result = new JSONObject();
            result.put("ok", true);
            result.put("status", status);
            result.put("body", text);
            postAiResult(requestId, result.toString());
        } catch (Exception e) {
            postAiResult(requestId, aiErrorResult(e.getClass().getSimpleName()
                    + (e.getMessage() == null ? "" : ": " + e.getMessage())));
        } finally {
            aiConnections.remove(requestId);
            aiFutures.remove(requestId);
            if (conn != null) {
                try {
                    conn.disconnect();
                } catch (Throwable ignored) {
                }
            }
        }
    }

    private static String aiErrorResult(String message) {
        try {
            JSONObject obj = new JSONObject();
            obj.put("ok", false);
            obj.put("error", message == null ? "unknown error" : message);
            return obj.toString();
        } catch (Exception e) {
            return "{\"ok\":false,\"error\":\"unknown error\"}";
        }
    }

    private void postHostResult(final String requestId, final String result) {
        final WebView view = webView;
        if (view == null) return;
        view.post(new Runnable() {
            @Override
            public void run() {
                try {
                    String js = "window.__aiApiHostResult(" + JSONObject.quote(requestId)
                            + "," + JSONObject.quote(result) + ")";
                    view.evaluateJavascript(js, null);
                } catch (Throwable ignored) {
                }
            }
        });
    }

    // =====================================================================
    // MaiMemo API 原生直连桥（task-37）
    //
    // WebView 内 fetch 会被 open.maimemo.com 的 CORS 拦截（响应无 ACAO 头），
    // 因此由原生层代发 HTTP：JS 调 window.MomoApi.request(requestId, method, url,
    // headersJson, body)，完成后回调 window.__momoApiCallback(requestId, resultJson)。
    //
    // 安全边界：
    // - 只允许 https://open.maimemo.com（host 白名单），防止被注入页面利用发任意请求；
    // - 只允许 GET/POST；不跟随重定向（避免跳转到非白名单 host）；
    // - 20s 连接/读取超时；响应体上限 8MB；异常/超时回调 ok:false，不抛 JS；
    // - 网络 IO 在后台线程池执行；**不打印/不落盘请求头**（避免 Authorization 泄漏）。
    // =====================================================================

    private class MomoApiBridge {

        @JavascriptInterface
        public String isNativeApp() {
            return "momo-apk";
        }

        /**
         * 异步发起请求；完成后通过 window.__momoApiCallback(requestId, json) 回调。
         * 任何错误都以 {"ok":false,"error":...} 返回，绝不抛出到 JS。
         */
        @JavascriptInterface
        public void request(final String requestId, final String method,
                            final String url, final String headersJson, final String body) {
            if (requestId == null || requestId.isEmpty()) return;
            final String verb = method == null ? "GET" : method.trim().toUpperCase();
            if (!"GET".equals(verb) && !"POST".equals(verb)) {
                postResult(requestId, errorResult("只允许 GET/POST"));
                return;
            }
            if (!isAllowedMomoUrl(url)) {
                postResult(requestId, errorResult("URL 不在白名单（仅 https://open.maimemo.com）"));
                return;
            }
            Future<?> future = apiExecutor.submit(new Runnable() {
                @Override
                public void run() {
                    executeRequest(requestId, verb, url, headersJson, body);
                }
            });
            apiFutures.put(requestId, future);
        }

        /** 页面卸载/放弃时取消（可选） */
        @JavascriptInterface
        public void cancel(String requestId) {
            if (requestId == null) return;
            Future<?> future = apiFutures.remove(requestId);
            if (future != null) future.cancel(true);
            HttpURLConnection conn = apiConnections.remove(requestId);
            if (conn != null) {
                try {
                    conn.disconnect();
                } catch (Throwable ignored) {
                }
            }
        }
    }

    /** 白名单：仅 https + host 精确等于 open.maimemo.com */
    private static boolean isAllowedMomoUrl(String rawUrl) {
        if (rawUrl == null) return false;
        try {
            URL u = new URL(rawUrl);
            boolean https = "https".equalsIgnoreCase(u.getProtocol());
            boolean hostOk = "open.maimemo.com".equalsIgnoreCase(u.getHost());
            boolean portOk = u.getPort() == -1 || u.getPort() == 443; // -1 = 默认 443
            return https && hostOk && portOk;
        } catch (Exception e) {
            return false;
        }
    }

    /** 在后台线程执行 HTTP（HttpURLConnection），完成后回主线程 evaluateJavascript */
    private void executeRequest(String requestId, String method, String rawUrl,
                                String headersJson, String body) {
        HttpURLConnection conn = null;
        try {
            URL u = new URL(rawUrl);
            conn = (HttpURLConnection) u.openConnection();
            conn.setConnectTimeout(20000);
            conn.setReadTimeout(20000);
            conn.setInstanceFollowRedirects(false);   // 不跟随重定向（白名单绕过防护）
            conn.setRequestMethod(method);
            conn.setRequestProperty("Accept", "application/json");

            if (headersJson != null && !headersJson.isEmpty()) {
                JSONObject headers = new JSONObject(headersJson);
                Iterator<String> keys = headers.keys();
                while (keys.hasNext()) {
                    String key = keys.next();
                    if (key == null) continue;
                    String lower = key.toLowerCase();
                    // 这些头由系统/连接管理，禁止覆盖
                    if ("host".equals(lower) || "content-length".equals(lower)
                            || "connection".equals(lower)) {
                        continue;
                    }
                    String value = headers.optString(key, null);
                    if (value != null) conn.setRequestProperty(key, value);
                }
            }

            if ("POST".equals(method)) {
                conn.setDoOutput(true);
                byte[] payload = body == null ? new byte[0] : body.getBytes("UTF-8");
                if (payload.length > 0) {
                    OutputStream out = conn.getOutputStream();
                    try {
                        out.write(payload);
                        out.flush();
                    } finally {
                        try {
                            out.close();
                        } catch (IOException ignored) {
                        }
                    }
                }
            }

            apiConnections.put(requestId, conn);
            int status = conn.getResponseCode();
            InputStream in = status >= 400 ? conn.getErrorStream() : conn.getInputStream();
            String text = readText(in, 8 * 1024 * 1024);

            JSONObject result = new JSONObject();
            result.put("ok", true);
            result.put("status", status);
            result.put("body", text);
            postResult(requestId, result.toString());
        } catch (Exception e) {
            // 不回传请求头，避免 Authorization 出现在错误信息里
            postResult(requestId, errorResult(e.getClass().getSimpleName()
                    + (e.getMessage() == null ? "" : ": " + e.getMessage())));
        } finally {
            apiConnections.remove(requestId);
            apiFutures.remove(requestId);
            if (conn != null) {
                try {
                    conn.disconnect();
                } catch (Throwable ignored) {
                }
            }
        }
    }

    private static String readText(InputStream in, int maxBytes) throws IOException {
        if (in == null) return "";
        BufferedReader reader = null;
        try {
            reader = new BufferedReader(new InputStreamReader(in, "UTF-8"));
            StringBuilder sb = new StringBuilder();
            char[] buf = new char[4096];
            int n;
            while ((n = reader.read(buf)) != -1) {
                sb.append(buf, 0, n);
                if (sb.length() > maxBytes) break; // 防御超大响应
            }
            return sb.toString();
        } finally {
            if (reader != null) {
                try {
                    reader.close();
                } catch (IOException ignored) {
                }
            }
        }
    }

    private static String errorResult(String message) {
        try {
            JSONObject obj = new JSONObject();
            obj.put("ok", false);
            obj.put("error", message == null ? "unknown error" : message);
            return obj.toString();
        } catch (Exception e) {
            return "{\"ok\":false,\"error\":\"unknown error\"}";
        }
    }

    /** 回主线程调用 window.__momoApiCallback(requestId, resultJson) */
    /** AiApi 原生桥回调（task-117：必须调用 __aiApiCallback，不能复用 MomoApi 的 __momoApiCallback） */
    private void postAiResult(final String requestId, final String resultJson) {
        final WebView view = webView;
        if (view == null) return;
        view.post(new Runnable() {
            @Override
            public void run() {
                try {
                    String js = "window.__aiApiCallback(" + JSONObject.quote(requestId)
                            + "," + JSONObject.quote(resultJson) + ")";
                    view.evaluateJavascript(js, null);
                } catch (Throwable ignored) {
                }
            }
        });
    }

    private void postResult(final String requestId, final String resultJson) {
        final WebView view = webView;
        if (view == null) return;
        view.post(new Runnable() {
            @Override
            public void run() {
                try {
                    String js = "window.__momoApiCallback(" + JSONObject.quote(requestId)
                            + "," + JSONObject.quote(resultJson) + ")";
                    view.evaluateJavascript(js, null);
                } catch (Throwable ignored) {
                }
            }
        });
    }

    // =====================================================================
    // assets → https://appassets.local 映射（原有逻辑，保持不变）
    // =====================================================================

    /** 把 https://appassets.local/<path> 映射到 assets/pwa/<path> */
    private WebResourceResponse serveFromAssets(Uri uri) {
        String path = uri.getPath();
        if (path == null || path.isEmpty() || "/".equals(path)) {
            path = "/index.html";
        }
        String assetPath = ASSET_ROOT + path.substring(1);
        // 目录形式回退到 index.html（HashRouter 下一般用不到，防御式处理）
        if (assetPath.endsWith("/")) {
            assetPath = assetPath + "index.html";
        }
        try {
            InputStream stream = getAssets().open(assetPath);
            Map<String, String> headers = new HashMap<String, String>();
            headers.put("Cache-Control", "no-cache");
            return new WebResourceResponse(mimeOf(assetPath), encodingOf(assetPath), 200, "OK", headers, stream);
        } catch (IOException e) {
            // 单页应用回退：无扩展名的路径交给 index.html（HashRouter 本不需要，防御 WebView 差异）
            if (assetPath.indexOf('.') < 0) {
                try {
                    return new WebResourceResponse("text/html", "utf-8", 200, "OK", null,
                            getAssets().open(ASSET_ROOT + "index.html"));
                } catch (IOException ignored) {
                }
            }
            return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found", null,
                    new ByteArrayInputStream("404 Not Found".getBytes()));
        }
    }

    private static String mimeOf(String path) {
        String p = path.toLowerCase();
        if (p.endsWith(".html") || p.endsWith(".htm")) return "text/html";
        if (p.endsWith(".js") || p.endsWith(".mjs")) return "text/javascript";
        if (p.endsWith(".css")) return "text/css";
        if (p.endsWith(".json")) return "application/json";
        if (p.endsWith(".webmanifest")) return "application/manifest+json";
        if (p.endsWith(".svg")) return "image/svg+xml";
        if (p.endsWith(".png")) return "image/png";
        if (p.endsWith(".jpg") || p.endsWith(".jpeg")) return "image/jpeg";
        if (p.endsWith(".webp")) return "image/webp";
        if (p.endsWith(".woff2")) return "font/woff2";
        if (p.endsWith(".woff")) return "font/woff";
        if (p.endsWith(".ttf")) return "font/ttf";
        if (p.endsWith(".mp3")) return "audio/mpeg";
        if (p.endsWith(".txt")) return "text/plain";
        return "application/octet-stream";
    }

    private static String encodingOf(String path) {
        String mime = mimeOf(path);
        if (mime.startsWith("text/") || "application/json".equals(mime)
                || "application/manifest+json".equals(mime) || "image/svg+xml".equals(mime)) {
            return "utf-8";
        }
        return null; // 二进制
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onDestroy() {
        aiExecutor.shutdownNow();
        for (HttpURLConnection conn : aiConnections.values()) {
            try {
                conn.disconnect();
            } catch (Throwable ignored) {
            }
        }
        aiConnections.clear();
        aiFutures.clear();
        apiExecutor.shutdownNow();
        for (HttpURLConnection conn : apiConnections.values()) {
            try {
                conn.disconnect();
            } catch (Throwable ignored) {
            }
        }
        apiConnections.clear();
        apiFutures.clear();
        if (webView != null) {
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }
}
