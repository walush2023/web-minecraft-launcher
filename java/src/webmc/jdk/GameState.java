package webmc.jdk;

import java.lang.reflect.Field;
import java.lang.reflect.Method;

/**
 * Troubleshooting (?gamestate=1 on the play page): checks every 10 seconds and prints when it
 * changed the client's view of the world (loaded chunks, terrain sections waiting to be compiled
 * and visible, player position, the integrated server's average tick time), through reflection
 * on the unobfuscated 26.x client. Older,
 * obfuscated versions only print the reason it does not apply.
 */
public final class GameState {
    private GameState() {
    }

    public static void start(final ClassLoader loader) {
        Thread t = new Thread(() -> {
            String last = "";
            while (true) {
                try {
                    Thread.sleep(10_000);
                } catch (InterruptedException e) {
                    return;
                }
                String state = describe(loader);
                if (!state.equals(last)) {
                    System.out.println("[webmc] state: " + state);
                    last = state;
                }
            }
        }, "webmc-game-state");
        t.setDaemon(true);
        t.start();
    }

    private static String describe(ClassLoader loader) {
        try {
            Class<?> minecraft = Class.forName("net.minecraft.client.Minecraft", false, loader);
            Object mc = minecraft.getMethod("getInstance").invoke(null);
            if (mc == null) {
                return "no client";
            }
            Object level = field(mc, "level");
            Object player = field(mc, "player");
            if (level == null) {
                return "no level";
            }
            Object chunkSource = call(level, "getChunkSource");
            Object renderer = field(mc, "levelRenderer");
            Object dispatcher = call(renderer, "sectionRenderDispatcher");
            StringBuilder s = new StringBuilder();
            s.append("chunks ").append(call(chunkSource, "getLoadedChunksCount"));
            s.append(", visible sections ").append(call(call(renderer, "visibleSections"), "size"));
            s.append(", all rendered ").append(call(renderer, "hasRenderedAllSections"));
            if (dispatcher != null) {
                s.append(", compile queue ").append(call(dispatcher, "getCompileQueueSize"));
                s.append(" (").append(call(dispatcher, "getStats")).append(')');
            }
            s.append(", entities ").append(call(level, "getEntityCount"));
            if (player != null) {
                s.append(", player at ").append(call(player, "position"));
            }
            Object server = call(mc, "getSingleplayerServer");
            if (server != null) {
                Object nanos = call(server, "getAverageTickTimeNanos");
                if (nanos instanceof Long) {
                    s.append(", server ").append(Math.round((Long) nanos / 1e6)).append(" ms/tick");
                }
            }
            return s.toString();
        } catch (Throwable e) {
            return "unavailable (" + e + ")";
        }
    }

    private static Object field(Object target, String name) throws ReflectiveOperationException {
        for (Class<?> c = target.getClass(); c != null; c = c.getSuperclass()) {
            try {
                Field f = c.getDeclaredField(name);
                f.setAccessible(true);
                return f.get(target);
            } catch (NoSuchFieldException e) {
                // look in the superclass
            }
        }
        throw new NoSuchFieldException(name);
    }

    private static Object call(Object target, String name) throws ReflectiveOperationException {
        if (target == null) {
            return null;
        }
        for (Class<?> c = target.getClass(); c != null; c = c.getSuperclass()) {
            for (Method m : c.getDeclaredMethods()) {
                if (m.getName().equals(name) && m.getParameterCount() == 0) {
                    m.setAccessible(true);
                    return m.invoke(target);
                }
            }
        }
        throw new NoSuchMethodException(name);
    }
}
