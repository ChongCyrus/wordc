package com.wordc.app.sqlite;

import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

/** M1：单线程串行执行 SQLite 事务；支持按 requestId 取消。 */
public class SqliteTaskExecutor {
    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private final ConcurrentHashMap<String, Future<?>> futures = new ConcurrentHashMap<String, Future<?>>();

    public void submit(final String requestId, final Runnable task) {
        Future<?> future = executor.submit(new Runnable() {
            @Override public void run() {
                try {
                    task.run();
                } finally {
                    futures.remove(requestId);
                }
            }
        });
        futures.put(requestId, future);
    }

    public boolean cancel(String requestId) {
        Future<?> future = futures.remove(requestId);
        if (future == null) return false;
        return future.cancel(true);
    }

    public void shutdown() {
        for (Future<?> future : futures.values()) future.cancel(true);
        futures.clear();
        executor.shutdownNow();
        try {
            executor.awaitTermination(2, TimeUnit.SECONDS);
        } catch (InterruptedException ignored) {
            Thread.currentThread().interrupt();
        }
    }
}
