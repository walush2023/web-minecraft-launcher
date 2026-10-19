package webmc.jdk;

/**
 * Cooperative time slicing for the browser JVM.
 *
 * <p>CheerpJ runs every Java thread on the browser's main thread and switches threads only when
 * one blocks. A busy thread (the integrated server ticking, a chunk builder working through its
 * queue) therefore holds up the render thread for as long as it keeps running, often seconds.
 * Worse, the browser itself (animation frames, timers, input) only gets the main thread back
 * when no Java thread is runnable, and the render thread waits for exactly those.
 *
 * <p>{@code webmc.TimeSlices} inserts a call to {@link #tick()} at the start of every game method
 * that contains a loop. When a thread other than the render thread has run for longer than a
 * slice it gives way: while the render thread waits for the display, sleeps or is blocked it lets
 * the browser have a turn ({@link #breathe()}); while the render thread works on a frame it waits
 * until that frame is done ({@link #awaitRender()}).
 */
public final class Sched {
    private static final long SLICE_NANOS = Long.getLong("webmc.sliceMillis", 4L) * 1_000_000L;
    private static int calls;
    private static long sliceStart = System.nanoTime();
    private static volatile Thread render;

    private Sched() {
    }

    /** Render thread states reported by {@link #renderState()}. */
    private static final int NO_WINDOW = 0;
    private static final int WAITING = 1;

    /**
     * Implemented in JavaScript: 0 before the game window exists, 1 while the render thread waits
     * for the browser (an animation frame, a timer), 2 while it is working on a frame.
     */
    private static native int renderState();

    /** Implemented in JavaScript (async): returns after the browser has run its pending tasks. */
    private static native void breathe();

    /**
     * Implemented in JavaScript (async): returns when the render thread next waits for the browser,
     * or after a short timeout (in case the render thread is waiting for this thread).
     */
    private static native void awaitRender();

    // ------------------------------------------------------------------------------------
    // Troubleshooting (?profile=1 on the play page): a sampling profiler. Each thread samples its
    // own stack (the only one CheerpJ provides) every 10 ms from tick(); every 20 seconds the
    // most frequent methods per thread are printed.
    // ------------------------------------------------------------------------------------
    private static final boolean PROFILE = Boolean.getBoolean("webmc.profile");
    private static final java.util.Map<String, java.util.Map<String, int[]>> INCLUSIVE = new java.util.HashMap<String, java.util.Map<String, int[]>>();
    private static final java.util.Map<String, int[]> SAMPLES = new java.util.HashMap<String, int[]>();
    private static long nextSample;
    private static long nextReport = System.nanoTime() + 20_000_000_000L;

    private static void sample(long now) {
        if (now < nextSample) {
            return;
        }
        nextSample = now + 10_000_000L;
        Thread thread = Thread.currentThread();
        StackTraceElement[] stack = thread.getStackTrace();
        String name = thread.getName();
        java.util.Map<String, int[]> counts = INCLUSIVE.get(name);
        if (counts == null) {
            counts = new java.util.HashMap<String, int[]>();
            INCLUSIVE.put(name, counts);
        }
        int[] total = SAMPLES.get(name);
        if (total == null) {
            total = new int[1];
            SAMPLES.put(name, total);
        }
        total[0]++;
        java.util.Set<String> seen = new java.util.HashSet<String>();
        for (int i = 0; i < Math.min(stack.length, 48); i++) {
            String frame = stack[i].getClassName() + "." + stack[i].getMethodName();
            if (frame.startsWith("webmc.jdk.Sched") || frame.startsWith("java.lang.Thread.getStackTrace") || !seen.add(frame)) {
                continue;
            }
            int[] c = counts.get(frame);
            if (c == null) {
                counts.put(frame, c = new int[1]);
            }
            c[0]++;
        }
        if (now > nextReport) {
            nextReport = now + 20_000_000_000L;
            StringBuilder out = new StringBuilder("[profile]\n");
            for (java.util.Map.Entry<String, java.util.Map<String, int[]>> t : INCLUSIVE.entrySet()) {
                int samples = SAMPLES.get(t.getKey())[0];
                out.append("[profile] thread ").append(t.getKey()).append(": ").append(samples).append(" samples\n");
                java.util.List<java.util.Map.Entry<String, int[]>> rows = new java.util.ArrayList<java.util.Map.Entry<String, int[]>>(t.getValue().entrySet());
                java.util.Collections.sort(rows, new java.util.Comparator<java.util.Map.Entry<String, int[]>>() {
                    @Override
                    public int compare(java.util.Map.Entry<String, int[]> a, java.util.Map.Entry<String, int[]> b) {
                        return b.getValue()[0] - a.getValue()[0];
                    }
                });
                for (int i = 0; i < Math.min(rows.size(), 40); i++) {
                    out.append("[profile]   ").append(100 * rows.get(i).getValue()[0] / Math.max(1, samples)).append("% ").append(rows.get(i).getKey()).append('\n');
                }
            }
            INCLUSIVE.clear();
            SAMPLES.clear();
            System.out.print(out);
        }
    }

    /** The thread that is never asked to yield: the game's render thread. */
    public static void setRenderThread(Thread thread) {
        render = thread;
    }

    public static void tick() {
        if (++calls < 128) {
            return;
        }
        calls = 0;
        long now = System.nanoTime();
        if (PROFILE) {
            sample(now);
        }
        if (now - sliceStart < SLICE_NANOS) {
            return;
        }
        sliceStart = now;
        if (Thread.currentThread() == render) {
            return;
        }
        // The render thread has priority: other threads use the time it spends waiting for the
        // display, sleeping or waiting for them (loading screens poll the server with
        // Thread.sleep), and step aside while it works on a frame.
        int state = renderState();
        Thread renderThread = render;
        if (state == NO_WINDOW) {
            Thread.yield();
        } else if (state == WAITING || renderThread == null || renderThread.getState() != Thread.State.RUNNABLE) {
            breathe();
        } else {
            awaitRender();
        }
        sliceStart = System.nanoTime();
    }
}
