package com.wordc.app.sqlite;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteException;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;

/** 0.11.0 M1：手写 SQL DAO（无 ORM/Room），所有方法在 SqliteTaskExecutor 单线程调用。 */
public class SqliteDao {
    private final MomoSqliteOpenHelper helper;

    public SqliteDao(MomoSqliteOpenHelper helper) {
        this.helper = helper;
    }

    private SQLiteDatabase db() {
        return helper.getWritableDatabase();
    }

    public JSONObject health() throws JSONException {
        SQLiteDatabase db = db();
        JSONObject out = new JSONObject();
        out.put("userVersion", scalarLong(db, "PRAGMA user_version"));
        String journalMode = scalarString(db, "PRAGMA journal_mode");
        out.put("journalMode", journalMode);
        out.put("wal", "wal".equalsIgnoreCase(journalMode));
        long connectionSync = scalarLong(db, "PRAGMA synchronous");
        out.put("connectionSynchronous", syncLabel(connectionSync));
        out.put("connectionSynchronousValue", connectionSync);
        // PRAGMA synchronous 是每连接设置；读连接池可能为 NORMAL，写事务连接才是提交可靠性依据。
        long writeSync = writeConnectionSynchronous(db);
        out.put("synchronous", syncLabel(writeSync));
        out.put("synchronousValue", writeSync);
        out.put("writeSynchronous", syncLabel(writeSync));
        out.put("readOnly", db.isReadOnly());
        out.put("integrityOk", quickIntegrityOk(db));
        JSONObject counts = new JSONObject();
        for (String table : SqliteProtocol.TABLES) {
            counts.put(table, scalarLong(db, "SELECT COUNT(*) FROM " + table));
        }
        out.put("counts", counts);
        out.put("dataEpoch", getDataEpoch(db));
        out.put("contentRevision", contentRevision(db));
        out.put("contentRows", scalarLong(db, "SELECT COUNT(*) FROM content_kv"));
        File file = helper.appContext().getDatabasePath(MomoSqliteOpenHelper.DB_NAME);
        long size = file != null && file.exists() ? file.length() : 0;
        out.put("dbBytes", size);
        out.put("sizeBytes", size);
        out.put("dbPath", file == null ? "" : file.getAbsolutePath());
        return out;
    }

    public JSONObject integrity() throws JSONException {
        SQLiteDatabase db = db();
        Cursor cursor = db.rawQuery("PRAGMA integrity_check", null);
        JSONArray rows = new JSONArray();
        boolean ok = true;
        try {
            while (cursor.moveToNext()) {
                String value = cursor.getString(0);
                rows.put(value);
                if (!"ok".equalsIgnoreCase(value)) ok = false;
            }
        } finally {
            cursor.close();
        }
        JSONObject out = new JSONObject();
        out.put("ok", ok);
        out.put("integrityOk", ok);
        out.put("rows", rows);
        return out;
    }

    public JSONObject query(JSONObject op) throws JSONException {
        SQLiteDatabase db = db();
        String table = op.getString("table");
        StringBuilder sql = new StringBuilder("SELECT ");
        sql.append(columnsClause(op.optJSONObject("columns")));
        sql.append(" FROM ").append(table);
        List<String> args = new ArrayList<String>();
        appendWhere(sql, args, op.optJSONObject("where"));
        String orderBy = op.optString("orderBy", "");
        if (orderBy.length() > 0) {
            String[] parts = orderBy.trim().split("\\s+");
            if (parts.length == 0 || !SqliteProtocol.isSafeIdent(parts[0])
                    || !SqliteProtocol.isAllowedOrderColumn(table, parts[0])) {
                throw new IllegalArgumentException(SqliteProtocol.E_BAD_REQUEST + ": unsafe orderBy " + orderBy);
            }
            sql.append(" ORDER BY ").append(parts[0]);
            String direction = parts.length > 1 ? parts[1] : op.optString("direction", "");
            if ("asc".equalsIgnoreCase(direction) || "desc".equalsIgnoreCase(direction)) {
                sql.append(" ").append(direction.toUpperCase());
            }
        }
        // M4a 分页：offset/limit 白名单范围；越界返回空页，不重复/不截断静默。
        int limit = Math.max(1, Math.min(op.optInt("limit", 500), 10000));
        int offset = Math.max(0, Math.min(op.optInt("offset", 0), 10_000_000));
        sql.append(" LIMIT ").append(limit).append(" OFFSET ").append(offset);
        Cursor cursor = db.rawQuery(sql.toString(), args.toArray(new String[0]));
        JSONArray rows = new JSONArray();
        JSONArray columns = new JSONArray();
        try {
            // 关键：getType() 依赖当前行；未 moveToFirst 时 position=-1 会抛
            // CursorIndexOutOfBoundsException（Index -1 requested）。先定位再读列类型。
            boolean hasRow = cursor.moveToFirst();
            for (int i = 0; i < cursor.getColumnCount(); i++) {
                JSONObject col = new JSONObject();
                col.put("name", cursor.getColumnName(i));
                col.put("type", hasRow ? typeName(cursor.getType(i)) : "TEXT");
                col.put("notNull", false);
                col.put("primaryKey", false);
                columns.put(col);
            }
            if (hasRow) {
                do {
                    rows.put(cursorRow(cursor));
                } while (cursor.moveToNext());
            }
        } finally {
            cursor.close();
        }
        JSONObject out = new JSONObject();
        out.put("rows", rows);
        out.put("columns", columns);
        out.put("nextCursor", JSONObject.NULL);
        out.put("count", rows.length());
        out.put("limit", limit);
        out.put("offset", offset);
        out.put("hasMore", rows.length() == limit);
        return out;
    }

    public int execOne(JSONObject op) throws JSONException {
        SQLiteDatabase db = db();
        String action = op.getString("op");
        String table = op.getString("table");
        if ("upsert".equals(action)) {
            int changes = 0;
            JSONArray rows = op.optJSONArray("rows");
            if (rows != null) {
                for (int i = 0; i < rows.length(); i++) {
                    ContentValues cv = toValues(rows.getJSONObject(i));
                    long id = db.insertWithOnConflict(table, null, cv, SQLiteDatabase.CONFLICT_REPLACE);
                    if (id == -1) throw new SQLiteException("upsert failed: " + table);
                    changes++;
                }
                return changes;
            }
            ContentValues cv = toValues(op.getJSONObject("row"));
            long id = db.insertWithOnConflict(table, null, cv, SQLiteDatabase.CONFLICT_REPLACE);
            if (id == -1) throw new SQLiteException("upsert failed: " + table);
            return 1;
        }
        if ("insert".equals(action)) {
            int changes = 0;
            JSONArray rows = op.optJSONArray("rows");
            if (rows != null) {
                for (int i = 0; i < rows.length(); i++) {
                    long id = db.insertOrThrow(table, null, toValues(rows.getJSONObject(i)));
                    if (id > 0) changes++;
                }
                return changes;
            }
            long id = db.insertOrThrow(table, null, toValues(op.getJSONObject("row")));
            return id > 0 ? 1 : 0;
        }
        if ("update".equals(action)) {
            ContentValues cv = toValues(op.getJSONObject("patch"));
            Where where = buildWhere(op.getJSONObject("where"), null);
            return db.update(table, cv, where.clause, where.args);
        }
        if ("delete".equals(action)) {
            if (op.optBoolean("all", false)) {
                // 仅 SqliteProtocol 白名单 facts 表会走到这里
                return db.delete(table, null, null);
            }
            Where where = buildWhere(op.getJSONObject("where"), null);
            return db.delete(table, where.clause, where.args);
        }
        throw new IllegalArgumentException(SqliteProtocol.E_UNSUPPORTED + ": exec op " + action);
    }

    public int exec(JSONObject op) throws JSONException {
        SQLiteDatabase db = db();
        db.beginTransaction();
        try {
            int changes = execOne(op);
            db.setTransactionSuccessful();
            return changes;
        } finally {
            db.endTransaction();
        }
    }

    public int tx(JSONArray ops) throws JSONException {
        SQLiteDatabase db = db();
        db.beginTransaction();
        try {
            int changes = 0;
            for (int i = 0; i < ops.length(); i++) changes += execOne(ops.getJSONObject(i));
            db.setTransactionSuccessful();
            return changes;
        } finally {
            db.endTransaction();
        }
    }

    private static final int CONTENT_MAX_ROWS = 500;
    private static final int CONTENT_MAX_ROW_BYTES = 1024 * 1024;
    private static final int CONTENT_MAX_TOTAL_BYTES = 8 * 1024 * 1024;

    private long contentRevision(SQLiteDatabase db) {
        android.database.Cursor cursor = null;
        try {
            cursor = db.rawQuery("SELECT value_json FROM schema_meta WHERE key='content_revision'", null);
            if (cursor.moveToFirst()) {
                String raw = cursor.getString(0);
                return raw == null ? 0 : Long.parseLong(raw.trim());
            }
        } catch (Exception ignored) {
            return 0;
        } finally {
            if (cursor != null) cursor.close();
        }
        return 0;
    }

    private void setContentRevision(SQLiteDatabase db, long revision) {
        ContentValues cv = new ContentValues();
        cv.put("key", "content_revision");
        cv.put("value_json", String.valueOf(revision));
        cv.put("updated_at", System.currentTimeMillis());
        db.insertWithOnConflict("schema_meta", null, cv, SQLiteDatabase.CONFLICT_REPLACE);
    }

    private static String safeContentJson(JSONObject op) throws JSONException {
        String json = op.optString("json", "");
        if (json.getBytes(java.nio.charset.StandardCharsets.UTF_8).length > CONTENT_MAX_ROW_BYTES) {
            throw new IllegalArgumentException(SqliteProtocol.E_TOO_LARGE + ": content row > 1MB");
        }
        return json;
    }

    /** 0.14：按 prefix/kind/revision 列内容 KV；不经过 IDB。 */
    public JSONObject contentList(JSONObject op) throws JSONException {
        SQLiteDatabase db = db();
        String prefix = op.optString("prefix", "");
        String kind = op.optString("kind", "");
        long fromRevision = op.optLong("fromRevision", -1);
        long toRevision = op.optLong("toRevision", -1);
        boolean includeDeleted = op.optBoolean("includeDeleted", false);
        StringBuilder sql = new StringBuilder("SELECT key,kind,json,updated_at,revision,deleted FROM content_kv WHERE 1=1");
        List<String> args = new ArrayList<String>();
        if (!includeDeleted) sql.append(" AND deleted=0");
        if (kind.length() > 0) { sql.append(" AND kind=?"); args.add(kind); }
        if (prefix.length() > 0) {
            sql.append(" AND key>=? AND key<?");
            args.add(prefix);
            args.add(prefix + "\uffff");
        }
        if (fromRevision >= 0) { sql.append(" AND revision>=?"); args.add(String.valueOf(fromRevision)); }
        if (toRevision >= 0) { sql.append(" AND revision<=?"); args.add(String.valueOf(toRevision)); }
        String orderBy = op.optString("orderBy", "revision");
        if (!"key".equals(orderBy) && !"kind".equals(orderBy) && !"updated_at".equals(orderBy)
                && !"revision".equals(orderBy) && !"deleted".equals(orderBy)) {
            throw new IllegalArgumentException(SqliteProtocol.E_BAD_REQUEST + ": unsafe content orderBy " + orderBy);
        }
        sql.append(" ORDER BY ").append(orderBy);
        String direction = op.optString("direction", "asc");
        sql.append("desc".equalsIgnoreCase(direction) ? " DESC" : " ASC");
        int limit = Math.max(1, Math.min(op.optInt("limit", 500), 1000));
        int offset = Math.max(0, Math.min(op.optInt("offset", 0), 10_000_000));
        sql.append(" LIMIT ").append(limit).append(" OFFSET ").append(offset);
        Cursor cursor = db.rawQuery(sql.toString(), args.toArray(new String[0]));
        JSONArray rows = new JSONArray();
        try {
            while (cursor.moveToNext()) rows.put(cursorRow(cursor));
        } finally {
            cursor.close();
        }
        JSONObject out = new JSONObject();
        out.put("rows", rows);
        out.put("count", rows.length());
        out.put("limit", limit);
        out.put("offset", offset);
        out.put("hasMore", rows.length() == limit);
        out.put("revision", contentRevision(db));
        return out;
    }

    /** 批量按 key 读内容（恢复/缓存重建）。 */
    public JSONObject contentGet(JSONObject op) throws JSONException {
        JSONArray keys = op.optJSONArray("keys");
        JSONArray rows = new JSONArray();
        if (keys == null || keys.length() == 0) return new JSONObject().put("rows", rows);
        if (keys.length() > CONTENT_MAX_ROWS) throw new IllegalArgumentException(SqliteProtocol.E_TOO_LARGE + ": too many keys");
        StringBuilder sql = new StringBuilder("SELECT key,kind,json,updated_at,revision,deleted FROM content_kv WHERE key IN (");
        List<String> args = new ArrayList<String>();
        for (int i = 0; i < keys.length(); i++) {
            if (i > 0) sql.append(',');
            sql.append('?');
            args.add(keys.getString(i));
        }
        sql.append(')');
        Cursor cursor = db().rawQuery(sql.toString(), args.toArray(new String[0]));
        try { while (cursor.moveToNext()) rows.put(cursorRow(cursor)); }
        finally { cursor.close(); }
        return new JSONObject().put("rows", rows);
    }

    /** 原子内容写入：校验 expectedRevision → upsert/tombstone → rev+1，单事务。 */
    public JSONObject contentWrite(JSONObject op) throws JSONException {
        JSONArray entries = op.optJSONArray("entries");
        JSONArray deletes = op.optJSONArray("deletes");
        int entryCount = entries == null ? 0 : entries.length();
        int deleteCount = deletes == null ? 0 : deletes.length();
        if (entryCount + deleteCount > CONTENT_MAX_ROWS) {
            throw new IllegalArgumentException(SqliteProtocol.E_TOO_LARGE + ": too many content writes");
        }
        SQLiteDatabase db = db();
        db.beginTransaction();
        try {
            long current = contentRevision(db);
            long expected = op.optLong("expectedRevision", -1);
            if (expected >= 0 && expected != current) {
                throw new IllegalArgumentException(SqliteProtocol.E_CONFLICT + ": content revision " + current + " != " + expected);
            }
            long revision = current + 1;
            long now = System.currentTimeMillis();
            long totalBytes = 0;
            int upserts = 0;
            int tombstones = 0;
            if (entries != null) {
                for (int i = 0; i < entries.length(); i++) {
                    JSONObject entry = entries.getJSONObject(i);
                    String key = entry.optString("key", "");
                    String kind = entry.optString("kind", "");
                    if (key.length() == 0 || key.length() > 256 || kind.length() == 0 || kind.length() > 64) {
                        throw new IllegalArgumentException(SqliteProtocol.E_BAD_REQUEST + ": bad content key/kind");
                    }
                    String json = safeContentJson(entry);
                    totalBytes += json.getBytes(java.nio.charset.StandardCharsets.UTF_8).length;
                    if (totalBytes > CONTENT_MAX_TOTAL_BYTES) {
                        throw new IllegalArgumentException(SqliteProtocol.E_TOO_LARGE + ": content batch > 8MB");
                    }
                    ContentValues cv = new ContentValues();
                    cv.put("key", key);
                    cv.put("kind", kind);
                    cv.put("json", json);
                    cv.put("updated_at", entry.optLong("updated_at", now));
                    cv.put("revision", revision);
                    cv.put("deleted", 0);
                    if (db.insertWithOnConflict("content_kv", null, cv, SQLiteDatabase.CONFLICT_REPLACE) == -1) {
                        throw new SQLiteException("content upsert failed: " + key);
                    }
                    upserts++;
                }
            }
            if (deletes != null) {
                for (int i = 0; i < deletes.length(); i++) {
                    String key = deletes.getString(i);
                    if (key == null || key.length() == 0) continue;
                    ContentValues cv = new ContentValues();
                    cv.put("deleted", 1);
                    cv.put("revision", revision);
                    cv.put("updated_at", now);
                    db.update("content_kv", cv, "key=?", new String[]{key});
                    tombstones++;
                }
            }
            setContentRevision(db, revision);
            db.setTransactionSuccessful();
            JSONObject out = new JSONObject();
            out.put("ok", true);
            out.put("revision", revision);
            out.put("upserts", upserts);
            out.put("tombstones", tombstones);
            out.put("deletes", tombstones);
            return out;
        } finally {
            db.endTransaction();
        }
    }

    /** 内容计数：total/byKind/deleted + 当前 revision。 */
    public JSONObject contentCounts(JSONObject op) throws JSONException {
        SQLiteDatabase db = db();
        JSONObject out = new JSONObject();
        JSONObject byKind = new JSONObject();
        out.put("total", scalarLong(db, "SELECT COUNT(*) FROM content_kv"));
        out.put("deleted", scalarLong(db, "SELECT COUNT(*) FROM content_kv WHERE deleted=1"));
        Cursor cursor = db.rawQuery("SELECT kind,COUNT(*) FROM content_kv GROUP BY kind", null);
        try {
            while (cursor.moveToNext()) byKind.put(cursor.getString(0), cursor.getLong(1));
        } finally {
            cursor.close();
        }
        out.put("byKind", byKind);
        out.put("revision", contentRevision(db));
        return out;
    }

    public JSONObject backup(String name) throws IOException, JSONException {
        String safe = name == null || name.length() == 0 ? "momo-" + System.currentTimeMillis() + ".db" : name;
        if (!safe.matches("[A-Za-z0-9._-]{1,80}")) {
            throw new IllegalArgumentException(SqliteProtocol.E_BAD_REQUEST + ": unsafe backup name");
        }
        // P0：一致性备份。WAL 必须 TRUNCATE 到位后再复制；复制后打开备份校验 integrity+真实 counts；
        // 与 live counts 不一致则重试/删除，绝不登记不一致备份。
        SQLiteDatabase db = db();
        File src = helper.appContext().getDatabasePath(MomoSqliteOpenHelper.DB_NAME);
        File dir = new File(helper.appContext().getFilesDir(), "sqlite-backups");
        if (!dir.exists() && !dir.mkdirs()) throw new IOException("mkdir failed: " + dir);
        File dest = new File(dir, safe);
        File partial = new File(dir, safe + ".partial");
        IOException lastError = null;
        for (int attempt = 0; attempt < 3; attempt++) {
            try {
                walCheckpointTruncate(db);
                JSONObject liveCounts = factCountsOf(db);
                if (partial.exists() && !partial.delete()) throw new IOException("cannot clear partial backup");
                copyFile(src, partial);
                if (partial.length() <= 0) throw new IOException(SqliteProtocol.E_CORRUPT + ": empty backup");
                JSONObject backupCounts = verifyBackupFile(partial);
                if (!sameCounts(liveCounts, backupCounts)) {
                    partial.delete();
                    lastError = new IOException(SqliteProtocol.E_CORRUPT + ": backup counts mismatch live=" + liveCounts + " backup=" + backupCounts);
                    try { Thread.sleep(120L * (attempt + 1)); } catch (InterruptedException ignored) { Thread.currentThread().interrupt(); }
                    continue;
                }
                if (dest.exists() && !dest.delete()) throw new IOException("cannot replace backup: " + safe);
                if (!partial.renameTo(dest)) throw new IOException("cannot finalize backup: " + safe);
                JSONObject out = new JSONObject();
                out.put("name", safe);
                out.put("path", dest.getAbsolutePath());
                out.put("bytes", dest.length());
                out.put("at", System.currentTimeMillis());
                out.put("integrityOk", true);
                out.put("checksum", sha256File(dest));
                out.put("counts", backupCounts);
                return out;
            } catch (IOException error) {
                lastError = error;
                try { if (partial.exists()) partial.delete(); } catch (Exception ignored) {}
                try { Thread.sleep(120L * (attempt + 1)); } catch (InterruptedException ignored) { Thread.currentThread().interrupt(); }
            } catch (android.database.sqlite.SQLiteException error) {
                lastError = new IOException(SqliteProtocol.E_BUSY + ": " + error.getMessage());
                try { if (partial.exists()) partial.delete(); } catch (Exception ignored) {}
            }
        }
        throw lastError != null ? lastError : new IOException(SqliteProtocol.E_CORRUPT + ": cannot create consistent backup");
    }

    private void walCheckpointTruncate(SQLiteDatabase db) throws IOException {
        IOException last = null;
        for (int attempt = 0; attempt < 5; attempt++) {
            Cursor c = null;
            try {
                c = db.rawQuery("PRAGMA wal_checkpoint(TRUNCATE)", null);
                if (!c.moveToFirst()) throw new IOException(SqliteProtocol.E_BUSY + ": wal_checkpoint returned no row");
                long busy = c.getLong(0);
                long log = c.getLong(1);
                long checkpointed = c.getLong(2);
                if (busy == 0 && log == checkpointed) return;
                last = new IOException(SqliteProtocol.E_BUSY + ": wal busy=" + busy + " log=" + log + " checkpointed=" + checkpointed);
            } finally {
                if (c != null) c.close();
            }
            try { Thread.sleep(120L * (attempt + 1)); } catch (InterruptedException ignored) { Thread.currentThread().interrupt(); }
        }
        throw last != null ? last : new IOException(SqliteProtocol.E_BUSY + ": wal_checkpoint failed");
    }

    private JSONObject verifyBackupFile(File partial) throws IOException, JSONException {
        SQLiteDatabase verify = null;
        try {
            verify = SQLiteDatabase.openDatabase(partial.getAbsolutePath(), null, SQLiteDatabase.OPEN_READONLY);
            Cursor c = verify.rawQuery("PRAGMA integrity_check", null);
            boolean ok;
            try { ok = c.moveToFirst() && "ok".equalsIgnoreCase(c.getString(0)); } finally { c.close(); }
            if (!ok) throw new IOException(SqliteProtocol.E_CORRUPT + ": integrity_check failed");
            return factCountsOf(verify);
        } finally {
            if (verify != null) try { verify.close(); } catch (Exception ignored) {}
        }
    }

    private static JSONObject factCountsOf(SQLiteDatabase db) throws JSONException {
        JSONObject counts = new JSONObject();
        counts.put("states", scalarLong(db, "SELECT COUNT(*) FROM states"));
        counts.put("plans", scalarLong(db, "SELECT COUNT(*) FROM plans"));
        counts.put("settings", scalarLong(db, "SELECT COUNT(*) FROM settings"));
        counts.put("reviewLogs", scalarLong(db, "SELECT COUNT(*) FROM review_logs"));
        return counts;
    }

    private static boolean sameCounts(JSONObject a, JSONObject b) {
        return a.optLong("states", -1) == b.optLong("states", -2)
                && a.optLong("plans", -1) == b.optLong("plans", -2)
                && a.optLong("settings", -1) == b.optLong("settings", -2)
                && a.optLong("reviewLogs", -1) == b.optLong("reviewLogs", -2);
    }

    public JSONArray listBackups() throws JSONException {
        File dir = new File(helper.appContext().getFilesDir(), "sqlite-backups");
        JSONArray out = new JSONArray();
        File[] files = dir.listFiles();
        if (files == null) return out;
        java.util.Arrays.sort(files, new java.util.Comparator<File>() {
            @Override public int compare(File a, File b) { return Long.compare(b.lastModified(), a.lastModified()); }
        });
        for (File file : files) {
            String name = file.getName();
            if (!file.isFile() || file.length() <= 0) continue;
            boolean isBackup = name.startsWith("sqlite-backup-")
                    || name.startsWith("sqlite-auto-backup-")
                    || name.startsWith("sqlite-safety-");
            if (!isBackup || !name.endsWith(".db")) continue;
            JSONObject row = new JSONObject();
            row.put("name", name);
            row.put("path", file.getAbsolutePath());
            row.put("size", file.length());
            row.put("mtime", file.lastModified());
            row.put("manifest", new File(dir, name + ".json").isFile());
            out.put(row);
        }
        return out;
    }

    public JSONObject deleteBackup(String name) throws IOException, JSONException {
        if (name == null || !name.matches("[A-Za-z0-9._-]{1,100}")) throw new IOException("unsafe backup name");
        File dir = new File(helper.appContext().getFilesDir(), "sqlite-backups").getCanonicalFile();
        File target = new File(dir, name).getCanonicalFile();
        if (!target.getParentFile().equals(dir)) throw new IOException("backup outside dir");
        boolean deleted = !target.exists() || target.delete();
        File sidecar = new File(dir, name + ".json");
        if (sidecar.exists()) sidecar.delete();
        JSONObject out = new JSONObject();
        out.put("ok", deleted);
        out.put("name", name);
        return out;
    }

    /** M5/D：原子写 SQLite 备份的 .json manifest sidecar（同目录，失败不覆盖旧文件）。 */
    public JSONObject writeBackupManifest(String name, String json) throws IOException, JSONException {
        if (name == null || !name.matches("[A-Za-z0-9._-]{1,100}") || !name.endsWith(".db")) {
            throw new IllegalArgumentException(SqliteProtocol.E_BAD_REQUEST + ": unsafe backup name");
        }
        if (json == null || json.length() == 0) throw new IOException(SqliteProtocol.E_BAD_REQUEST + ": empty manifest");
        if (json.getBytes("UTF-8").length > 64 * 1024) throw new IOException(SqliteProtocol.E_TOO_LARGE + ": manifest too large");
        File dir = new File(helper.appContext().getFilesDir(), "sqlite-backups");
        if (!dir.exists() && !dir.mkdirs()) throw new IOException("mkdir failed");
        File target = new File(dir, name + ".json");
        File partial = new File(dir, name + ".json.partial");
        if (partial.exists()) partial.delete();
        OutputStream out = null;
        try {
            out = new FileOutputStream(partial);
            out.write(json.getBytes("UTF-8"));
            out.flush();
        } catch (IOException e) {
            partial.delete();
            throw e;
        } finally {
            if (out != null) try { out.close(); } catch (IOException ignored) {}
        }
        if (!partial.renameTo(target)) {
            partial.delete();
            throw new IOException("cannot finalize manifest");
        }
        JSONObject result = new JSONObject();
        result.put("ok", true);
        result.put("name", name);
        result.put("bytes", target.length());
        return result;
    }

    public JSONObject readBackupManifest(String name) throws IOException, JSONException {
        if (name == null || !name.matches("[A-Za-z0-9._-]{1,100}") || !name.endsWith(".db")) {
            throw new IllegalArgumentException(SqliteProtocol.E_BAD_REQUEST + ": unsafe backup name");
        }
        File file = new File(new File(helper.appContext().getFilesDir(), "sqlite-backups"), name + ".json");
        JSONObject result = new JSONObject();
        if (!file.isFile() || file.length() <= 0) {
            result.put("manifest", JSONObject.NULL);
            return result;
        }
        result.put("manifest", new String(readAllBytes(file), "UTF-8"));
        return result;
    }

    private static byte[] readAllBytes(File file) throws IOException {
        InputStream in = new FileInputStream(file);
        try {
            java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
            byte[] buffer = new byte[8192];
            int n;
            while ((n = in.read(buffer)) > 0) out.write(buffer, 0, n);
            return out.toByteArray();
        } finally {
            try { in.close(); } catch (IOException ignored) {}
        }
    }

    public JSONObject restoreDb(String path) throws IOException, JSONException {
        File source = new File(path == null ? "" : path).getCanonicalFile();
        File dir = new File(helper.appContext().getFilesDir(), "sqlite-backups").getCanonicalFile();
        if (!source.isFile() || source.length() <= 0) throw new IOException("restore source missing/empty");
        if (source.getName().endsWith(".partial") || source.getName().endsWith(".tmp")) throw new IOException("restore source is partial");
        if (source.getParentFile() == null || !source.getParentFile().equals(dir)) throw new IOException("restore source outside sqlite-backups");
        // 先校验来源 .db：integrity/userVersion；失败不碰当前库。
        SQLiteDatabase verify = null;
        long sourceVersion;
        try {
            verify = SQLiteDatabase.openDatabase(source.getAbsolutePath(), null, SQLiteDatabase.OPEN_READONLY);
            Cursor c = verify.rawQuery("PRAGMA integrity_check", null);
            boolean ok;
            try { ok = c.moveToFirst() && "ok".equalsIgnoreCase(c.getString(0)); } finally { c.close(); }
            if (!ok) throw new IOException(SqliteProtocol.E_CORRUPT + ": source integrity failed");
            Cursor v = verify.rawQuery("PRAGMA user_version", null);
            try { sourceVersion = v.moveToFirst() ? v.getLong(0) : 0; } finally { v.close(); }
        } finally {
            if (verify != null) try { verify.close(); } catch (Exception ignored) {}
        }
        if (sourceVersion != MomoSqliteOpenHelper.DB_VERSION) throw new IOException("source userVersion " + sourceVersion + " != " + MomoSqliteOpenHelper.DB_VERSION);
        File current = helper.appContext().getDatabasePath(MomoSqliteOpenHelper.DB_NAME);
        File old = new File(current.getParentFile(), MomoSqliteOpenHelper.DB_NAME + ".pre-restore-" + System.currentTimeMillis());
        // 关闭连接池并 checkpoint，再备份旧库。
        try { helper.close(); } catch (Exception ignored) {}
        if (current.exists()) copyFile(current, old);
        File targetPartial = new File(current.getParentFile(), MomoSqliteOpenHelper.DB_NAME + ".restore.partial");
        if (targetPartial.exists()) targetPartial.delete();
        try {
            copyFile(source, targetPartial);
            if (current.exists() && !current.delete()) throw new IOException("cannot replace current db");
            new File(current.getPath() + "-wal").delete();
            new File(current.getPath() + "-shm").delete();
            if (!targetPartial.renameTo(current)) throw new IOException("cannot finalize restore");
            SQLiteDatabase reopened = helper.getWritableDatabase();
            Cursor c = reopened.rawQuery("PRAGMA integrity_check", null);
            boolean ok;
            try { ok = c.moveToFirst() && "ok".equalsIgnoreCase(c.getString(0)); } finally { c.close(); }
            if (!ok) throw new IOException(SqliteProtocol.E_CORRUPT + ": restored integrity failed");
            JSONObject out = health();
            out.put("ok", true);
            out.put("restoredFrom", source.getName());
            out.put("sourceChecksum", sha256File(source));
            return out;
        } catch (Exception error) {
            // 回滚旧库，避免半替换。
            try {
                if (old.exists()) {
                    if (current.exists()) current.delete();
                    copyFile(old, current);
                }
                new File(current.getPath() + "-wal").delete();
                new File(current.getPath() + "-shm").delete();
                helper.getWritableDatabase();
            } catch (Exception ignored) {}
            if (error instanceof IOException) throw (IOException) error;
            throw new IOException("restore failed: " + error.getMessage());
        }
    }

    /** M1 自检：主库临时表写/读/事务回滚/清理，不碰用户 facts。 */
    public JSONObject selfTest() throws JSONException {
        SQLiteDatabase db = db();
        JSONObject checks = new JSONObject();
        JSONObject beforeCounts = userTableCounts(db);
        boolean tableCreated = false;
        try {
            // 用主库普通表（不要 TEMP：Android 连接池下 TEMP 表只存在于单连接，rawQuery 可能换连接）。
            db.execSQL("DROP TABLE IF EXISTS __m1_self_test");
            db.execSQL("CREATE TABLE __m1_self_test(id INTEGER PRIMARY KEY, v TEXT)");
            tableCreated = true;
            db.execSQL("INSERT INTO __m1_self_test(id,v) VALUES(1,'x')");
            long one = scalarLong(db, "SELECT COUNT(*) FROM __m1_self_test");
            checks.put("insertRead", one == 1);

            db.beginTransaction();
            try {
                long writeSync = scalarLong(db, "PRAGMA synchronous");
                checks.put("writeSynchronous", syncLabel(writeSync));
                checks.put("writeSynchronousValue", writeSync);
                db.execSQL("INSERT INTO __m1_self_test(id,v) VALUES(2,'y')");
                long two = scalarLong(db, "SELECT COUNT(*) FROM __m1_self_test");
                checks.put("transactionSawInsert", two == 2);
            } finally {
                db.endTransaction(); // rollback
            }
            long afterRollback = scalarLong(db, "SELECT COUNT(*) FROM __m1_self_test");
            checks.put("transactionRollback", afterRollback == 1);
        } finally {
            if (tableCreated) {
                try { db.execSQL("DROP TABLE IF EXISTS __m1_self_test"); } catch (Exception ignored) {}
            }
        }
        long leftovers = scalarLong(db,
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='__m1_self_test'");
        checks.put("tempTableDropped", leftovers == 0);
        // 0.14：content_kv 事务回滚 + expectedRevision 冲突（不写用户内容）。
        try {
            long contentRev = contentRevision(db);
            JSONObject stale = new JSONObject();
            stale.put("expectedRevision", contentRev + 1000);
            stale.put("entries", new JSONArray());
            boolean conflict = false;
            try { contentWrite(stale); } catch (IllegalArgumentException expected) {
                conflict = String.valueOf(expected.getMessage()).startsWith(SqliteProtocol.E_CONFLICT);
            }
            checks.put("contentRevisionConflict", conflict);
            db.beginTransaction();
            try {
                ContentValues cv = new ContentValues();
                cv.put("key", "__content_self_test__");
                cv.put("kind", "test");
                cv.put("json", "{}");
                cv.put("updated_at", System.currentTimeMillis());
                cv.put("revision", contentRev + 1);
                cv.put("deleted", 0);
                db.insertWithOnConflict("content_kv", null, cv, SQLiteDatabase.CONFLICT_REPLACE);
            } finally {
                db.endTransaction();
            }
            boolean absent = scalarLong(db, "SELECT COUNT(*) FROM content_kv WHERE key='__content_self_test__'") == 0;
            checks.put("contentTransactionRollback", absent && contentRevision(db) == contentRev);
        } catch (Exception error) {
            checks.put("contentRevisionConflict", false);
            checks.put("contentTransactionRollback", false);
        }
        JSONObject afterCounts = userTableCounts(db);
        checks.put("userTablesUntouched", beforeCounts.toString().equals(afterCounts.toString()));
        checks.put("beforeCounts", beforeCounts);
        checks.put("afterCounts", afterCounts);
        checks.put("userVersion", scalarLong(db, "PRAGMA user_version"));
        checks.put("journalMode", scalarString(db, "PRAGMA journal_mode"));
        long sync = checks.optLong("writeSynchronousValue", scalarLong(db, "PRAGMA synchronous"));
        checks.put("synchronousValue", sync);
        checks.put("synchronous", syncLabel(sync));
        JSONObject out = new JSONObject();
        out.put("ok", checks.optBoolean("insertRead")
                && checks.optBoolean("transactionSawInsert")
                && checks.optBoolean("transactionRollback")
                && checks.optBoolean("tempTableDropped")
                && checks.optBoolean("contentRevisionConflict")
                && checks.optBoolean("contentTransactionRollback")
                && checks.optBoolean("userTablesUntouched")
                && "FULL".equals(checks.optString("writeSynchronous")));
        out.put("checks", checks);
        return out;
    }

    public long userVersion() {
        return scalarLong(db(), "PRAGMA user_version");
    }

    public long getDataEpoch(SQLiteDatabase db) {
        try {
            Cursor c = db.rawQuery("SELECT value_json FROM schema_meta WHERE key='data_epoch'", null);
            try {
                if (c.moveToFirst()) return Long.parseLong(c.getString(0));
            } finally {
                c.close();
            }
        } catch (Exception ignored) {}
        return 0;
    }

    private static String columnsClause(JSONObject columns) throws JSONException {
        if (columns == null || columns.length() == 0) return "*";
        StringBuilder sb = new StringBuilder();
        Iterator<String> it = columns.keys();
        boolean first = true;
        while (it.hasNext()) {
            String key = it.next();
            if (!columns.optBoolean(key, false)) continue;
            if (!SqliteProtocol.isSafeIdent(key)) throw new IllegalArgumentException(SqliteProtocol.E_BAD_REQUEST + ": unsafe column " + key);
            if (!first) sb.append(", ");
            sb.append(key);
            first = false;
        }
        return first ? "*" : sb.toString();
    }

    private static Where buildWhere(JSONObject where, List<String> args) throws JSONException {
        List<String> out = args == null ? new ArrayList<String>() : args;
        StringBuilder sb = new StringBuilder();
        Iterator<String> it = where.keys();
        boolean first = true;
        while (it.hasNext()) {
            String key = it.next();
            if (!SqliteProtocol.isSafeIdent(key)) throw new IllegalArgumentException(SqliteProtocol.E_BAD_REQUEST + ": unsafe where column " + key);
            if (!first) sb.append(" AND ");
            sb.append(key).append(" = ?");
            Object value = where.get(key);
            out.add(String.valueOf(value));
            first = false;
        }
        return new Where(sb.length() == 0 ? null : sb.toString(), out.toArray(new String[0]));
    }

    private static void appendWhere(StringBuilder sql, List<String> args, JSONObject where) throws JSONException {
        if (where == null || where.length() == 0) return;
        Where w = buildWhere(where, args);
        sql.append(" WHERE ").append(w.clause);
    }

    private static ContentValues toValues(JSONObject row) throws JSONException {
        ContentValues cv = new ContentValues();
        Iterator<String> it = row.keys();
        while (it.hasNext()) {
            String key = it.next();
            if (!SqliteProtocol.isSafeIdent(key)) throw new IllegalArgumentException(SqliteProtocol.E_BAD_REQUEST + ": unsafe column " + key);
            Object value = row.get(key);
            if (value == JSONObject.NULL) cv.putNull(key);
            else if (value instanceof Boolean) cv.put(key, ((Boolean) value) ? 1 : 0);
            else if (value instanceof Integer) cv.put(key, (Integer) value);
            else if (value instanceof Long) cv.put(key, (Long) value);
            else if (value instanceof Double) cv.put(key, (Double) value);
            else if (value instanceof Number) cv.put(key, ((Number) value).doubleValue());
            else cv.put(key, String.valueOf(value));
        }
        return cv;
    }

    private static long writeConnectionSynchronous(SQLiteDatabase db) throws JSONException {
        db.beginTransaction();
        try {
            return scalarLong(db, "PRAGMA synchronous");
        } finally {
            db.endTransaction();
        }
    }

    private static JSONObject userTableCounts(SQLiteDatabase db) throws JSONException {
        JSONObject counts = new JSONObject();
        for (String table : SqliteProtocol.TABLES) {
            if ("migration_state".equals(table)) continue;
            counts.put(table, scalarLong(db, "SELECT COUNT(*) FROM " + table));
        }
        return counts;
    }

    private static String typeName(int type) {
        switch (type) {
            case Cursor.FIELD_TYPE_INTEGER: return "INTEGER";
            case Cursor.FIELD_TYPE_FLOAT: return "REAL";
            case Cursor.FIELD_TYPE_BLOB: return "BLOB";
            case Cursor.FIELD_TYPE_NULL: return "NULL";
            default: return "TEXT";
        }
    }

    private static String syncLabel(long value) {
        // SQLite: 0=OFF, 1=NORMAL, 2=FULL, 3=EXTRA
        if (value == 3) return "EXTRA";
        if (value == 2) return "FULL";
        if (value == 1) return "NORMAL";
        if (value == 0) return "OFF";
        return String.valueOf(value);
    }

    private static boolean quickIntegrityOk(SQLiteDatabase db) {
        Cursor c = null;
        try {
            c = db.rawQuery("PRAGMA quick_check", null);
            return c.moveToFirst() && "ok".equalsIgnoreCase(c.getString(0));
        } catch (Exception ignored) {
            return false;
        } finally {
            if (c != null) c.close();
        }
    }

    private static JSONObject cursorRow(Cursor cursor) throws JSONException {
        JSONObject row = new JSONObject();
        int count = cursor.getColumnCount();
        for (int i = 0; i < count; i++) {
            String name = cursor.getColumnName(i);
            switch (cursor.getType(i)) {
                case Cursor.FIELD_TYPE_NULL:
                    row.put(name, JSONObject.NULL);
                    break;
                case Cursor.FIELD_TYPE_INTEGER:
                    row.put(name, cursor.getLong(i));
                    break;
                case Cursor.FIELD_TYPE_FLOAT:
                    row.put(name, cursor.getDouble(i));
                    break;
                default:
                    row.put(name, cursor.getString(i));
            }
        }
        return row;
    }

    private static long scalarLong(SQLiteDatabase db, String sql) {
        Cursor c = db.rawQuery(sql, null);
        try {
            return c.moveToFirst() ? c.getLong(0) : 0;
        } finally {
            c.close();
        }
    }

    private static String scalarString(SQLiteDatabase db, String sql) {
        Cursor c = db.rawQuery(sql, null);
        try {
            return c.moveToFirst() ? c.getString(0) : "";
        } finally {
            c.close();
        }
    }

    private static String sha256File(File file) throws IOException {
        InputStream in = new FileInputStream(file);
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] buffer = new byte[64 * 1024];
            int n;
            while ((n = in.read(buffer)) > 0) digest.update(buffer, 0, n);
            byte[] hash = digest.digest();
            StringBuilder sb = new StringBuilder(hash.length * 2);
            for (byte b : hash) sb.append(String.format("%02x", b & 0xff));
            return sb.toString();
        } catch (java.security.NoSuchAlgorithmException e) {
            throw new IOException("SHA-256 unavailable");
        } finally {
            try { in.close(); } catch (IOException ignored) {}
        }
    }

    private static void copyFile(File src, File dest) throws IOException {
        if (!src.exists()) throw new IOException("db not found: " + src);
        InputStream in = new FileInputStream(src);
        OutputStream out = new FileOutputStream(dest);
        try {
            byte[] buffer = new byte[64 * 1024];
            int n;
            while ((n = in.read(buffer)) > 0) out.write(buffer, 0, n);
            out.flush();
        } finally {
            try { in.close(); } catch (IOException ignored) {}
            try { out.close(); } catch (IOException ignored) {}
        }
    }

    private static final class Where {
        final String clause;
        final String[] args;
        Where(String clause, String[] args) {
            this.clause = clause;
            this.args = args;
        }
    }
}
