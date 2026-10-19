package webmc;

import static webmc.ClassFiles.INVOKESTATIC;
import static webmc.ClassFiles.INVOKEVIRTUAL;
import static webmc.ClassFiles.instructionLength;
import static webmc.ClassFiles.skipMembers;
import static webmc.ClassFiles.u2;
import static webmc.ClassFiles.u4;

import java.io.ByteArrayOutputStream;
import java.io.DataOutputStream;
import java.io.IOException;

/**
 * Small in-memory adjustments of game classes for the browser (the jar files stay unchanged).
 */
final class GamePatches {
    private static final int BIPUSH = 0x10;
    private static final int SIPUSH = 0x11;
    private static final int LDC2_W = 0x14;
    private static final int ILOAD = 0x15;
    private static final int ILOAD_0 = 0x1a;
    private static final int ILOAD_3 = 0x1d;
    private static final int D2I = 0x8e;
    private static final int IF_ICMPGE = 0xa2;
    private static final int PUTSTATIC = 0xb3;
    private static final int GETFIELD = 0xb4;
    private static final int ALOAD_0 = 0x2a;
    private static final int DUP = 0x59;

    private GamePatches() {
    }

    /** Percentage of the vanilla ambient block-animation samples per client tick (see fewerAmbientTicks). */
    private static final int AMBIENT_PERCENT = percent("webmc.ambientPercent");
    /** Percentage of the vanilla natural spawning caps (see smallerMobCaps). */
    private static final int MOB_CAP_PERCENT = percent("webmc.mobCapPercent");
    /** Client ticks a frame may run to catch up with the clock (vanilla: 10; see fewerCatchUpTicks). */
    private static final int CATCH_UP_TICKS = Math.max(1, Math.min(10, Integer.getInteger("webmc.catchUpTicks", 10)));

    private static int percent(String property) {
        return Math.max(1, Math.min(100, Integer.getInteger(property, 100)));
    }

    static byte[] apply(String internalName, byte[] bytes) {
        if ("net/minecraft/server/MinecraftServer".equals(internalName)) {
            return patchCode(bytes, "spawn area: 5x5 chunks (as in 1.20.5+) instead of 21x21", GamePatches::smallerSpawnArea);
        }
        if (AMBIENT_PERCENT < 100 && ClassFiles.contains(bytes, SIPUSH_667)) {
            bytes = patchCode(bytes, "ambient block animation: " + AMBIENT_PERCENT + "% of the vanilla samples per tick", GamePatches::fewerAmbientTicks);
        }
        if (ClassFiles.contains(bytes, "Pre render")) {
            if (CATCH_UP_TICKS < 10) {
                bytes = patchCode(bytes, "client ticks per frame: at most " + CATCH_UP_TICKS, GamePatches::fewerCatchUpTicks);
            }
            bytes = patchCode(bytes, "loading screens: " + LOADING_SLEEP_MILLIS + " ms between frames", GamePatches::slowerLoadingScreens);
        }
        if (MOB_CAP_PERCENT < 100 && ClassFiles.contains(bytes, DOUBLE_17)) {
            bytes = patchCode(bytes, "natural spawning caps: " + MOB_CAP_PERCENT + "% of vanilla", GamePatches::smallerMobCaps);
        }
        if (ClassFiles.contains(bytes, "com/mojang/datafixers/DataFixerBuilder")) {
            bytes = patchCode(bytes, "DataFixer rules built when first needed", GamePatches::lazyDataFixer);
        }
        if (ClassFiles.contains(bytes, "java/util/List") && ClassFiles.contains(bytes, HAS_STRONGHOLD_TAIL)) {
            bytes = strongholdsNearOrigin(bytes);
        }
        if (ClassFiles.contains(bytes, "preferred_biomes") && ClassFiles.contains(bytes, "java/util/List")) {
            bytes = ringPlacementsNearOrigin(bytes);
        }
        if (ClassFiles.contains(bytes, "stbi_info_from_callbacks")) {
            bytes = patchCode(bytes, "texture sizes read in Java (" + internalName + ")", GamePatches::stbInfoInJava);
        }
        if (WORKER_POOL && ClassFiles.contains(bytes, "max.bg.threads") && ClassFiles.contains(bytes, FORK_JOIN_POOL)) {
            bytes = patchCode(bytes, "background executor: webmc.jdk.WorkerPool instead of a ForkJoinPool", GamePatches::plainWorkerPool);
        }
        if (!SNBT_GRAMMAR.equals(internalName) && ClassFiles.contains(bytes, SNBT_GRAMMAR) && ClassFiles.contains(bytes, "createParser")) {
            bytes = patchCode(bytes, "shared SNBT grammar (" + internalName + ")", GamePatches::sharedSnbtGrammar);
        }
        if (LEVEL_STORAGE_ACCESS.equals(internalName)) {
            bytes = patchCode(bytes, "no low disk space warnings (browser storage reports little free space)", GamePatches::enoughDiskSpace);
        }
        if (LOGGING_LOAD_LISTENER.equals(internalName)) {
            bytes = patchCode(bytes, "world loading progress: one log line per 500 ms", GamePatches::logProgressFromNow);
        }
        if (!THREADING_DETECTOR.equals(internalName) && ClassFiles.contains(bytes, THREADING_DETECTOR)) {
            bytes = patchCode(bytes, "no threading detector (" + internalName + ")", GamePatches::noThreadingDetector);
        }
        if (ClassFiles.contains(bytes, HTTP_UTIL) && (ClassFiles.contains(bytes, "getAvailablePort") || ClassFiles.contains(bytes, "isPortAvailable"))) {
            bytes = patchCode(bytes, "LAN ports without sockets (" + internalName + ")", GamePatches::portsWithoutSockets);
        }
        if (LEVEL_LOADING_SCREEN.equals(internalName)) {
            bytes = patchCode(bytes, "world loading screen: progress bar without the chunk map", GamePatches::noChunkMap);
        } else if (ClassFiles.contains(bytes, "loading.progress")) {
            final String self = internalName;
            bytes = patchCode(bytes, "world loading screen: progress bar without the chunk map (" + internalName + ")",
                (pool, b, code, codeLength) -> noObfuscatedChunkMap(pool, b, code, codeLength, self));
        }
        return bytes;
    }

    /**
     * 1.21.6 - 1.21.11 (obfuscated; the same GUI as 26.x): in the loading screen (the class with the
     * "loading.progress" text), the call of its own static chunk map method, shaped like 26.x's
     * extractChunksForRendering (graphics, x, y, size, spacing, status), goes to noChunkMap.
     */
    private static boolean noObfuscatedChunkMap(Pool pool, byte[] b, int code, int codeLength, String self) throws IOException {
        boolean changed = false;
        int replacement = 0;
        for (int pc = 0; pc < codeLength; pc += instructionLength(b, code, pc)) {
            int at = code + pc;
            if ((b[at] & 0xff) != INVOKESTATIC) {
                continue;
            }
            int ref = u2(b, at + 1);
            if (self.equals(pool.className(pool.u2(ref, 1))) && pool.memberDescriptor(ref).matches("\\(L[^;]+;IIIIL[^;]+;\\)V")) {
                if (replacement == 0) {
                    replacement = pool.addMethodref("webmc/jdk/LoadingScreens", "noChunkMap", "(Ljava/lang/Object;IIIILjava/lang/Object;)V");
                }
                b[at + 1] = (byte) (replacement >> 8);
                b[at + 2] = (byte) replacement;
                changed = true;
            }
        }
        return changed;
    }

    private static final String THREADING_DETECTOR = "net/minecraft/util/ThreadingDetector";

    /**
     * 26.x: PalettedContainer's ThreadingDetector checks (a lock and a semaphore per block read or
     * written, only to report misuse) go to webmc.jdk.Threads.unchecked, which takes the detector
     * from the stack as invokevirtual would and does nothing.
     */
    private static boolean noThreadingDetector(Pool pool, byte[] b, int code, int codeLength) throws IOException {
        boolean changed = false;
        int replacement = 0;
        for (int pc = 0; pc < codeLength; pc += instructionLength(b, code, pc)) {
            int at = code + pc;
            if ((b[at] & 0xff) != INVOKEVIRTUAL) {
                continue;
            }
            int ref = u2(b, at + 1);
            String name = pool.memberName(ref);
            if (THREADING_DETECTOR.equals(pool.className(pool.u2(ref, 1))) && "()V".equals(pool.memberDescriptor(ref))
                    && ("checkAndLock".equals(name) || "checkAndUnlock".equals(name))) {
                if (replacement == 0) {
                    replacement = pool.addMethodref("webmc/jdk/Threads", "unchecked", "(Ljava/lang/Object;)V");
                }
                b[at] = (byte) INVOKESTATIC;
                b[at + 1] = (byte) (replacement >> 8);
                b[at + 2] = (byte) replacement;
                changed = true;
            }
        }
        return changed;
    }

    private static final String HTTP_UTIL = "net/minecraft/util/HttpUtil";

    /** 26.x: HttpUtil's socket-based port lookups go to webmc.jdk.Ports (see there). */
    private static boolean portsWithoutSockets(Pool pool, byte[] b, int code, int codeLength) throws IOException {
        boolean changed = false;
        for (int pc = 0; pc < codeLength; pc += instructionLength(b, code, pc)) {
            int at = code + pc;
            int replacement = 0;
            if (invokes(pool, b, at, HTTP_UTIL, "getAvailablePort", "()I")) {
                replacement = pool.addMethodref("webmc/jdk/Ports", "availablePort", "()I");
            } else if (invokes(pool, b, at, HTTP_UTIL, "isPortAvailable", "(I)Z")) {
                replacement = pool.addMethodref("webmc/jdk/Ports", "portAvailable", "(I)Z");
            }
            if (replacement != 0) {
                b[at + 1] = (byte) (replacement >> 8);
                b[at + 2] = (byte) replacement;
                changed = true;
            }
        }
        return changed;
    }

    private static final String LEVEL_LOADING_SCREEN = "net/minecraft/client/gui/screens/LevelLoadingScreen";
    private static final String CHUNK_MAP =
        "(Lnet/minecraft/client/gui/GuiGraphicsExtractor;IIIILnet/minecraft/server/level/progress/ChunkLoadStatusView;)V";

    /**
     * 26.x: the world loading screen's call of extractChunksForRendering (its map of chunk
     * squares) goes to webmc.jdk.LoadingScreens.noChunkMap, which draws nothing: the GUI places
     * each square by testing it against all the others, which took most of the browser's time
     * while a world loaded (the server got the rest). The Object-typed stand-in takes the same
     * arguments.
     */
    private static boolean noChunkMap(Pool pool, byte[] b, int code, int codeLength) throws IOException {
        boolean changed = false;
        int replacement = 0;
        for (int pc = 0; pc < codeLength; pc += instructionLength(b, code, pc)) {
            if (invokes(pool, b, code + pc, LEVEL_LOADING_SCREEN, "extractChunksForRendering", CHUNK_MAP)) {
                if (replacement == 0) {
                    replacement = pool.addMethodref("webmc/jdk/LoadingScreens", "noChunkMap", "(Ljava/lang/Object;IIIILjava/lang/Object;)V");
                }
                b[code + pc + 1] = (byte) (replacement >> 8);
                b[code + pc + 2] = (byte) replacement;
                changed = true;
            }
        }
        return changed;
    }

    private static final String LOGGING_LOAD_LISTENER = "net/minecraft/server/level/progress/LoggingLevelLoadListener";

    /**
     * 26.x logs the world loading progress when {@code Util.getMillis() > nextLogTime} and then
     * moves nextLogTime on by 500 ms. In the browser the server often goes many seconds without
     * an update, so every later update logged again (dozens of identical, slow lines per second)
     * until nextLogTime caught up. The next line is now due 500 ms after the current time:
     * {@code aload_0; dup; getfield nextLogTime; ldc2_w 500; ladd} becomes
     * {@code aload_0; invokestatic Util.getMillis; nop; ldc2_w 500; ladd}.
     */
    private static boolean logProgressFromNow(Pool pool, byte[] b, int code, int codeLength) throws IOException {
        boolean changed = false;
        int getMillis = 0;
        for (int pc = 0; pc + 7 < codeLength; pc += instructionLength(b, code, pc)) {
            int at = code + pc;
            if ((b[at] & 0xff) == ALOAD_0 && (b[at + 1] & 0xff) == DUP && (b[at + 2] & 0xff) == GETFIELD
                    && "nextLogTime".equals(pool.memberName(u2(b, at + 3))) && (b[at + 5] & 0xff) == LDC2_W) {
                if (getMillis == 0) {
                    getMillis = pool.addMethodref("net/minecraft/util/Util", "getMillis", "()J");
                }
                b[at + 1] = (byte) INVOKESTATIC;
                b[at + 2] = (byte) (getMillis >> 8);
                b[at + 3] = (byte) getMillis;
                b[at + 4] = 0; // nop
                changed = true;
            }
        }
        return changed;
    }

    private static final String LEVEL_STORAGE_ACCESS = "net/minecraft/world/level/storage/LevelStorageSource$LevelStorageAccess";

    /**
     * 26.x: checkForLowDiskSpace() is {@code estimateDiskSpace() < 64 MiB}, and the browser file
     * system reports almost no usable space, so every save warned (with a toast). The
     * comparison now reads Long.MAX_VALUE: {@code aload_0; invokevirtual estimateDiskSpace} becomes
     * {@code nop; ldc2_w}.
     */
    private static boolean enoughDiskSpace(Pool pool, byte[] b, int code, int codeLength) throws IOException {
        boolean changed = false;
        int constant = 0;
        for (int pc = 0; pc + 4 < codeLength; pc += instructionLength(b, code, pc)) {
            int at = code + pc;
            if ((b[at] & 0xff) == 0x2a /* aload_0 */ && (b[at + 1] & 0xff) == ClassFiles.INVOKEVIRTUAL) {
                int ref = u2(b, at + 2);
                if (LEVEL_STORAGE_ACCESS.equals(pool.className(pool.u2(ref, 1))) && "estimateDiskSpace".equals(pool.memberName(ref))
                        && "()J".equals(pool.memberDescriptor(ref)) && (b[at + 4] & 0xff) == 0x14 /* ldc2_w */) {
                    if (constant == 0) {
                        constant = pool.addLong(Long.MAX_VALUE);
                    }
                    b[at] = 0; // nop
                    b[at + 1] = 0x14;
                    b[at + 2] = (byte) (constant >> 8);
                    b[at + 3] = (byte) constant;
                    changed = true;
                }
            }
        }
        return changed;
    }

    private static final String SNBT_GRAMMAR = "net/minecraft/nbt/SnbtGrammar";
    private static final String CREATE_PARSER = "(Lcom/mojang/serialization/DynamicOps;)Lnet/minecraft/util/parsing/packrat/commands/Grammar;";

    /**
     * 26.x: calls of SnbtGrammar.createParser(ops) go to webmc.jdk.Grammars, which builds one
     * grammar per DynamicOps (see there). The browser JVM does not verify bytecode, so the
     * Object-typed replacement can stand in for the Grammar-typed original.
     */
    private static boolean sharedSnbtGrammar(Pool pool, byte[] b, int code, int codeLength) throws IOException {
        boolean changed = false;
        int replacement = 0;
        for (int pc = 0; pc < codeLength; pc += instructionLength(b, code, pc)) {
            if (invokes(pool, b, code + pc, SNBT_GRAMMAR, "createParser", CREATE_PARSER)) {
                if (replacement == 0) {
                    replacement = pool.addMethodref("webmc/jdk/Grammars", "createParser", "(Ljava/lang/Object;)Ljava/lang/Object;");
                }
                b[code + pc + 1] = (byte) (replacement >> 8);
                b[code + pc + 2] = (byte) replacement;
                changed = true;
            }
        }
        return changed;
    }

    private static final boolean WORKER_POOL = Boolean.getBoolean("webmc.workerPool");
    private static final String FORK_JOIN_POOL = "java/util/concurrent/ForkJoinPool";
    private static final String FORK_JOIN_POOL_INIT = "(ILjava/util/concurrent/ForkJoinPool$ForkJoinWorkerThreadFactory;Ljava/lang/Thread$UncaughtExceptionHandler;Z)V";

    /**
     * Util.makeExecutor builds the game's background executor as
     * {@code new ForkJoinPool(threads, factory, handler, true)}. That becomes
     * {@code WorkerPool.create(threads, factory, handler, true)} (see webmc.jdk.WorkerPool): the
     * {@code new} and {@code dup} turn into nops and the constructor call into the static factory,
     * which leaves the same single reference on the stack.
     */
    private static boolean plainWorkerPool(Pool pool, byte[] b, int code, int codeLength) throws IOException {
        boolean changed = false;
        int created = -1;
        for (int pc = 0; pc < codeLength; pc += instructionLength(b, code, pc)) {
            int at = code + pc;
            int op = b[at] & 0xff;
            if (op == 0xbb /* new */ && FORK_JOIN_POOL.equals(pool.className(u2(b, at + 1))) && (b[at + 3] & 0xff) == 0x59 /* dup */) {
                created = pc;
            } else if (op == ClassFiles.INVOKESPECIAL && created >= 0) {
                int ref = u2(b, at + 1);
                if (FORK_JOIN_POOL.equals(pool.className(pool.u2(ref, 1))) && "<init>".equals(pool.memberName(ref))
                        && FORK_JOIN_POOL_INIT.equals(pool.memberDescriptor(ref))) {
                    int factory = pool.addMethodref("webmc/jdk/WorkerPool", "create",
                            "(ILjava/util/concurrent/ForkJoinPool$ForkJoinWorkerThreadFactory;Ljava/lang/Thread$UncaughtExceptionHandler;Z)Ljava/util/concurrent/ExecutorService;");
                    for (int k = 0; k < 4; k++) {
                        b[code + created + k] = 0; // nop
                    }
                    b[at] = (byte) INVOKESTATIC;
                    b[at + 1] = (byte) (factory >> 8);
                    b[at + 2] = (byte) factory;
                    created = -1;
                    changed = true;
                }
            }
        }
        return changed;
    }

    /** Patches one method's bytecode in place (same length); returns whether it changed anything. */
    private interface CodePatch {
        boolean apply(Pool pool, byte[] b, int code, int codeLength) throws IOException;
    }

    /** Runs a patch over the code of every method; the constant pool may gain entries. */
    private static byte[] patchCode(byte[] in, String description, CodePatch patch) {
        try {
            Pool pool = new Pool(in);
            byte[] rest = pool.rest();
            int p = 6;
            p += 2 + u2(rest, p) * 2;
            p = skipMembers(rest, p);
            int methods = u2(rest, p);
            p += 2;
            boolean changed = false;
            for (int m = 0; m < methods; m++) {
                int attributes = u2(rest, p + 6);
                p += 8;
                for (int a = 0; a < attributes; a++) {
                    int length = u4(rest, p + 2);
                    if ("Code".equals(pool.utf8(u2(rest, p)))) {
                        changed |= patch.apply(pool, rest, p + 14, u4(rest, p + 10));
                    }
                    p += 6 + length;
                }
            }
            if (!changed) {
                return in;
            }
            System.out.println("[webmc] " + description);
            ByteArrayOutputStream out = new ByteArrayOutputStream(in.length + 32);
            DataOutputStream data = new DataOutputStream(out);
            data.write(in, 0, 8);
            pool.write(data);
            data.write(rest);
            data.flush();
            return out.toByteArray();
        } catch (Exception e) {
            System.err.println("[webmc] patch skipped (" + description + "): " + e);
            return in;
        }
    }

    /** Whether the instruction at pc is invokestatic of the given method. */
    private static boolean invokes(Pool pool, byte[] b, int at, String owner, String name, String descriptor) {
        if ((b[at] & 0xff) != INVOKESTATIC) {
            return false;
        }
        int ref = u2(b, at + 1);
        return owner.equals(pool.className(pool.u2(ref, 1))) && name.equals(pool.memberName(ref))
            && descriptor.equals(pool.memberDescriptor(ref));
    }

    /**
     * 1.14 - 1.20.4 keep the 21x21 chunks around the world spawn loaded and ticking, and generate
     * them (plus a wide margin) before a new world opens: {@code addRegionTicket(START, spawn, 11, ...)}
     * then waiting for 441 ticking chunks. All Java threads share the browser's main thread, so
     * that alone takes many minutes. 1.20.5 made the size a game rule that defaults to 5x5 chunks;
     * the same size is used here (radius 3, 25 chunks). Both constants are matched in one method.
     */
    private static boolean smallerSpawnArea(Pool pool, byte[] b, int code, int codeLength) {
        int radius = -1;
        int count = -1;
        for (int pc = 0; pc < codeLength; pc += instructionLength(b, code, pc)) {
            int op = b[code + pc] & 0xff;
            if (op == BIPUSH && b[code + pc + 1] == 11 && radius < 0) {
                radius = code + pc;
            } else if (op == SIPUSH && u2(b, code + pc + 1) == 441 && radius >= 0) {
                count = code + pc;
            }
        }
        if (radius < 0 || count < radius) {
            return false;
        }
        b[radius + 1] = 3;
        b[count + 1] = 0;
        b[count + 2] = 25;
        return true;
    }

    private static final byte[] SIPUSH_667 = {(byte) SIPUSH, 0x02, (byte) 0x9b};

    /**
     * Every client tick, ClientLevel.animateTick (1.13+) picks 2 x 667 random blocks around the
     * player and lets them spawn ambient particles (torch flames, drips, smoke, cave dust). The
     * block lookups and random numbers are cheap on a desktop JVM but take most of a frame in the
     * browser, so the sample count can be reduced: {@code for (i = 0; i < 667; i++)} becomes
     * {@code i < 667 * percent / 100}. Matched as {@code sipush 667; if_icmpge}.
     */
    private static boolean fewerAmbientTicks(Pool pool, byte[] b, int code, int codeLength) {
        boolean changed = false;
        for (int pc = 0; pc < codeLength; pc += instructionLength(b, code, pc)) {
            if ((b[code + pc] & 0xff) == SIPUSH && u2(b, code + pc + 1) == 667
                    && pc + 3 < codeLength && (b[code + pc + 3] & 0xff) == IF_ICMPGE) {
                int count = 667 * AMBIENT_PERCENT / 100;
                b[code + pc + 1] = (byte) (count >> 8);
                b[code + pc + 2] = (byte) count;
                changed = true;
            }
        }
        return changed;
    }

    /**
     * Minecraft.runTick runs {@code Math.min(10, ticks)} client ticks per frame to catch up with
     * the clock. In the browser a client tick with many entities around can take longer than the
     * 50 ms it stands for, so catching up makes the next frame longer still, until every frame
     * runs 10 ticks (a frame or two per second). With a lower limit the game slows down instead
     * (the integrated server is slower than real time then anyway). Matched as
     * {@code bipush 10; iload; invokestatic Math.min(II)I} in the class that sets the
     * "Pre render" error section.
     */
    private static boolean fewerCatchUpTicks(Pool pool, byte[] b, int code, int codeLength) {
        boolean changed = false;
        for (int pc = 0; pc < codeLength; pc += instructionLength(b, code, pc)) {
            if ((b[code + pc] & 0xff) != BIPUSH || b[code + pc + 1] != 10) {
                continue;
            }
            int next = pc + 2;
            int op = b[code + next] & 0xff;
            int load = op == ILOAD ? 2 : op >= ILOAD_0 && op <= ILOAD_3 ? 1 : 0;
            if (load > 0 && invokes(pool, b, code + next + load, "java/lang/Math", "min", "(II)I")) {
                b[code + pc + 1] = (byte) CATCH_UP_TICKS;
                changed = true;
            }
        }
        return changed;
    }

    private static final long LOADING_SLEEP_MILLIS = 100;

    /**
     * While the integrated server starts (and stops), Minecraft redraws the loading screen and
     * sleeps 10 - 16 ms in a loop. The server only gets the browser's time while the render thread
     * sleeps, and 1.13 - 1.16 draw the chunk progress map one rectangle at a time (tens of
     * milliseconds per frame here), so world creation crawls. A longer sleep leaves the server
     * most of the time; the loading screen still updates several times a second. Matched as
     * {@code ldc2_w <n < 100>; invokestatic Thread.sleep(J)V} in the class that sets the
     * "Pre render" error section.
     */
    private static boolean slowerLoadingScreens(Pool pool, byte[] b, int code, int codeLength) throws IOException {
        boolean changed = false;
        int replacement = 0;
        for (int pc = 0; pc + 6 <= codeLength; pc += instructionLength(b, code, pc)) {
            int at = code + pc;
            if ((b[at] & 0xff) != LDC2_W || !invokes(pool, b, at + 3, "java/lang/Thread", "sleep", "(J)V")) {
                continue;
            }
            int constant = u2(b, at + 1);
            if (pool.tag(constant) != 5 || pool.longValue(constant) >= LOADING_SLEEP_MILLIS) {
                continue;
            }
            if (replacement == 0) {
                replacement = pool.addLong(LOADING_SLEEP_MILLIS);
            }
            b[at + 1] = (byte) (replacement >> 8);
            b[at + 2] = (byte) replacement;
            changed = true;
        }
        return changed;
    }

    /**
     * 1.13 - 1.16 build their DataFixer with {@code builder.build(Util.bootstrapExecutor())}, which
     * warms up every fixer rule on a background thread: minutes of browser time taken from the
     * integrated server. The executor becomes one that drops the tasks (webmc.jdk.NoOpExecutor);
     * the rules are then built when first needed. 1.17+ build only the rules they need.
     * Matched as {@code invokestatic ()Executor; invokevirtual DataFixerBuilder.build(Executor)}.
     */
    private static boolean lazyDataFixer(Pool pool, byte[] b, int code, int codeLength) throws IOException {
        boolean changed = false;
        for (int pc = 0; pc + 6 <= codeLength; pc += instructionLength(b, code, pc)) {
            int at = code + pc;
            if ((b[at] & 0xff) != INVOKESTATIC || (b[at + 3] & 0xff) != INVOKEVIRTUAL) {
                continue;
            }
            int supplier = u2(b, at + 1);
            int build = u2(b, at + 4);
            if (!"()Ljava/util/concurrent/Executor;".equals(pool.memberDescriptor(supplier))
                    || !"com/mojang/datafixers/DataFixerBuilder".equals(pool.className(pool.u2(build, 1)))
                    || !"build".equals(pool.memberName(build))) {
                continue;
            }
            int replacement = pool.addMethodref("webmc/jdk/NoOpExecutor", "get", "()Ljava/util/concurrent/Executor;");
            b[at + 1] = (byte) (replacement >> 8);
            b[at + 2] = (byte) replacement;
            changed = true;
        }
        return changed;
    }

    /** The end of hasStronghold's code: aload_1; invokeinterface List.contains (2 args) ...; ireturn. */
    private static final byte[] HAS_STRONGHOLD_TAIL = {0x02, 0x00, (byte) 0xac};

    /**
     * ChunkGenerator.hasStronghold (1.16 - 1.19.2) is
     * {@code generateStrongholds(); return strongholdPositions.contains(pos);}, and the first
     * call works out every stronghold position (see webmc.jdk.Strongholds). Its code gets a
     * prologue {@code if (Strongholds.nearOrigin(pos)) return false;} Matched by the exact shape
     * of the method: {@code aload_0; invoke ()V; aload_0; getfield List; aload_1;
     * invokeinterface List.contains; ireturn}.
     */
    private static byte[] strongholdsNearOrigin(byte[] in) {
        try {
            Pool pool = new Pool(in);
            byte[] rest = pool.rest();
            int p = 6;
            p += 2 + u2(rest, p) * 2;
            p = skipMembers(rest, p);
            int methods = u2(rest, p);
            ByteArrayOutputStream body = new ByteArrayOutputStream(rest.length + 64);
            DataOutputStream out = new DataOutputStream(body);
            out.write(rest, 0, p + 2);
            p += 2;
            boolean changed = false;
            for (int m = 0; m < methods; m++) {
                String descriptor = pool.utf8(u2(rest, p + 4));
                int attributes = u2(rest, p + 6);
                out.write(rest, p, 8);
                p += 8;
                for (int a = 0; a < attributes; a++) {
                    int length = u4(rest, p + 2);
                    if ("Code".equals(pool.utf8(u2(rest, p))) && isHasStronghold(pool, rest, p, descriptor)) {
                        int nearOrigin = pool.addMethodref("webmc/jdk/Strongholds", "nearOrigin", "(Ljava/lang/Object;)Z");
                        byte[] code = new byte[9 + 15];
                        byte[] prologue = {
                            0x2b, // aload_1 (pos)
                            (byte) INVOKESTATIC, (byte) (nearOrigin >> 8), (byte) nearOrigin,
                            (byte) 0x99, 0x00, 0x05, // ifeq +5: the original code
                            0x03, (byte) 0xac, // iconst_0; ireturn
                        };
                        System.arraycopy(prologue, 0, code, 0, 9);
                        System.arraycopy(rest, p + 14, code, 9, 15);
                        out.writeShort(u2(rest, p));
                        out.writeInt(8 + code.length + 4 + 9);
                        out.writeShort(2); // max_stack
                        out.writeShort(u2(rest, p + 8)); // max_locals
                        out.writeInt(code.length);
                        out.write(code);
                        out.writeShort(0); // no exception handlers
                        out.writeShort(1); // one attribute: a stack map frame for the branch target
                        out.writeShort(pool.addUtf8("StackMapTable"));
                        out.writeInt(3);
                        out.writeShort(1);
                        out.writeByte(9); // same_frame at offset 9
                        changed = true;
                    } else {
                        out.write(rest, p, 6 + length);
                    }
                    p += 6 + length;
                }
            }
            if (!changed) {
                return in;
            }
            out.write(rest, p, rest.length - p);
            out.flush();
            System.out.println("[webmc] strongholds: positions worked out when a chunk beyond 72 chunks from the origin needs them");
            ByteArrayOutputStream result = new ByteArrayOutputStream(in.length + 64);
            DataOutputStream data = new DataOutputStream(result);
            data.write(in, 0, 8);
            pool.write(data);
            data.write(body.toByteArray());
            data.flush();
            return result.toByteArray();
        } catch (Exception e) {
            System.err.println("[webmc] stronghold patch skipped: " + e);
            return in;
        }
    }

    /**
     * ConcentricRingsStructurePlacement.isPlacementChunk (1.18.2+), the stronghold check of each
     * new chunk, waits for every ring position (see webmc.jdk.Strongholds). It gets a prologue
     * {@code if (Strongholds.ringNearOrigin(this, x, z)) return false;}. The class is the one
     * whose codec has a "preferred_biomes" field; the method returns boolean and ends with
     * (int x, int z).
     */
    private static byte[] ringPlacementsNearOrigin(byte[] in) {
        try {
            Pool pool = new Pool(in);
            byte[] rest = pool.rest();
            int p = 6;
            p += 2 + u2(rest, p) * 2;
            p = skipMembers(rest, p);
            int methods = u2(rest, p);
            ByteArrayOutputStream body = new ByteArrayOutputStream(rest.length + 64);
            DataOutputStream out = new DataOutputStream(body);
            out.write(rest, 0, p + 2);
            p += 2;
            boolean changed = false;
            for (int m = 0; m < methods; m++) {
                int access = u2(rest, p);
                String descriptor = pool.utf8(u2(rest, p + 4));
                int[] xz = (access & 0x0008) == 0 ? lastTwoIntSlots(descriptor) : null;
                int attributes = u2(rest, p + 6);
                out.write(rest, p, 8);
                p += 8;
                for (int a = 0; a < attributes; a++) {
                    int length = u4(rest, p + 2);
                    if (xz != null && "Code".equals(pool.utf8(u2(rest, p)))) {
                        int helper = pool.addMethodref("webmc/jdk/Strongholds", "ringNearOrigin", "(Ljava/lang/Object;II)Z");
                        byte[] prologue = {
                            0x2a, // aload_0
                            0x15, (byte) xz[0], 0x15, (byte) xz[1], // iload x; iload z
                            (byte) INVOKESTATIC, (byte) (helper >> 8), (byte) helper,
                            (byte) 0x99, 0x00, 0x05, // ifeq +5: the original code
                            0x03, (byte) 0xac, // iconst_0; ireturn
                        };
                        out.write(withPrologue(pool, rest, p, prologue, 3));
                        changed = true;
                    } else {
                        out.write(rest, p, 6 + length);
                    }
                    p += 6 + length;
                }
            }
            if (!changed) {
                return in;
            }
            out.write(rest, p, rest.length - p);
            out.flush();
            System.out.println("[webmc] stronghold rings: positions worked out when a chunk beyond the first ring needs them");
            ByteArrayOutputStream result = new ByteArrayOutputStream(in.length + 128);
            DataOutputStream data = new DataOutputStream(result);
            data.write(in, 0, 8);
            pool.write(data);
            data.write(body.toByteArray());
            data.flush();
            return result.toByteArray();
        } catch (Exception e) {
            System.err.println("[webmc] stronghold ring patch skipped: " + e);
            return in;
        }
    }

    /** For an instance method "(...II)Z": the local slots of its last two int parameters, else null. */
    private static int[] lastTwoIntSlots(String descriptor) {
        if (!descriptor.endsWith(")Z") || !descriptor.endsWith("II)Z")) {
            return null;
        }
        int slot = 1;
        int last = -1;
        int beforeLast = -1;
        for (int i = 1; descriptor.charAt(i) != ')'; i++) {
            char c = descriptor.charAt(i);
            int start = slot;
            if (c == 'L') {
                i = descriptor.indexOf(';', i);
                slot++;
            } else if (c == '[') {
                while (descriptor.charAt(i) == '[') {
                    i++;
                }
                if (descriptor.charAt(i) == 'L') {
                    i = descriptor.indexOf(';', i);
                }
                slot++;
            } else {
                slot += c == 'J' || c == 'D' ? 2 : 1;
            }
            beforeLast = last;
            last = c == 'I' ? start : -1;
        }
        return last >= 0 && beforeLast >= 0 ? new int[] {beforeLast, last} : null;
    }

    /**
     * A Code attribute (at p in b) with {@code prologue} put before the original code. The
     * prologue may branch to its own end, where a stack map frame equal to the method's entry
     * state is added; the original frames, exception handlers and code move along. Line and
     * local variable tables are dropped.
     */
    private static byte[] withPrologue(Pool pool, byte[] b, int p, byte[] prologue, int prologueStack) throws IOException {
        int shift = prologue.length;
        int maxStack = Math.max(u2(b, p + 6), prologueStack);
        int maxLocals = u2(b, p + 8);
        int codeLength = u4(b, p + 10);
        int code = p + 14;
        int q = code + codeLength;
        int handlers = u2(b, q);
        ByteArrayOutputStream table = new ByteArrayOutputStream();
        DataOutputStream t = new DataOutputStream(table);
        for (int h = 0; h < handlers; h++) {
            int at = q + 2 + h * 8;
            t.writeShort(u2(b, at) + shift);
            t.writeShort(u2(b, at + 2) + shift);
            t.writeShort(u2(b, at + 4) + shift);
            t.writeShort(u2(b, at + 6));
        }
        q += 2 + handlers * 8;
        // Stack map: a same_frame at the end of the prologue, then the original frames.
        byte[] frames = null;
        int attributes = u2(b, q);
        int r = q + 2;
        for (int a = 0; a < attributes; a++) {
            if ("StackMapTable".equals(pool.utf8(u2(b, r)))) {
                frames = new byte[u4(b, r + 2)];
                System.arraycopy(b, r + 6, frames, 0, frames.length);
            }
            r += 6 + u4(b, r + 2);
        }
        ByteArrayOutputStream map = new ByteArrayOutputStream();
        DataOutputStream s = new DataOutputStream(map);
        int entries = frames == null ? 0 : u2(frames, 0);
        if (entries == 0) {
            s.writeShort(1);
            writeFrameDelta(s, 0, shift, null, 0);
        } else {
            int type = frames[2] & 0xff;
            int firstOffset = frameDelta(frames, 2);
            boolean atStart = firstOffset == 0;
            s.writeShort(atStart ? entries : entries + 1);
            if (!atStart) {
                writeFrameDelta(s, 0, shift, null, 0); // same_frame at the original code's start
            }
            // The first original frame: now relative to the added one (or to the code start).
            int newDelta = atStart ? shift : firstOffset - 1;
            writeFrameDelta(s, type, newDelta, frames, 3 + (type >= 247 ? 2 : 0));
            s.write(frames, frameEnd(frames, 2), frames.length - frameEnd(frames, 2));
        }
        s.flush();
        byte[] mapBytes = map.toByteArray();
        ByteArrayOutputStream attribute = new ByteArrayOutputStream();
        DataOutputStream out = new DataOutputStream(attribute);
        out.writeShort(u2(b, p));
        out.writeInt(2 + 2 + 4 + shift + codeLength + 2 + table.size() + 2 + 6 + mapBytes.length);
        out.writeShort(maxStack);
        out.writeShort(maxLocals);
        out.writeInt(shift + codeLength);
        out.write(prologue);
        out.write(b, code, codeLength);
        out.writeShort(handlers);
        out.write(table.toByteArray());
        out.writeShort(1);
        out.writeShort(pool.addUtf8("StackMapTable"));
        out.writeInt(mapBytes.length);
        out.write(mapBytes);
        out.flush();
        return attribute.toByteArray();
    }

    /** offset_delta of the stack map frame starting at f. */
    private static int frameDelta(byte[] frames, int f) {
        int type = frames[f] & 0xff;
        if (type < 64) {
            return type;
        }
        if (type < 128) {
            return type - 64;
        }
        return u2(frames, f + 1);
    }

    /** End of the stack map frame starting at f. */
    private static int frameEnd(byte[] frames, int f) {
        int type = frames[f] & 0xff;
        if (type < 64) {
            return f + 1;
        }
        if (type < 128) {
            return verificationEnd(frames, f + 1);
        }
        if (type == 247) {
            return verificationEnd(frames, f + 3);
        }
        if (type <= 251) {
            return f + 3;
        }
        if (type <= 254) {
            int end = f + 3;
            for (int i = 0; i < type - 251; i++) {
                end = verificationEnd(frames, end);
            }
            return end;
        }
        int end = f + 3;
        int locals = u2(frames, end);
        end += 2;
        for (int i = 0; i < locals; i++) {
            end = verificationEnd(frames, end);
        }
        int stack = u2(frames, end);
        end += 2;
        for (int i = 0; i < stack; i++) {
            end = verificationEnd(frames, end);
        }
        return end;
    }

    private static int verificationEnd(byte[] frames, int v) {
        int tag = frames[v] & 0xff;
        return tag == 7 || tag == 8 ? v + 3 : v + 1;
    }

    /**
     * Writes a frame of the given type with a new offset_delta: same_frame (0) or the original
     * frame (whose bytes after type and delta start at {@code from} in frames).
     */
    private static void writeFrameDelta(DataOutputStream s, int type, int delta, byte[] frames, int from) throws IOException {
        if (frames == null || type < 64) {
            if (delta < 64) {
                s.writeByte(delta);
            } else {
                s.writeByte(251); // same_frame_extended
                s.writeShort(delta);
            }
            return;
        }
        int end = frameEnd(frames, 2);
        if (type < 128) {
            if (delta < 64) {
                s.writeByte(64 + delta);
            } else {
                s.writeByte(247); // same_locals_1_stack_item_frame_extended
                s.writeShort(delta);
            }
            s.write(frames, 3, end - 3);
            return;
        }
        s.writeByte(type);
        s.writeShort(delta);
        s.write(frames, from, end - from);
    }

    /** Whether the Code attribute at p is hasStronghold's (see strongholdsNearOrigin). */
    private static boolean isHasStronghold(Pool pool, byte[] b, int p, String descriptor) {
        if (!descriptor.startsWith("(L") || !descriptor.endsWith(";)Z") || descriptor.indexOf(';') != descriptor.length() - 3) {
            return false;
        }
        if (u4(b, p + 10) != 15) {
            return false;
        }
        int c = p + 14;
        int invoke = b[c + 1] & 0xff;
        if (b[c] != 0x2a || (invoke != 0xb7 && invoke != 0xb6) || b[c + 4] != 0x2a || (b[c + 5] & 0xff) != 0xb4
                || b[c + 8] != 0x2b || (b[c + 9] & 0xff) != 0xb9 || b[c + 12] != 0x02 || b[c + 13] != 0x00 || (b[c + 14] & 0xff) != 0xac) {
            return false;
        }
        int list = u2(b, c + 6);
        int contains = u2(b, c + 10);
        return "()V".equals(pool.memberDescriptor(u2(b, c + 2)))
            && "Ljava/util/List;".equals(pool.memberDescriptor(list))
            && "java/util/List".equals(pool.className(pool.u2(contains, 1)))
            && "contains".equals(pool.memberName(contains));
    }

    private static final String STB_INFO = "(Lorg/lwjgl/stb/STBIIOCallbacks;JLjava/nio/IntBuffer;Ljava/nio/IntBuffer;Ljava/nio/IntBuffer;)Z";

    /**
     * 1.13 - 1.16 read each texture's size with STBImage.stbi_info_from_callbacks, which makes the
     * native call back into Java for the file data; those calls go to webmc.lwjgl.Stb instead,
     * which reads the PNG header in Java.
     */
    private static boolean stbInfoInJava(Pool pool, byte[] b, int code, int codeLength) throws IOException {
        boolean changed = false;
        int replacement = 0;
        for (int pc = 0; pc < codeLength; pc += instructionLength(b, code, pc)) {
            if (invokes(pool, b, code + pc, "org/lwjgl/stb/STBImage", "stbi_info_from_callbacks", STB_INFO)) {
                if (replacement == 0) {
                    replacement = pool.addMethodref("webmc/lwjgl/Stb", "infoFromCallbacks", STB_INFO);
                }
                b[code + pc + 1] = (byte) (replacement >> 8);
                b[code + pc + 2] = (byte) replacement;
                changed = true;
            }
        }
        return changed;
    }

    /** CONSTANT_Double 17.0 (a pre-filter for smallerMobCaps). */
    private static final byte[] DOUBLE_17 = {6, 0x40, 0x31, 0, 0, 0, 0, 0, 0};

    /**
     * Natural spawning caps (70 monsters, 10 animals...) scale with the chunks within 8 chunks of
     * the players divided by {@code MAGIC_NUMBER = (int) Math.pow(17.0, 2.0)}, i.e. they assume
     * mobs spread over 17x17 chunks. Mobs only spawn in the simulated chunks, so with the small
     * simulation distance used in the browser the same number of mobs crowds around the player,
     * and every mob costs time on the integrated server and in each client tick. The base 17 is
     * raised so the caps become the given percentage. Matched as
     * {@code ldc2_w 17.0; ldc2_w 2.0; invokestatic Math.pow(DD)D; d2i; putstatic}.
     */
    private static boolean smallerMobCaps(Pool pool, byte[] b, int code, int codeLength) {
        boolean changed = false;
        for (int pc = 0; pc + 12 < codeLength; pc += instructionLength(b, code, pc)) {
            int at = code + pc;
            if ((b[at] & 0xff) != LDC2_W || (b[at + 3] & 0xff) != LDC2_W || (b[at + 9] & 0xff) != D2I
                    || (b[at + 10] & 0xff) != PUTSTATIC || !invokes(pool, b, at + 6, "java/lang/Math", "pow", "(DD)D")) {
                continue;
            }
            int base = u2(b, at + 1);
            int exponent = u2(b, at + 4);
            if (pool.tag(base) != 6 || pool.doubleValue(base) != 17.0 || pool.tag(exponent) != 6 || pool.doubleValue(exponent) != 2.0) {
                continue;
            }
            int scaled = pool.addDouble(17.0 / Math.sqrt(MOB_CAP_PERCENT / 100.0));
            b[at + 1] = (byte) (scaled >> 8);
            b[at + 2] = (byte) scaled;
            changed = true;
        }
        return changed;
    }
}
