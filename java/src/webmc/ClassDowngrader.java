package webmc;

import static webmc.ClassFiles.CLASS;
import static webmc.ClassFiles.INTERFACE_METHODREF;
import static webmc.ClassFiles.INVOKEINTERFACE;
import static webmc.ClassFiles.INVOKESTATIC;
import static webmc.ClassFiles.INVOKEVIRTUAL;
import static webmc.ClassFiles.METHOD_HANDLE;
import static webmc.ClassFiles.METHODREF;
import static webmc.ClassFiles.NAME_AND_TYPE;
import static webmc.ClassFiles.STRING;
import static webmc.ClassFiles.UTF8;
import static webmc.ClassFiles.contains;
import static webmc.ClassFiles.instructionLength;
import static webmc.ClassFiles.skipMembers;
import static webmc.ClassFiles.u2;
import static webmc.ClassFiles.u4;

import java.io.ByteArrayOutputStream;
import java.io.DataOutputStream;
import java.io.IOException;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;

/**
 * Lets the browser's Java 17 runtime run classes compiled for Java 18 - 25 (Minecraft 1.20.5 and
 * later), in memory, as they are loaded; the game's files are not changed.
 *
 * <ul>
 *   <li>the class file version is lowered to 61 (Java 17);</li>
 *   <li>types added in Java 21 are mapped to their Java 17 supertypes (SequencedMap -> Map) or
 *       to stand-ins (MatchException);</li>
 *   <li>calls to library methods added after Java 17 are redirected to {@code webmc.jdk.J21}
 *       (and {@code J25}).
 *       An instance call becomes {@code invokestatic} with the receiver as first argument;
 *       {@code invokeinterface} is two bytes longer than {@code invokestatic}, so the rest of
 *       the instruction is filled with {@code nop}s and no code offset changes.</li>
 * </ul>
 * The redirections cover what the game and its libraries actually use (found by comparing
 * their constant pools against the Java 17 API).
 */
final class ClassDowngrader {
    static final int JAVA_17 = 61;
    private static final String SHIMS = "webmc/jdk/J21";

    private static final Map<String, String> CLASSES = new HashMap<String, String>();
    /** owner.name+descriptor (as compiled) -> shim name+descriptor in webmc/jdk/J21 (or "owner." first). */
    private static final Map<String, String> METHODS = new HashMap<String, String>();

    static {
        CLASSES.put("java/lang/MatchException", "webmc/jdk/MatchException");
        CLASSES.put("java/lang/ScopedValue", "webmc/jdk/ScopedValue");
        CLASSES.put("java/lang/ScopedValue$Carrier", "webmc/jdk/ScopedValue$Carrier");
        CLASSES.put("java/lang/ScopedValue$CallableOp", "webmc/jdk/ScopedValue$CallableOp");
        CLASSES.put("java/util/SequencedCollection", "java/util/Collection");
        CLASSES.put("java/util/SequencedSet", "java/util/Set");
        CLASSES.put("java/util/SequencedMap", "java/util/Map");

        for (String owner : new String[] {"java/util/List", "java/util/ArrayList"}) {
            String list = "(Ljava/util/List;";
            METHODS.put(owner + ".getFirst()Ljava/lang/Object;", "getFirst" + list + ")Ljava/lang/Object;");
            METHODS.put(owner + ".getLast()Ljava/lang/Object;", "getLast" + list + ")Ljava/lang/Object;");
            METHODS.put(owner + ".removeFirst()Ljava/lang/Object;", "removeFirst" + list + ")Ljava/lang/Object;");
            METHODS.put(owner + ".removeLast()Ljava/lang/Object;", "removeLast" + list + ")Ljava/lang/Object;");
            METHODS.put(owner + ".addFirst(Ljava/lang/Object;)V", "addFirst" + list + "Ljava/lang/Object;)V");
            METHODS.put(owner + ".addLast(Ljava/lang/Object;)V", "addLast" + list + "Ljava/lang/Object;)V");
        }
        METHODS.put("java/util/List.reversed()Ljava/util/List;", "reversed(Ljava/util/List;)Ljava/util/List;");
        METHODS.put("java/util/SequencedCollection.getFirst()Ljava/lang/Object;", "getFirst(Ljava/util/Collection;)Ljava/lang/Object;");
        METHODS.put("java/util/SequencedSet.getFirst()Ljava/lang/Object;", "getFirst(Ljava/util/Collection;)Ljava/lang/Object;");
        METHODS.put("java/util/SequencedMap.pollFirstEntry()Ljava/util/Map$Entry;", "pollFirstEntry(Ljava/util/Map;)Ljava/util/Map$Entry;");
        METHODS.put("java/util/SequencedMap.firstEntry()Ljava/util/Map$Entry;", "firstEntry(Ljava/util/Map;)Ljava/util/Map$Entry;");
        METHODS.put("java/util/LinkedHashMap.pollFirstEntry()Ljava/util/Map$Entry;", "pollFirstEntry(Ljava/util/Map;)Ljava/util/Map$Entry;");
        METHODS.put("java/util/LinkedHashMap.firstEntry()Ljava/util/Map$Entry;", "firstEntry(Ljava/util/Map;)Ljava/util/Map$Entry;");
        METHODS.put("java/util/Collections.unmodifiableSequencedSet(Ljava/util/SequencedSet;)Ljava/util/SequencedSet;",
                "unmodifiableSequencedSet(Ljava/util/Set;)Ljava/util/Set;");
        METHODS.put("java/util/Collections.unmodifiableSequencedCollection(Ljava/util/SequencedCollection;)Ljava/util/SequencedCollection;",
                "unmodifiableSequencedCollection(Ljava/util/Collection;)Ljava/util/Collection;");
        METHODS.put("java/util/Collections.unmodifiableSequencedMap(Ljava/util/SequencedMap;)Ljava/util/SequencedMap;",
                "unmodifiableSequencedMap(Ljava/util/Map;)Ljava/util/Map;");
        METHODS.put("java/lang/Math.clamp(JII)I", "clamp(JII)I");
        METHODS.put("java/lang/Math.clamp(JJJ)J", "clamp(JJJ)J");
        METHODS.put("java/lang/Math.clamp(FFF)F", "clamp(FFF)F");
        METHODS.put("java/lang/Math.clamp(DDD)D", "clamp(DDD)D");
        METHODS.put("java/lang/Thread.threadId()J", "threadId(Ljava/lang/Thread;)J");
        METHODS.put("java/lang/Thread.sleep(Ljava/time/Duration;)V", "sleep(Ljava/time/Duration;)V");
        // Java 9, but CheerpJ lacks the Unsafe.compareAndExchangeReference native behind it
        // (the StandIns classes, used by default, implement it themselves).
        if (!StandIns.ENABLED) {
            METHODS.put("java/util/concurrent/atomic/AtomicReferenceArray.compareAndExchange(ILjava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;",
                    "compareAndExchange(Ljava/util/concurrent/atomic/AtomicReferenceArray;ILjava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;");
            METHODS.put("java/util/concurrent/atomic/AtomicReference.compareAndExchange(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;",
                    "compareAndExchange(Ljava/util/concurrent/atomic/AtomicReference;Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;");
        }

        // Java 18 - 25 (26.1+), in webmc.jdk.J25 (built against the Java 17 API).
        String j25 = "webmc/jdk/J25.";
        METHODS.put("java/io/Reader.readAllAsString()Ljava/lang/String;", j25 + "readAllAsString(Ljava/io/Reader;)Ljava/lang/String;");
        METHODS.put("java/lang/Math.floorDivExact(II)I", j25 + "floorDivExact(II)I");
        METHODS.put("java/lang/Math.floorDivExact(JJ)J", j25 + "floorDivExact(JJ)J");
        METHODS.put("java/lang/Math.powExact(II)I", j25 + "powExact(II)I");
        METHODS.put("java/lang/Math.powExact(JI)J", j25 + "powExact(JI)J");
        METHODS.put("java/net/http/HttpClient.close()V", j25 + "close(Ljava/net/http/HttpClient;)V");
        METHODS.put("java/net/http/HttpRequest$Builder.HEAD()Ljava/net/http/HttpRequest$Builder;",
                j25 + "HEAD(Ljava/net/http/HttpRequest$Builder;)Ljava/net/http/HttpRequest$Builder;");
        METHODS.put("java/nio/file/Path.resolve(Ljava/lang/String;[Ljava/lang/String;)Ljava/nio/file/Path;",
                j25 + "resolve(Ljava/nio/file/Path;Ljava/lang/String;[Ljava/lang/String;)Ljava/nio/file/Path;");
        METHODS.put("java/time/Duration.isPositive()Z", j25 + "isPositive(Ljava/time/Duration;)Z");
        // 26.x shader compiles: their #include callback is called from Java first (see webmc.lwjgl.Shaders).
        String compile = "shaderc_compile_into_spv(JLjava/nio/ByteBuffer;ILjava/nio/ByteBuffer;Ljava/nio/ByteBuffer;J)J";
        METHODS.put("org/lwjgl/util/shaderc/Shaderc." + compile, "webmc/lwjgl/Shaders." + compile);
        // Pattern-matching switches: the Java 17 bootstraps only link selectors of type Object.
        String bootstrap = "(Ljava/lang/invoke/MethodHandles$Lookup;Ljava/lang/String;Ljava/lang/invoke/MethodType;[Ljava/lang/Object;)Ljava/lang/invoke/CallSite;";
        METHODS.put("java/lang/runtime/SwitchBootstraps.typeSwitch" + bootstrap, "webmc/jdk/SwitchBootstraps.typeSwitch" + bootstrap);
        METHODS.put("java/lang/runtime/SwitchBootstraps.enumSwitch" + bootstrap, "webmc/jdk/SwitchBootstraps.enumSwitch" + bootstrap);
    }

    /**
     * SequencedCollection methods (Java 21) as inherited by other classes: Java 21 compilers name
     * the receiver's class, e.g. {@code ImmutableList.getFirst()} for Guava's list, which has no
     * such method on Java 17. Name + descriptor -> a shim taking the collection.
     */
    private static final Map<String, String> SEQUENCED = new HashMap<String, String>();

    static {
        String collection = "(Ljava/util/Collection;";
        SEQUENCED.put("getFirst()Ljava/lang/Object;", "getFirst" + collection + ")Ljava/lang/Object;");
        SEQUENCED.put("getLast()Ljava/lang/Object;", "getLast" + collection + ")Ljava/lang/Object;");
        SEQUENCED.put("removeFirst()Ljava/lang/Object;", "removeFirst" + collection + ")Ljava/lang/Object;");
        SEQUENCED.put("removeLast()Ljava/lang/Object;", "removeLast" + collection + ")Ljava/lang/Object;");
        SEQUENCED.put("addFirst(Ljava/lang/Object;)V", "addFirst" + collection + "Ljava/lang/Object;)V");
        SEQUENCED.put("addLast(Ljava/lang/Object;)V", "addLast" + collection + "Ljava/lang/Object;)V");
    }

    /** Reads a game or library class file (null when unknown), to see what a class inherits. */
    interface ClassSource {
        byte[] bytes(String internalName) throws IOException;
    }

    private ClassDowngrader() {
    }

    static byte[] downgrade(byte[] in) throws IOException {
        return downgrade(in, null);
    }

    /** Returns the class unchanged when it needs nothing. */
    static byte[] downgrade(byte[] in, ClassSource source) throws IOException {
        int major = u2(in, 6);
        Pool pool = new Pool(in);
        boolean versionOk = major <= JAVA_17;
        if (versionOk && !mentionsAny(pool)) {
            return in;
        }
        // 1. Calls redirected to the shims (matched on the names as compiled).
        Map<Integer, Integer> redirected = new HashMap<Integer, Integer>();
        Map<String, Integer> shimClasses = new HashMap<String, Integer>();
        for (int i = 1; i < pool.count; i++) {
            int tag = pool.tag(i);
            if (tag != METHODREF && tag != INTERFACE_METHODREF) {
                continue;
            }
            String owner = pool.className(pool.u2(i, 1));
            String member = pool.memberName(i) + pool.memberDescriptor(i);
            String shim = METHODS.get(owner + "." + member);
            if (shim == null && source != null && SEQUENCED.containsKey(member) && !owner.startsWith("java/")
                    && inheritsJava21Default(owner, pool.memberName(i), pool.memberDescriptor(i), source)) {
                shim = SEQUENCED.get(member);
            }
            if (shim == null) {
                continue;
            }
            String shimOwner = SHIMS;
            int dot = shim.indexOf('.');
            if (dot >= 0 && dot < shim.indexOf('(')) {
                shimOwner = shim.substring(0, dot);
                shim = shim.substring(dot + 1);
            }
            Integer shimClass = shimClasses.get(shimOwner);
            if (shimClass == null) {
                shimClass = pool.add(CLASS, pool.addUtf8(shimOwner));
                shimClasses.put(shimOwner, shimClass);
            }
            int paren = shim.indexOf('(');
            int nat = pool.add(NAME_AND_TYPE, pool.addUtf8(shim.substring(0, paren)), pool.addUtf8(shim.substring(paren)));
            redirected.put(i, pool.add(METHODREF, shimClass, nat));
        }
        // Method references (e.g. List::getFirst) become static method handles.
        for (int i = 1; i < pool.count; i++) {
            if (pool.tag(i) == METHOD_HANDLE) {
                Integer target = redirected.get(pool.u2(i, 2));
                if (target != null) {
                    pool.setMethodHandle(i, 6 /* REF_invokeStatic */, target);
                }
            }
        }
        // 2. Type names, in class entries, descriptors and generic signatures.
        Set<Integer> strings = new HashSet<Integer>();
        for (int i = 1; i < pool.count; i++) {
            if (pool.tag(i) == STRING) {
                strings.add(pool.u2(i, 1));
            }
        }
        for (int i = 1; i < pool.originalCount; i++) {
            if (pool.tag(i) != UTF8 || strings.contains(i)) {
                continue;
            }
            String value = pool.utf8(i);
            String mapped = remapTypes(value);
            if (!mapped.equals(value)) {
                pool.setUtf8(i, mapped);
            }
        }
        // 3. Code: instance calls to redirected methods become invokestatic.
        byte[] rest = pool.rest();
        if (!redirected.isEmpty()) {
            rewriteCode(rest, pool, redirected);
        }
        ByteArrayOutputStream out = new ByteArrayOutputStream(in.length + 256);
        DataOutputStream data = new DataOutputStream(out);
        data.writeInt(0xCAFEBABE);
        data.writeShort(versionOk ? u2(in, 4) : 0);
        data.writeShort(Math.min(major, JAVA_17));
        pool.write(data);
        data.write(rest);
        data.flush();
        return out.toByteArray();
    }

    /**
     * Replaces a string literal (a CONSTANT_String's text) in a class, leaving every other
     * constant alone. Returns the class unchanged when the literal does not occur.
     */
    static byte[] replaceString(byte[] in, String from, String to) throws IOException {
        if (!contains(in, from)) {
            return in;
        }
        Pool pool = new Pool(in);
        boolean changed = false;
        for (int i = 1; i < pool.originalCount; i++) {
            if (pool.tag(i) == STRING && from.equals(pool.utf8(pool.u2(i, 1)))) {
                pool.setString(i, pool.addUtf8(to));
                changed = true;
            }
        }
        if (!changed) {
            return in;
        }
        ByteArrayOutputStream out = new ByteArrayOutputStream(in.length + 64);
        DataOutputStream data = new DataOutputStream(out);
        data.write(in, 0, 8);
        pool.write(data);
        data.write(pool.rest());
        data.flush();
        return out.toByteArray();
    }

    private static final Map<String, Boolean> INHERITED = new java.util.concurrent.ConcurrentHashMap<String, Boolean>();

    /**
     * Whether a call names a SequencedCollection method that the owner only inherits from Java
     * 21's collection interfaces: no class in its hierarchy declares it on this (Java 17) runtime,
     * and the owner is a Collection. Classes that declare a method of the same name and
     * descriptor themselves (DataFixerUpper's Pair.getFirst(), Deques) are left alone.
     */
    private static boolean inheritsJava21Default(String owner, String name, String descriptor, ClassSource source) throws IOException {
        String key = owner + "." + name + descriptor;
        Boolean known = INHERITED.get(key);
        if (known == null) {
            boolean[] collection = {false};
            known = !declares(owner, name, descriptor, source, collection, new HashSet<String>()) && collection[0];
            INHERITED.put(key, known);
        }
        return known;
    }

    private static boolean declares(String type, String name, String descriptor, ClassSource source, boolean[] collection,
            Set<String> seen) throws IOException {
        if (!seen.add(type)) {
            return false;
        }
        if (type.startsWith("java/")) {
            try {
                Class<?> jdk = Class.forName(type.replace('/', '.'), false, null);
                if (java.util.Collection.class.isAssignableFrom(jdk)) {
                    collection[0] = true;
                }
                if (descriptor.startsWith("()")) {
                    jdk.getMethod(name);
                } else {
                    jdk.getMethod(name, Object.class);
                }
                return true;
            } catch (ClassNotFoundException | NoSuchMethodException e) {
                return false;
            }
        }
        byte[] bytes = source.bytes(type);
        if (bytes == null) {
            return true; // unknown class: leave the call as it is
        }
        Pool pool = new Pool(bytes);
        byte[] rest = pool.rest();
        int p = 6;
        int interfaces = u2(rest, p);
        p += 2 + interfaces * 2;
        p = skipMembers(rest, p);
        int methods = u2(rest, p);
        p += 2;
        for (int m = 0; m < methods; m++) {
            if (name.equals(pool.utf8(u2(rest, p + 2))) && descriptor.equals(pool.utf8(u2(rest, p + 4)))) {
                return true;
            }
            int attributes = u2(rest, p + 6);
            p += 8;
            for (int a = 0; a < attributes; a++) {
                p += 6 + u4(rest, p + 2);
            }
        }
        int superClass = u2(rest, 4);
        if (superClass != 0 && declares(pool.className(superClass), name, descriptor, source, collection, seen)) {
            return true;
        }
        for (int i = 0; i < interfaces; i++) {
            if (declares(pool.className(u2(rest, 8 + i * 2)), name, descriptor, source, collection, seen)) {
                return true;
            }
        }
        return false;
    }

    /** Whether the class names a type or calls a method this downgrade handles. */
    private static boolean mentionsAny(Pool pool) {
        for (int i = 1; i < pool.originalCount; i++) {
            int tag = pool.tag(i);
            if (tag == UTF8) {
                String s = pool.utf8(i);
                if (s.indexOf("java/") >= 0) {
                    for (String type : CLASSES.keySet()) {
                        if (s.indexOf(type) >= 0) {
                            return true;
                        }
                    }
                }
            } else if ((tag == METHODREF || tag == INTERFACE_METHODREF)
                    && METHODS.containsKey(pool.className(pool.u2(i, 1)) + "." + pool.memberName(i) + pool.memberDescriptor(i))) {
                return true;
            }
        }
        return false;
    }

    private static String remapTypes(String value) {
        String mapped = CLASSES.get(value);
        if (mapped != null) {
            return mapped;
        }
        if (value.indexOf("java/") < 0) {
            return value;
        }
        String result = value;
        for (Map.Entry<String, String> e : CLASSES.entrySet()) {
            String from = "L" + e.getKey();
            if (result.indexOf(from) < 0) {
                continue;
            }
            result = result.replace(from + ";", "L" + e.getValue() + ";").replace(from + "<", "L" + e.getValue() + "<");
        }
        return result;
    }

    /** Walks every Code attribute in the bytes that follow the constant pool. */
    private static void rewriteCode(byte[] b, Pool pool, Map<Integer, Integer> redirected) {
        int p = 6; // access flags, this class, super class
        p += 2 + u2(b, p) * 2; // interfaces
        p = skipMembers(b, p); // fields
        int methods = u2(b, p);
        p += 2;
        for (int m = 0; m < methods; m++) {
            int attributes = u2(b, p + 6);
            p += 8;
            for (int a = 0; a < attributes; a++) {
                String name = pool.utf8(u2(b, p));
                int length = u4(b, p + 2);
                if ("Code".equals(name)) {
                    int codeLength = u4(b, p + 10);
                    int code = p + 14;
                    for (int pc = 0; pc < codeLength; pc += instructionLength(b, code, pc)) {
                        int op = b[code + pc] & 0xff;
                        if (op != INVOKEVIRTUAL && op != INVOKEINTERFACE && op != INVOKESTATIC) {
                            continue;
                        }
                        Integer target = redirected.get(u2(b, code + pc + 1));
                        if (target == null) {
                            continue;
                        }
                        b[code + pc] = (byte) INVOKESTATIC;
                        b[code + pc + 1] = (byte) (target >> 8);
                        b[code + pc + 2] = (byte) (int) target;
                        if (op == INVOKEINTERFACE) {
                            b[code + pc + 3] = 0; // nop
                            b[code + pc + 4] = 0; // nop
                        }
                    }
                }
                p += 6 + length;
            }
        }
    }
}
