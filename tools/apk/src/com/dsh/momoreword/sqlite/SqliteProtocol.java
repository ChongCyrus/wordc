package com.wordc.app.sqlite;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.Arrays;
import java.util.HashSet;
import java.util.Iterator;
import java.util.Set;

/** 0.11.0 M1：SQLite JSON 协议校验（白名单/大小/错误码），不执行 SQL。 */
public final class SqliteProtocol {
    public static final int MAX_REQUEST_BYTES = 8 * 1024 * 1024;
    public static final int MAX_OPS = 500;
    public static final int DEFAULT_TIMEOUT_MS = 8000;

    public static final String E_BUSY = "E_BUSY";
    public static final String E_IO = "E_IO";
    public static final String E_QUOTA = "E_QUOTA";
    public static final String E_SCHEMA = "E_SCHEMA";
    public static final String E_CONFLICT = "E_CONFLICT";
    public static final String E_TOO_LARGE = "E_TOO_LARGE";
    public static final String E_CORRUPT = "E_CORRUPT";
    public static final String E_UNSUPPORTED = "E_UNSUPPORTED";
    public static final String E_ABORTED = "E_ABORTED";
    public static final String E_DOWNGRADE = "E_DOWNGRADE";
    public static final String E_BAD_REQUEST = "E_BAD_REQUEST";

    public static final Set<String> TABLES = new HashSet<String>(Arrays.asList(
            "states", "plans", "settings", "review_logs", "client_ops", "diag", "schema_meta", "migration_state"
    ));
    public static final Set<String> METHODS = new HashSet<String>(Arrays.asList(
            "health", "query", "exec", "tx", "backup", "restoreDb", "listBackups", "deleteBackup", "writeBackupManifest", "readBackupManifest", "integrity", "selfTest"
    ));

    private SqliteProtocol() {}

    public static JSONObject error(String id, String code, String message) {
        JSONObject obj = new JSONObject();
        try {
            obj.put("id", id == null ? "" : id);
            obj.put("ok", false);
            obj.put("code", code == null ? E_IO : code);
            obj.put("message", message == null ? "" : message);
            JSONObject err = new JSONObject();
            err.put("code", code == null ? E_IO : code);
            err.put("message", message == null ? "" : message);
            obj.put("error", err);
        } catch (JSONException ignored) {}
        return obj;
    }

    public static JSONObject parse(String raw) throws JSONException, IllegalArgumentException {
        if (raw == null) throw new IllegalArgumentException(E_BAD_REQUEST + ": empty request");
        if (raw.getBytes(java.nio.charset.Charset.forName("UTF-8")).length > MAX_REQUEST_BYTES) {
            throw new IllegalArgumentException(E_TOO_LARGE + ": request > " + MAX_REQUEST_BYTES + " bytes");
        }
        JSONObject req = new JSONObject(raw);
        String id = req.optString("id", "");
        if (id.length() == 0) throw new IllegalArgumentException(E_BAD_REQUEST + ": missing id");
        String method = req.optString("method", "");
        if (!METHODS.contains(method)) throw new IllegalArgumentException(E_UNSUPPORTED + ": method " + method);
        if (req.has("ops")) {
            JSONArray ops = req.optJSONArray("ops");
            if (ops == null) throw new IllegalArgumentException(E_BAD_REQUEST + ": ops must be array");
            if (ops.length() > MAX_OPS) throw new IllegalArgumentException(E_TOO_LARGE + ": ops > " + MAX_OPS);
            for (int i = 0; i < ops.length(); i++) {
                JSONObject op = ops.optJSONObject(i);
                if (op == null) throw new IllegalArgumentException(E_BAD_REQUEST + ": op[" + i + "] not object");
                validateOp(op);
            }
        }
        if (req.has("expect")) {
            JSONObject expect = req.optJSONObject("expect");
            if (expect == null) throw new IllegalArgumentException(E_BAD_REQUEST + ": expect not object");
        }
        if (req.has("payload")) {
            JSONObject payload = req.optJSONObject("payload");
            if (payload == null) throw new IllegalArgumentException(E_BAD_REQUEST + ": payload not object");
        }
        return req;
    }

    public static void validateOp(JSONObject op) throws IllegalArgumentException {
        String action = op.optString("op", "");
        if (!"upsert".equals(action) && !"insert".equals(action) && !"update".equals(action)
                && !"delete".equals(action) && !"query".equals(action)) {
            throw new IllegalArgumentException(E_UNSUPPORTED + ": op " + action);
        }
        String table = op.optString("table", "");
        if (!TABLES.contains(table)) throw new IllegalArgumentException(E_UNSUPPORTED + ": table " + table);
        if ("upsert".equals(action) || "insert".equals(action)) {
            JSONObject row = op.optJSONObject("row");
            JSONArray rows = op.optJSONArray("rows");
            if (row == null && rows == null) throw new IllegalArgumentException(E_BAD_REQUEST + ": row/rows required");
            if (row != null) validateColumns(row);
            if (rows != null) {
                if (rows.length() > MAX_OPS) throw new IllegalArgumentException(E_TOO_LARGE + ": rows > " + MAX_OPS);
                for (int r = 0; r < rows.length(); r++) {
                    JSONObject item = rows.optJSONObject(r);
                    if (item == null) throw new IllegalArgumentException(E_BAD_REQUEST + ": rows[" + r + "] not object");
                    validateColumns(item);
                }
            }
        }
        if ("update".equals(action)) {
            JSONObject where = op.optJSONObject("where");
            JSONObject patch = op.optJSONObject("patch");
            if (where == null || where.length() == 0) throw new IllegalArgumentException(E_BAD_REQUEST + ": update where required");
            if (patch == null || patch.length() == 0) throw new IllegalArgumentException(E_BAD_REQUEST + ": update patch required");
            validateColumns(where);
            validateColumns(patch);
        }
        if ("delete".equals(action)) {
            JSONObject where = op.optJSONObject("where");
            if (where == null || where.length() == 0) throw new IllegalArgumentException(E_BAD_REQUEST + ": delete where required");
            if (where.has("*")) throw new IllegalArgumentException(E_BAD_REQUEST + ": delete * not allowed");
            validateColumns(where);
        }
        if (op.has("columns")) validateColumns(op.optJSONObject("columns"));
        if (op.has("where")) validateColumns(op.optJSONObject("where"));
    }

    public static void validateColumns(JSONObject obj) {
        if (obj == null) return;
        Iterator<String> it = obj.keys();
        while (it.hasNext()) {
            String key = it.next();
            if (!key.matches("[A-Za-z_][A-Za-z0-9_]*")) {
                throw new IllegalArgumentException(E_BAD_REQUEST + ": unsafe column " + key);
            }
        }
    }

    public static boolean isSafeIdent(String value) {
        return value != null && value.matches("[A-Za-z_][A-Za-z0-9_]*");
    }

    /** M4a 分页排序键白名单：states.word_id / plans.id / settings.key / review_logs.id。 */
    public static boolean isAllowedOrderColumn(String table, String column) {
        if ("states".equals(table)) return "word_id".equals(column);
        if ("plans".equals(table)) return "id".equals(column);
        if ("settings".equals(table)) return "key".equals(column);
        if ("review_logs".equals(table)) return "id".equals(column);
        if ("client_ops".equals(table)) return "op_id".equals(column);
        if ("migration_state".equals(table)) return "step".equals(column);
        return false;
    }
}
