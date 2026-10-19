package webmc.jdk;

import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.util.IdentityHashMap;
import java.util.Map;

/**
 * Minecraft 26.x builds its SNBT grammar ({@code SnbtGrammar.createParser}) again for every
 * command argument that reads NBT, text components or inline resources. That one method holds
 * the whole grammar (hundreds of rule and term constructions); once it has run a few times the
 * browser JVM compiles it, and the compiler needs well over 100 MiB of the JVM's class heap,
 * which runs out while the first world is created. Grammars are immutable, so webmc.GamePatches
 * sends those calls here and each DynamicOps gets one shared grammar.
 */
public final class Grammars {
    /** Grammars per DynamicOps instance; the game uses a handful of singleton ops. */
    private static final Map<Object, Object> CACHE = new IdentityHashMap<Object, Object>();
    private static final int MAX_CACHED = 32;
    private static volatile Method create;

    private Grammars() {
    }

    /** SnbtGrammar.createParser(ops), shared per ops. */
    public static Object createParser(Object ops) throws Throwable {
        synchronized (CACHE) {
            Object cached = CACHE.get(ops);
            if (cached != null) {
                return cached;
            }
        }
        Object grammar;
        try {
            grammar = method(ops).invoke(null, ops);
        } catch (InvocationTargetException e) {
            throw e.getCause();
        }
        synchronized (CACHE) {
            Object raced = CACHE.get(ops);
            if (raced != null) {
                return raced;
            }
            if (CACHE.size() < MAX_CACHED) {
                CACHE.put(ops, grammar);
            }
        }
        return grammar;
    }

    private static Method method(Object ops) throws ReflectiveOperationException {
        Method m = create;
        if (m == null) {
            ClassLoader loader = ops.getClass().getClassLoader();
            if (loader == null) {
                loader = Thread.currentThread().getContextClassLoader();
            }
            Class<?> grammar = Class.forName("net.minecraft.nbt.SnbtGrammar", true, loader);
            for (Method candidate : grammar.getMethods()) {
                if (candidate.getName().equals("createParser") && candidate.getParameterCount() == 1) {
                    m = candidate;
                }
            }
            if (m == null) {
                throw new NoSuchMethodException("net.minecraft.nbt.SnbtGrammar.createParser");
            }
            create = m;
        }
        return m;
    }
}
