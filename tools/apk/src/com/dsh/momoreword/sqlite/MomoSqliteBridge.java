package com.wordc.app.sqlite;

import android.content.Context;
import android.database.sqlite.SQLiteException;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.util.UUID;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 0.11.0 M1：JS ↔ native SQLite 异步桥（registered as window.MomoSqlite）。
 *
 * - `sqliteCall(reqJson)` 立即返回 `{"requestId":"..."}`，绝不在此线程执行 SQL；
 * - 单线程 SqliteTaskExecutor 执行后回调 `window.__momoSqliteResult(requestId, respJson)`；
 * - `sqliteCancel(requestId)` 取消排队/执行中的任务；
 * - 所有异常转换为 JSON error，不抛给 WebView。
 */
public class MomoSqliteBridge {
    public static final String JS_NAME = "MomoSqlite";
    private static final Pattern ID_PATTERN = Pattern.compile("\"id\"\\s*:\\s*\"([A-Za-z0-9_.:-]{1,120})\"");

    private final Context context;
    private final WebView webView;
    private final MomoSqliteOpenHelper helper;
    private final SqliteDao dao;
    private final SqliteTaskExecutor executor = new SqliteTaskExecutor();
    private volatile boolean closed = false;

    public MomoSqliteBridge(Context context, WebView webView) {
        this.context = context;
        this.webView = webView;
        this.helper = new MomoSqliteOpenHelper(context);
        this.dao = new SqliteDao(helper);
    }

    @JavascriptInterface
    public String sqliteCall(String reqJson) {
        if (closed) return ackError("E_ABORTED", "bridge closed");
        String requestId = UUID.randomUUID().toString();
        try {
            Matcher matcher = ID_PATTERN.matcher(reqJson == null ? "" : reqJson);
            if (matcher.find()) requestId = matcher.group(1);
            else return ackError(SqliteProtocol.E_BAD_REQUEST, "missing request id");
        } catch (Exception ignored) {
            return ackError(SqliteProtocol.E_BAD_REQUEST, "invalid request");
        }
        final String id = requestId;
        final String raw = reqJson;
        executor.submit(id, new Runnable() {
            @Override public void run() {
                JSONObject response;
                long started = System.currentTimeMillis();
                try {
                    JSONObject req = SqliteProtocol.parse(raw);
                    response = null;
                    SQLiteException lastLocked = null;
                    for (int attempt = 0; attempt < 3; attempt++) {
                        try {
                            response = dispatch(req);
                            lastLocked = null;
                            break;
                        } catch (SQLiteException e) {
                            String msg = e.getMessage() == null ? "" : e.getMessage();
                            if (msg.contains("locked") || msg.contains("busy")) {
                                lastLocked = e;
                                try { Thread.sleep(120L * (attempt + 1)); } catch (InterruptedException ignored) { Thread.currentThread().interrupt(); }
                                continue;
                            }
                            throw e;
                        }
                    }
                    if (response == null) {
                        throw lastLocked != null ? lastLocked : new SQLiteException("locked retry exhausted");
                    }
                    response.put("id", id);
                    response.put("durationMs", System.currentTimeMillis() - started);
                } catch (IllegalArgumentException e) {
                    response = SqliteProtocol.error(id, codeOf(e), e.getMessage());
                } catch (SQLiteException e) {
                    String msg = e.getMessage() == null ? "" : e.getMessage();
                    String code = msg.contains("locked") || msg.contains("busy") ? SqliteProtocol.E_BUSY : SqliteProtocol.E_IO;
                    response = SqliteProtocol.error(id, code, msg);
                } catch (Exception e) {
                    response = SqliteProtocol.error(id, SqliteProtocol.E_IO, e.getClass().getSimpleName() + ": " + e.getMessage());
                }
                deliver(id, response);
            }
        });
        JSONObject ack = new JSONObject();
        try {
            ack.put("requestId", id);
        } catch (Exception ignored) {}
        return ack.toString();
    }

    @JavascriptInterface
    public String sqliteCancel(String requestId) {
        boolean ok = executor.cancel(requestId);
        JSONObject out = new JSONObject();
        try {
            out.put("ok", ok);
            out.put("requestId", requestId);
        } catch (Exception ignored) {}
        return out.toString();
    }

    /** 调试用：同步仅返回 bridge 状态，不执行 DB。 */
    @JavascriptInterface
    public String sqliteBridgeInfo() {
        JSONObject out = new JSONObject();
        try {
            out.put("available", !closed);
            out.put("dbName", MomoSqliteOpenHelper.DB_NAME);
            out.put("dbVersion", MomoSqliteOpenHelper.DB_VERSION);
        } catch (Exception ignored) {}
        return out.toString();
    }

    public void close() {
        closed = true;
        executor.shutdown();
        try { helper.close(); } catch (Exception ignored) {}
    }

    private JSONObject dispatch(JSONObject req) throws Exception {
        String method = req.getString("method");
        JSONObject expect = req.optJSONObject("expect");
        if (expect != null) {
            long expectedVersion = expect.optLong("userVersion", -1);
            if (expectedVersion >= 0 && dao.userVersion() != expectedVersion) {
                throw new IllegalArgumentException(SqliteProtocol.E_SCHEMA + ": userVersion " + dao.userVersion() + " != " + expectedVersion);
            }
            long expectedEpoch = expect.optLong("dataEpoch", -1);
            if (expectedEpoch >= 0) {
                long actual = dao.health().optLong("dataEpoch", 0);
                if (actual != expectedEpoch) throw new IllegalArgumentException(SqliteProtocol.E_CONFLICT + ": dataEpoch " + actual + " != " + expectedEpoch);
            }
        }
        JSONObject result;
        int changes = 0;
        if ("health".equals(method)) {
            result = dao.health();
        } else if ("integrity".equals(method)) {
            result = dao.integrity();
        } else if ("query".equals(method)) {
            JSONObject payload = req.optJSONObject("payload");
            JSONObject op = payload != null ? payload : firstOp(req);
            return flatten(req, method, dao.query(op), 0);
        } else if ("exec".equals(method)) {
            JSONObject op = firstOp(req);
            changes = dao.exec(op);
            result = new JSONObject();
        } else if ("tx".equals(method)) {
            JSONArray ops = req.optJSONArray("ops");
            if (ops == null) throw new IllegalArgumentException(SqliteProtocol.E_BAD_REQUEST + ": tx ops required");
            changes = dao.tx(ops);
            result = new JSONObject();
        } else if ("contentList".equals(method)) {
            JSONObject payload = req.optJSONObject("payload");
            return flatten(req, method, dao.contentList(payload != null ? payload : req), 0);
        } else if ("contentGet".equals(method)) {
            JSONObject payload = req.optJSONObject("payload");
            return flatten(req, method, dao.contentGet(payload != null ? payload : req), 0);
        } else if ("contentSeed".equals(method)) {
            JSONObject payload = req.optJSONObject("payload");
            String asset = payload != null ? payload.optString("asset", "pwa/seed/content.db") : "pwa/seed/content.db";
            File tmp = new File(context.getCacheDir(), "content-seed.db");
            try (java.io.InputStream in = context.getAssets().open(asset);
                 java.io.OutputStream out = new java.io.FileOutputStream(tmp)) {
                byte[] buf = new byte[8192];
                int n;
                while ((n = in.read(buf)) >= 0) out.write(buf, 0, n);
            }
            result = dao.contentSeedFromFile(tmp.getAbsolutePath());
            changes = result.optInt("inserted", 0);
            return flatten(req, method, result, changes);
        } else if ("contentWrite".equals(method)) {
            JSONObject payload = req.optJSONObject("payload");
            return flatten(req, method, dao.contentWrite(payload != null ? payload : req), 0);
        } else if ("contentCounts".equals(method)) {
            JSONObject payload = req.optJSONObject("payload");
            return flatten(req, method, dao.contentCounts(payload != null ? payload : req), 0);
        } else if ("backup".equals(method)) {
            String backupName = req.optString("name", "");
            if (backupName.length() == 0) {
                JSONObject payload = req.optJSONObject("payload");
                if (payload != null) backupName = payload.optString("name", "");
            }
            result = dao.backup(backupName);
        } else if ("writeBackupManifest".equals(method)) {
            JSONObject payload = req.optJSONObject("payload");
            String name = req.optString("name", payload != null ? payload.optString("name", "") : "");
            String manifest = req.optString("manifest", payload != null ? payload.optString("manifest", "") : "");
            result = dao.writeBackupManifest(name, manifest);
        } else if ("readBackupManifest".equals(method)) {
            JSONObject payload = req.optJSONObject("payload");
            String name = req.optString("name", payload != null ? payload.optString("name", "") : "");
            result = dao.readBackupManifest(name);
        } else if ("listBackups".equals(method)) {
            result = new JSONObject().put("backups", dao.listBackups());
        } else if ("deleteBackup".equals(method)) {
            String deleteName = req.optString("name", "");
            if (deleteName.length() == 0) {
                JSONObject payload = req.optJSONObject("payload");
                if (payload != null) deleteName = payload.optString("name", "");
            }
            result = dao.deleteBackup(deleteName);
        } else if ("restoreDb".equals(method)) {
            String restorePath = req.optString("path", "");
            if (restorePath.length() == 0) {
                JSONObject payload = req.optJSONObject("payload");
                if (payload != null) restorePath = payload.optString("path", "");
            }
            result = dao.restoreDb(restorePath);
        } else if ("selfTest".equals(method)) {
            result = dao.selfTest();
        } else {
            throw new IllegalArgumentException(SqliteProtocol.E_UNSUPPORTED + ": method " + method);
        }
        return flatten(req, method, result, changes);
    }

    /** 协议面：health/query 的字段放顶层（dev-data JS 直接读 userVersion/rows），同时保留 result 兼容。 */
    private JSONObject flatten(JSONObject req, String method, JSONObject result, int changes) throws Exception {
        JSONObject out = new JSONObject();
        out.put("ok", true);
        out.put("changes", changes);
        if (result != null) {
            java.util.Iterator<String> it = result.keys();
            while (it.hasNext()) {
                String key = it.next();
                out.put(key, result.get(key));
            }
        }
        out.put("dataEpoch", dao.health().optLong("dataEpoch", 0));
        if ("health".equals(method)) {
            out.put("wal", result.optBoolean("wal", false));
            out.put("integrityOk", result.optBoolean("integrityOk", false));
            out.put("sizeBytes", result.optLong("sizeBytes", 0));
            out.put("dbBytes", result.optLong("dbBytes", 0));
            out.put("readOnly", result.optBoolean("readOnly", false));
            out.put("synchronous", result.optString("synchronous", "FULL"));
        }
        out.put("result", result == null ? new JSONObject() : result);
        return out;
    }

    private static JSONObject firstOp(JSONObject req) throws Exception {
        JSONArray ops = req.optJSONArray("ops");
        if (ops == null || ops.length() == 0) throw new IllegalArgumentException(SqliteProtocol.E_BAD_REQUEST + ": ops required");
        return ops.getJSONObject(0);
    }

    private void deliver(String requestId, JSONObject response) {
        if (closed || webView == null) return;
        final String script = "window.__momoSqliteResult&&window.__momoSqliteResult("
                + JSONObject.quote(requestId) + "," + JSONObject.quote(response.toString()) + ");";
        webView.post(new Runnable() {
            @Override public void run() {
                try {
                    webView.evaluateJavascript(script, null);
                } catch (Exception ignored) {}
            }
        });
    }

    private static String codeOf(IllegalArgumentException e) {
        String message = e.getMessage() == null ? "" : e.getMessage();
        int colon = message.indexOf(':');
        String code = colon > 0 ? message.substring(0, colon) : message;
        for (String known : new String[]{SqliteProtocol.E_BUSY, SqliteProtocol.E_IO, SqliteProtocol.E_QUOTA,
                SqliteProtocol.E_SCHEMA, SqliteProtocol.E_CONFLICT, SqliteProtocol.E_TOO_LARGE,
                SqliteProtocol.E_CORRUPT, SqliteProtocol.E_UNSUPPORTED, SqliteProtocol.E_ABORTED,
                SqliteProtocol.E_DOWNGRADE, SqliteProtocol.E_BAD_REQUEST}) {
            if (known.equals(code)) return code;
        }
        return SqliteProtocol.E_BAD_REQUEST;
    }

    private static String ackError(String code, String message) {
        JSONObject out = SqliteProtocol.error("", code, message);
        return out.toString();
    }
}
