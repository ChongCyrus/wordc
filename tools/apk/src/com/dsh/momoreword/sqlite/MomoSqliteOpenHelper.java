package com.wordc.app.sqlite;

import android.content.Context;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteException;
import android.database.sqlite.SQLiteOpenHelper;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;

/**
 * 0.11.0 M1：原生 SQLite 主库（framework SQLiteOpenHelper，不用 Room）。
 *
 * 约定：
 * - momo.db，WAL=ON，synchronous=FULL，foreign_keys=ON，busy_timeout=5000；
 * - user_version 管 schema；onDowngrade 不删库，抛 E_DOWNGRADE，由 JS/UI 进只读恢复页；
 * - M1 只建 facts 表；words/decks/packs 仍在 IndexedDB 可重建缓存。
 */
public class MomoSqliteOpenHelper extends SQLiteOpenHelper {
    public static final String DB_NAME = "momo.db";
    public static final int DB_VERSION = 3;
    public static final String E_DOWNGRADE = "E_DOWNGRADE";

    private final Context context;
    private final boolean preflightBackupOk;

    public MomoSqliteOpenHelper(Context context) {
        super(context, DB_NAME, null, DB_VERSION);
        this.context = context.getApplicationContext();
        // API 16+：由 SQLiteOpenHelper 统一开启 WAL，避免在 execSQL 里跑 PRAGMA。
        setWriteAheadLoggingEnabled(true);
        // 关键：在 open/onUpgrade 之前复制旧 DB（含 -wal/-shm），不要在 onUpgrade 事务内 checkpoint/长 IO。
        this.preflightBackupOk = preflightBackupBeforeUpgrade(this.context);
    }

    @Override
    public void onConfigure(SQLiteDatabase db) {
        super.onConfigure(db);
        db.setForeignKeyConstraintsEnabled(true);
        // 升级事务开始前设 busy_timeout，SQLITE_LOCKED 时有限等待而不是立刻冒泡。
        pragma(db, "PRAGMA busy_timeout=5000");
    }

    @Override
    public void onOpen(SQLiteDatabase db) {
        super.onOpen(db);
        // 关键：PRAGMA 有返回结果，必须 rawQuery；execSQL 会抛
        // "Queries can be performed using SQLiteDatabase query or rawQuery methods only"。
        pragma(db, "PRAGMA synchronous=FULL");
        pragma(db, "PRAGMA busy_timeout=5000");
    }

    private static void pragma(SQLiteDatabase db, String sql) {
        android.database.Cursor cursor = null;
        try {
            cursor = db.rawQuery(sql, null);
            if (cursor != null) cursor.moveToFirst();
        } finally {
            if (cursor != null) cursor.close();
        }
    }

    @Override
    public void onCreate(SQLiteDatabase db) {
        db.execSQL("CREATE TABLE IF NOT EXISTS states ("
                + "word_id TEXT PRIMARY KEY,"
                + "deck_id TEXT NOT NULL,"
                + "phase TEXT,"
                + "stability REAL,"
                + "difficulty REAL,"
                + "reps INTEGER,"
                + "lapses INTEGER,"
                + "first_seen_at INTEGER,"
                + "last_reviewed_at INTEGER,"
                + "due_at INTEGER,"
                + "next_interval_days INTEGER,"
                + "retrievability REAL,"
                + "last_rating TEXT,"
                + "same_day_count INTEGER,"
                + "same_day_requeued INTEGER,"
                + "same_day_date TEXT,"
                + "today_progress REAL,"
                + "today_progress_level INTEGER,"
                + "can_finish_today INTEGER,"
                + "meaning_stats_json TEXT,"
                + "core_sense_stats_json TEXT,"
                + "part_stats_json TEXT,"
                + "imported_from TEXT,"
                + "imported_at INTEGER,"
                + "created_at INTEGER,"
                + "updated_at INTEGER"
                + ")");
        db.execSQL("CREATE INDEX IF NOT EXISTS idx_states_deck ON states(deck_id)");
        db.execSQL("CREATE INDEX IF NOT EXISTS idx_states_due ON states(due_at)");
        db.execSQL("CREATE INDEX IF NOT EXISTS idx_states_phase_due ON states(phase,due_at)");

        db.execSQL("CREATE TABLE IF NOT EXISTS plans ("
                + "id TEXT PRIMARY KEY,"
                + "date TEXT NOT NULL,"
                + "deck_id TEXT,"
                + "word_ids_json TEXT,"
                + "idx INTEGER,"
                + "sources_json TEXT,"
                + "goals_json TEXT,"
                + "ratings_json TEXT,"
                + "wc_counts_json TEXT,"
                + "completed_at INTEGER,"
                + "created_at INTEGER,"
                + "updated_at INTEGER"
                + ")");
        db.execSQL("CREATE INDEX IF NOT EXISTS idx_plans_deck_date ON plans(deck_id,date)");

        db.execSQL("CREATE TABLE IF NOT EXISTS settings ("
                + "key TEXT PRIMARY KEY,"
                + "value_json TEXT,"
                + "updated_at INTEGER"
                + ")");

        db.execSQL("CREATE TABLE IF NOT EXISTS review_logs ("
                + "id INTEGER PRIMARY KEY AUTOINCREMENT,"
                + "word_id TEXT NOT NULL,"
                + "deck_id TEXT,"
                + "rating TEXT,"
                + "reviewed_at INTEGER,"
                + "stability_before REAL,"
                + "stability_after REAL,"
                + "difficulty_before REAL,"
                + "difficulty_after REAL,"
                + "elapsed_days INTEGER,"
                + "next_interval_days INTEGER,"
                + "retrievability_at_review REAL,"
                + "long_term_update INTEGER,"
                + "corrected INTEGER,"
                + "corrected_by INTEGER,"
                + "state_before_json TEXT,"
                + "meaning_changes_json TEXT,"
                + "phase_before TEXT,"
                + "phase_after TEXT,"
                + "client_op_id TEXT"
                + ")");
        db.execSQL("CREATE INDEX IF NOT EXISTS idx_logs_word ON review_logs(word_id)");
        db.execSQL("CREATE INDEX IF NOT EXISTS idx_logs_deck_time ON review_logs(deck_id,reviewed_at)");
        db.execSQL("CREATE UNIQUE INDEX IF NOT EXISTS idx_logs_client_op ON review_logs(client_op_id)");
        db.execSQL("CREATE TABLE IF NOT EXISTS client_ops ("
                + "op_id TEXT PRIMARY KEY,"
                + "kind TEXT NOT NULL,"
                + "at INTEGER NOT NULL,"
                + "result_json TEXT"
                + ")");

        db.execSQL("CREATE TABLE IF NOT EXISTS diag ("
                + "id INTEGER PRIMARY KEY AUTOINCREMENT,"
                + "kind TEXT,"
                + "at INTEGER,"
                + "reason TEXT,"
                + "deck_id TEXT,"
                + "payload_json TEXT,"
                + "error TEXT"
                + ")");
        db.execSQL("CREATE INDEX IF NOT EXISTS idx_diag_time ON diag(at)");

        db.execSQL("CREATE TABLE IF NOT EXISTS schema_meta ("
                + "key TEXT PRIMARY KEY,"
                + "value_json TEXT,"
                + "updated_at INTEGER"
                + ")");
        db.execSQL("CREATE TABLE IF NOT EXISTS migration_state ("
                + "step TEXT PRIMARY KEY,"
                + "status TEXT,"
                + "started_at INTEGER,"
                + "finished_at INTEGER,"
                + "error TEXT"
                + ")");
        db.execSQL("CREATE TABLE IF NOT EXISTS content_kv ("
                + "key TEXT PRIMARY KEY,"
                + "kind TEXT NOT NULL,"
                + "json TEXT NOT NULL,"
                + "updated_at INTEGER NOT NULL,"
                + "revision INTEGER NOT NULL,"
                + "deleted INTEGER NOT NULL DEFAULT 0"
                + ")");
        db.execSQL("CREATE INDEX IF NOT EXISTS idx_content_kv_kind_rev ON content_kv(kind,revision)");
        db.execSQL("CREATE INDEX IF NOT EXISTS idx_content_kv_rev ON content_kv(revision)");
        db.execSQL("CREATE INDEX IF NOT EXISTS idx_content_kv_updated ON content_kv(updated_at)");
        db.execSQL("INSERT OR IGNORE INTO schema_meta(key,value_json,updated_at) VALUES('data_epoch','0'," + System.currentTimeMillis() + ")");
        db.execSQL("INSERT OR IGNORE INTO schema_meta(key,value_json,updated_at) VALUES('content_revision','0'," + System.currentTimeMillis() + ")");
    }

    @Override
    public void onUpgrade(SQLiteDatabase db, int oldVersion, int newVersion) {
        // M4b-0：v1 → v2。禁止 drop；先备份 v1 DB（WAL checkpoint 后复制），失败则抛错不 ALTER。
        if (oldVersion < 2 && newVersion >= 2) {
            if (!preflightBackupOk) {
                throw new SQLiteException("E_UPGRADE_BACKUP: v1 preflight backup missing/failed, refuse ALTER");
            }
            // 幂等：上次可能只完成了一半（列在但索引/表缺），不能直接 return。
            boolean hasColumn = columnExists(db, "review_logs", "client_op_id");
            if (!hasColumn) {
                db.execSQL("ALTER TABLE review_logs ADD COLUMN client_op_id TEXT");
            }
            db.execSQL("CREATE UNIQUE INDEX IF NOT EXISTS idx_logs_client_op ON review_logs(client_op_id)");
            db.execSQL("CREATE TABLE IF NOT EXISTS client_ops ("
                    + "op_id TEXT PRIMARY KEY,"
                    + "kind TEXT NOT NULL,"
                    + "at INTEGER NOT NULL,"
                    + "result_json TEXT"
                    + ")");
        }
        // 0.14：v2 -> v3，新增内容 KV 表（只建表/索引，不删旧表）。
        if (oldVersion < 3 && newVersion >= 3) {
            if (!preflightBackupOk) {
                throw new SQLiteException("E_UPGRADE_BACKUP: v3 preflight backup missing/failed, refuse ALTER");
            }
            db.execSQL("CREATE TABLE IF NOT EXISTS content_kv ("
                    + "key TEXT PRIMARY KEY,"
                    + "kind TEXT NOT NULL,"
                    + "json TEXT NOT NULL,"
                    + "updated_at INTEGER NOT NULL,"
                    + "revision INTEGER NOT NULL,"
                    + "deleted INTEGER NOT NULL DEFAULT 0"
                    + ")");
            db.execSQL("CREATE INDEX IF NOT EXISTS idx_content_kv_kind_rev ON content_kv(kind,revision)");
            db.execSQL("CREATE INDEX IF NOT EXISTS idx_content_kv_rev ON content_kv(revision)");
            db.execSQL("CREATE INDEX IF NOT EXISTS idx_content_kv_updated ON content_kv(updated_at)");
            db.execSQL("INSERT OR IGNORE INTO schema_meta(key,value_json,updated_at) VALUES('content_revision','0'," + System.currentTimeMillis() + ")");
        }
    }

    private static boolean columnExists(SQLiteDatabase db, String table, String column) {
        android.database.Cursor cursor = null;
        try {
            cursor = db.rawQuery("PRAGMA table_info(" + table + ")", null);
            int nameIndex = cursor.getColumnIndexOrThrow("name");
            while (cursor.moveToNext()) {
                if (column.equals(cursor.getString(nameIndex))) return true;
            }
            return false;
        } finally {
            if (cursor != null) cursor.close();
        }
    }

    /**
     * open 前 preflight：若 DB 仍是 v1，复制 db + -wal/-shm 到内部备份目录。
     * 不做 SQLite 查询/checkpoint，避免 onUpgrade 事务内 checkpoint 造成 SQLITE_LOCKED。
     * 返回 false 时 onUpgrade 拒绝 ALTER，保持旧版本。
     */
    private static boolean preflightBackupBeforeUpgrade(Context context) {
        File source = context.getDatabasePath(DB_NAME);
        if (source == null || !source.exists()) return true; // 新装/无库，无需备份
        if (readUserVersion(source) >= DB_VERSION) return true; // 已当前版本，无需备份
        File dir = new File(context.getFilesDir(), "sqlite-backups");
        File targetDir = new File(dir, "pre-v3-" + System.currentTimeMillis());
        if (!targetDir.exists() && !targetDir.mkdirs()) return false;
        try {
            copyIfExists(source, new File(targetDir, source.getName()));
            copyIfExists(new File(source.getPath() + "-wal"), new File(targetDir, source.getName() + "-wal"));
            copyIfExists(new File(source.getPath() + "-shm"), new File(targetDir, source.getName() + "-shm"));
            return true;
        } catch (IOException e) {
            return false;
        }
    }

    private static void copyIfExists(File source, File target) throws IOException {
        if (!source.exists()) return;
        InputStream in = new FileInputStream(source);
        OutputStream out = new FileOutputStream(target);
        try {
            byte[] buffer = new byte[8192];
            int read;
            while ((read = in.read(buffer)) > 0) out.write(buffer, 0, read);
            out.flush();
        } finally {
            try { in.close(); } catch (IOException ignored) {}
            try { out.close(); } catch (IOException ignored) {}
        }
    }

    /** 读 SQLite header offset 60 的 user_version（大端 32 位）；失败返回 -1。 */
    private static int readUserVersion(File dbFile) {
        InputStream in = null;
        try {
            in = new FileInputStream(dbFile);
            byte[] header = new byte[64];
            int read = in.read(header);
            if (read < 64) return -1;
            return ((header[60] & 0xff) << 24)
                    | ((header[61] & 0xff) << 16)
                    | ((header[62] & 0xff) << 8)
                    | (header[63] & 0xff);
        } catch (IOException e) {
            return -1;
        } finally {
            if (in != null) try { in.close(); } catch (IOException ignored) {}
        }
    }

    @Override
    public void onDowngrade(SQLiteDatabase db, int oldVersion, int newVersion) {
        // 关键：绝不删库。旧版 App 打开新版库必须失败并进只读恢复页。
        throw new SQLiteException(E_DOWNGRADE + ": user_version " + oldVersion + " > app " + newVersion);
    }

    public Context appContext() {
        return context;
    }
}
