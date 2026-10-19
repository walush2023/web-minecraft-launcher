package webmc;

import static webmc.ClassFiles.STRING;
import static webmc.ClassFiles.UTF8;

import java.io.ByteArrayOutputStream;
import java.io.DataOutputStream;
import java.io.IOException;
import java.util.HashSet;
import java.util.Set;

/**
 * Points the game's classes (and its libraries', so that they agree on the types) at stand-ins
 * for JDK concurrency classes whose Java 17 implementations work through VarHandles: the atomic
 * arrays, AtomicReference, AtomicBoolean and ConcurrentLinkedQueue become their namesakes in
 * {@code webmc.jdk.concurrent}. CheerpJ runs every VarHandle access through a
 * newly bound MethodHandle, and the client looks up its chunks in an AtomicReferenceArray for
 * every block it reads: in a 26.3 world that alone took a tenth of the browser's time.
 *
 * <p>Only type names change (class entries, descriptors, generic signatures); string literals
 * stay as they are. Calls of Math and StrictMath log1p, sinh and cosh (which CheerpJ's compiled
 * code gets wrong) and floor and ceil (which it runs slowly) go to {@code webmc.jdk.MathStandIns},
 * and Files.copy between two paths and Files.createLink (which fail in CheerpJ) to
 * {@code webmc.jdk.FileStandIns} (only the method reference's class changes). Disabled with
 * {@code -Dwebmc.standIns=false}.
 */
final class StandIns {
    static final boolean ENABLED = !"false".equals(System.getProperty("webmc.standIns"));

    private static final String[][] TYPES = {
        {"java/util/concurrent/atomic/AtomicReferenceArray", "webmc/jdk/concurrent/AtomicReferenceArray"},
        {"java/util/concurrent/atomic/AtomicIntegerArray", "webmc/jdk/concurrent/AtomicIntegerArray"},
        {"java/util/concurrent/atomic/AtomicLongArray", "webmc/jdk/concurrent/AtomicLongArray"},
        {"java/util/concurrent/atomic/AtomicReference", "webmc/jdk/concurrent/AtomicReference"},
        {"java/util/concurrent/atomic/AtomicBoolean", "webmc/jdk/concurrent/AtomicBoolean"},
        {"java/util/concurrent/ConcurrentLinkedQueue", "webmc/jdk/concurrent/ConcurrentLinkedQueue"},
    };

    private StandIns() {
    }

    /**
     * Static JDK methods CheerpJ gets wrong or runs slowly, as owner, name, descriptor and the class
     * with the stand-in of the same name and descriptor (only the method reference changes).
     */
    private static final String[][] STATICS = {
        {"java/lang/Math", "log1p", "(D)D", "webmc/jdk/MathStandIns"},
        {"java/lang/Math", "sinh", "(D)D", "webmc/jdk/MathStandIns"},
        {"java/lang/Math", "cosh", "(D)D", "webmc/jdk/MathStandIns"},
        {"java/lang/Math", "floor", "(D)D", "webmc/jdk/MathStandIns"},
        {"java/lang/Math", "ceil", "(D)D", "webmc/jdk/MathStandIns"},
        {"java/lang/StrictMath", "log1p", "(D)D", "webmc/jdk/MathStandIns"},
        {"java/lang/StrictMath", "sinh", "(D)D", "webmc/jdk/MathStandIns"},
        {"java/lang/StrictMath", "cosh", "(D)D", "webmc/jdk/MathStandIns"},
        {"java/lang/StrictMath", "floor", "(D)D", "webmc/jdk/MathStandIns"},
        {"java/lang/StrictMath", "ceil", "(D)D", "webmc/jdk/MathStandIns"},
        {"java/nio/file/Files", "copy", "(Ljava/nio/file/Path;Ljava/nio/file/Path;[Ljava/nio/file/CopyOption;)Ljava/nio/file/Path;",
            "webmc/jdk/FileStandIns"},
        {"java/nio/file/Files", "createLink", "(Ljava/nio/file/Path;Ljava/nio/file/Path;)Ljava/nio/file/Path;", "webmc/jdk/FileStandIns"},
    };

    /** Returns the class unchanged when it uses none of the types. */
    static byte[] apply(byte[] in) throws IOException {
        if (!ENABLED) {
            return in;
        }
        boolean types = mentionsAny(in);
        boolean statics = mentionsStatics(in);
        if (!types && !statics) {
            return in;
        }
        Pool pool = new Pool(in);
        boolean changed = false;
        if (statics) {
            for (int i = 1; i < pool.originalCount; i++) {
                if (pool.tag(i) != ClassFiles.METHODREF) {
                    continue;
                }
                String standIn = standInFor(pool.className(pool.u2(i, 1)), pool.memberName(i), pool.memberDescriptor(i));
                if (standIn != null) {
                    pool.setOwner(i, pool.addClass(standIn));
                    changed = true;
                }
            }
        }
        if (!types) {
            return changed ? write(in, pool) : in;
        }
        Set<Integer> strings = new HashSet<Integer>();
        for (int i = 1; i < pool.originalCount; i++) {
            if (pool.tag(i) == STRING) {
                strings.add(pool.u2(i, 1));
            }
        }
        for (int i = 1; i < pool.originalCount; i++) {
            if (pool.tag(i) != UTF8 || strings.contains(i)) {
                continue;
            }
            String value = pool.utf8(i);
            String mapped = remap(value);
            if (!mapped.equals(value)) {
                pool.setUtf8(i, mapped);
                changed = true;
            }
        }
        return changed ? write(in, pool) : in;
    }

    private static byte[] write(byte[] in, Pool pool) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream(in.length + 64);
        DataOutputStream data = new DataOutputStream(out);
        data.write(in, 0, 8);
        pool.write(data);
        data.write(pool.rest());
        data.flush();
        return out.toByteArray();
    }

    private static boolean mentionsStatics(byte[] in) {
        if (!ClassFiles.contains(in, "java/lang/Math") && !ClassFiles.contains(in, "java/lang/StrictMath")
                && !ClassFiles.contains(in, "java/nio/file/Files")) {
            return false;
        }
        for (String[] method : STATICS) {
            if (ClassFiles.contains(in, method[1])) {
                return true;
            }
        }
        return false;
    }

    private static String standInFor(String owner, String name, String descriptor) {
        for (String[] method : STATICS) {
            if (method[1].equals(name) && method[0].equals(owner) && method[2].equals(descriptor)) {
                return method[3];
            }
        }
        return null;
    }

    private static boolean mentionsAny(byte[] in) {
        if (!ClassFiles.contains(in, "java/util/concurrent/")) {
            return false;
        }
        for (String[] type : TYPES) {
            if (ClassFiles.contains(in, type[0])) {
                return true;
            }
        }
        return false;
    }

    static String remap(String value) {
        if (value.indexOf("java/util/concurrent/") < 0) {
            return value;
        }
        for (String[] type : TYPES) {
            if (value.equals(type[0])) {
                return type[1];
            }
        }
        String result = value;
        for (String[] type : TYPES) {
            String from = "L" + type[0];
            if (result.indexOf(from) >= 0) {
                result = result.replace(from + ";", "L" + type[1] + ";").replace(from + "<", "L" + type[1] + "<");
            }
        }
        return result;
    }
}
