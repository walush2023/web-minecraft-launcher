package webmc.jdk;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.AbstractExecutorService;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.ForkJoinPool;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.locks.LockSupport;

/**
 * Stands in for the ForkJoinPool behind Minecraft's background executor (Util.makeExecutor;
 * webmc.GamePatches swaps the constructor call for {@link #create}). In the browser JVM the
 * fork/join pool's VarHandle-based queues are slow, and stealing a task from another queue can
 * take a method handle path that the JVM cannot run (26.x then stops while preparing a new
 * world). This pool is a plain queue with {@code parallelism} workers. Like a fork/join pool
 * that compensates for blocked workers, it starts an extra worker when tasks have waited while
 * every worker was blocked (a task waiting for another task in the same pool would otherwise
 * never finish); extra workers stop when the queue is empty.
 */
public final class WorkerPool extends AbstractExecutorService {
    private static final long STALL_NANOS = 200_000_000L;
    private static final int MAX_EXTRA = 8;

    private final ArrayDeque<Runnable> queue = new ArrayDeque<Runnable>();
    private final String prefix;
    private final Thread.UncaughtExceptionHandler handler;
    private final int parallelism;
    private final List<Thread> threads = new ArrayList<Thread>();
    private int workers;
    private int idle;
    private int extra;
    private int counter;
    private long lastProgress = System.nanoTime();
    private boolean shutdown;
    private Thread watchdog;

    private WorkerPool(int parallelism, String prefix, Thread.UncaughtExceptionHandler handler) {
        this.parallelism = Math.max(1, parallelism);
        this.prefix = prefix;
        this.handler = handler;
    }

    /** Same arguments as the ForkJoinPool constructor it replaces. */
    public static ExecutorService create(int parallelism, ForkJoinPool.ForkJoinWorkerThreadFactory factory,
            Thread.UncaughtExceptionHandler handler, boolean asyncMode) {
        String prefix = "Worker-";
        try {
            // The game's factory names its threads ("Worker-Main-1"); ask it for one name.
            Thread sample = factory.newThread(ForkJoinPool.commonPool());
            String name = sample.getName();
            int dash = name.lastIndexOf('-');
            if (dash > 0) {
                prefix = name.substring(0, dash + 1);
            }
        } catch (Throwable ignored) {
            // keep the generic name
        }
        return new WorkerPool(parallelism, prefix, handler);
    }

    @Override
    public void execute(Runnable task) {
        if (task == null) {
            throw new NullPointerException();
        }
        synchronized (this) {
            if (shutdown) {
                throw new RejectedExecutionException("pool shut down");
            }
            queue.addLast(task);
            if (idle > 0) {
                notify();
            } else if (workers < parallelism) {
                startWorker(false);
            } else if (watchdog == null) {
                startWatchdog();
            }
        }
    }

    private void startWorker(boolean temporary) {
        workers++;
        if (temporary) {
            extra++;
        }
        Thread t = new Thread(() -> work(temporary), prefix + (++counter));
        t.setDaemon(true);
        if (handler != null) {
            t.setUncaughtExceptionHandler(handler);
        }
        threads.add(t);
        t.start();
    }

    private void work(boolean temporary) {
        try {
            for (;;) {
                Runnable task;
                synchronized (this) {
                    while (queue.isEmpty()) {
                        if (shutdown || temporary) {
                            return;
                        }
                        idle++;
                        try {
                            wait();
                        } catch (InterruptedException e) {
                            // shutdownNow, or spurious: check the state again
                        } finally {
                            idle--;
                        }
                    }
                    task = queue.pollFirst();
                    lastProgress = System.nanoTime();
                }
                try {
                    task.run();
                } catch (Throwable t) {
                    Thread.UncaughtExceptionHandler h = handler != null ? handler : Thread.currentThread().getUncaughtExceptionHandler();
                    if (h != null) {
                        h.uncaughtException(Thread.currentThread(), t);
                    }
                }
                synchronized (this) {
                    lastProgress = System.nanoTime();
                }
            }
        } finally {
            synchronized (this) {
                workers--;
                if (temporary) {
                    extra--;
                }
                threads.remove(Thread.currentThread());
                notifyAll();
            }
        }
    }

    /** Adds a worker when queued tasks have not moved for a while although every worker is busy. */
    private void startWatchdog() {
        watchdog = new Thread(() -> {
            while (true) {
                try {
                    Thread.sleep(100);
                } catch (InterruptedException e) {
                    return;
                }
                synchronized (this) {
                    if (shutdown) {
                        return;
                    }
                    if (!queue.isEmpty() && idle == 0 && extra < MAX_EXTRA && System.nanoTime() - lastProgress > STALL_NANOS
                            && allBlocked()) {
                        startWorker(true);
                        lastProgress = System.nanoTime();
                    }
                }
            }
        }, prefix + "watchdog");
        watchdog.setDaemon(true);
        watchdog.start();
    }

    /**
     * Whether no worker can go on by itself: each one waits (typically joining a task queued
     * behind it). A worker that is merely busy with a long task does not count, so long tasks do
     * not multiply the workers (they would share the one browser thread anyway). The browser JVM
     * reports every live thread as RUNNABLE, but a parked thread (joining a CompletableFuture,
     * waiting for a lock) has a park blocker.
     */
    private boolean allBlocked() {
        for (Thread t : threads) {
            if (LockSupport.getBlocker(t) != null) {
                continue;
            }
            Thread.State state = t.getState();
            if (state == Thread.State.RUNNABLE || state == Thread.State.NEW) {
                return false;
            }
        }
        return true;
    }

    @Override
    public synchronized void shutdown() {
        shutdown = true;
        notifyAll();
    }

    @Override
    public List<Runnable> shutdownNow() {
        List<Runnable> pending;
        synchronized (this) {
            shutdown = true;
            pending = new ArrayList<Runnable>(queue);
            queue.clear();
            for (Thread t : threads) {
                t.interrupt();
            }
            notifyAll();
        }
        return pending;
    }

    @Override
    public synchronized boolean isShutdown() {
        return shutdown;
    }

    @Override
    public synchronized boolean isTerminated() {
        return shutdown && workers == 0;
    }

    @Override
    public synchronized boolean awaitTermination(long timeout, TimeUnit unit) throws InterruptedException {
        long deadline = System.nanoTime() + unit.toNanos(timeout);
        while (!(shutdown && workers == 0)) {
            long left = deadline - System.nanoTime();
            if (left <= 0) {
                return false;
            }
            TimeUnit.NANOSECONDS.timedWait(this, left);
        }
        return true;
    }
}
