package webmc;

import static webmc.ClassFiles.CLASS;
import static webmc.ClassFiles.INTERFACE_METHODREF;
import static webmc.ClassFiles.INVOKEDYNAMIC;
import static webmc.ClassFiles.INVOKESTATIC;
import static webmc.ClassFiles.INVOKE_DYNAMIC;
import static webmc.ClassFiles.METHODREF;
import static webmc.ClassFiles.METHOD_HANDLE;
import static webmc.ClassFiles.NAME_AND_TYPE;
import static webmc.ClassFiles.STRING;
import static webmc.ClassFiles.contains;
import static webmc.ClassFiles.instructionLength;
import static webmc.ClassFiles.skipMembers;
import static webmc.ClassFiles.u2;
import static webmc.ClassFiles.u4;

import java.io.ByteArrayOutputStream;
import java.io.DataOutputStream;
import java.io.IOException;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Replaces two kinds of invokedynamic call sites with plain bytecode, as {@link RecordMethods}
 * does for records: string concatenation ({@code StringConcatFactory.makeConcatWithConstants},
 * javac's default since Java 9) and pattern-matching switches ({@code typeSwitch} and
 * {@code enumSwitch}). CheerpJ runs every call through the call site's method handle chain,
 * resolving its target method by name on each call; the render thread does this for each draw
 * (the renderer switches over uniform types) and for every concatenated string.
 *
 * <p>Each call site becomes {@code invokestatic} of a private static method added to the class
 * (plus two {@code nop}s, so no offset moves). Concatenations append to a StringBuilder; switches
 * pass their labels to {@code webmc.jdk.SwitchBootstraps}. Both are straight-line code, so they
 * need no stack map frames. Switches with labels other than classes, strings and integers (enum
 * descriptors are dynamic constants) keep their invokedynamic. Disabled with
 * {@code -Dwebmc.lowerIndy=false}.
 */
final class Invokedynamics {
    static final boolean ENABLED = !"false".equals(System.getProperty("webmc.lowerIndy"));

    private static final String CONCAT_FACTORY = "java/lang/invoke/StringConcatFactory";
    private static final String BUILDER = "java/lang/StringBuilder";
    private static final String SWITCHES = "webmc/jdk/SwitchBootstraps";
    private static final int ACC_INTERFACE = 0x0200;
    private static final int INTEGER = 3;

    private Invokedynamics() {
    }

    static byte[] lower(byte[] in) throws IOException {
        if (!ENABLED || !(contains(in, "makeConcat") || contains(in, "typeSwitch") || contains(in, "enumSwitch"))) {
            return in;
        }
        Pool pool = new Pool(in);
        // Bootstrap method handles this class knows how to lower: kind per constant pool index.
        Map<Integer, String> kinds = new HashMap<Integer, String>();
        for (int i = 1; i < pool.originalCount; i++) {
            if (pool.tag(i) != METHOD_HANDLE) {
                continue;
            }
            int ref = pool.u2(i, 2);
            int refTag = pool.tag(ref);
            if (refTag != METHODREF && refTag != INTERFACE_METHODREF) {
                continue;
            }
            String owner = pool.className(pool.u2(ref, 1));
            String name = pool.memberName(ref);
            if (CONCAT_FACTORY.equals(owner) && ("makeConcatWithConstants".equals(name) || "makeConcat".equals(name))) {
                kinds.put(i, name);
            } else if ((SWITCHES.equals(owner) || "java/lang/runtime/SwitchBootstraps".equals(owner))
                    && ("typeSwitch".equals(name) || "enumSwitch".equals(name))) {
                kinds.put(i, name);
            }
        }
        if (kinds.isEmpty()) {
            return in;
        }
        byte[] rest = pool.rest();
        boolean isInterface = (u2(rest, 0) & ACC_INTERFACE) != 0;
        int thisClass = u2(rest, 2);
        int p = 6;
        p += 2 + u2(rest, p) * 2; // interfaces
        p = skipMembers(rest, p); // fields
        int methodsStart = p;
        int methodCount = u2(rest, p);
        int methodsEnd = skipMembers(rest, p);
        List<int[]> bootstraps = bootstrapMethods(pool, rest, methodsEnd);
        if (bootstraps == null) {
            return in;
        }

        Map<Integer, Integer> replaced = new HashMap<Integer, Integer>();
        ByteArrayOutputStream generated = new ByteArrayOutputStream();
        int generatedCount = 0;
        for (int i = 1; i < pool.originalCount; i++) {
            if (pool.tag(i) != INVOKE_DYNAMIC) {
                continue;
            }
            int bootstrapIndex = pool.u2(i, 1);
            if (bootstrapIndex >= bootstraps.size()) {
                continue;
            }
            int[] bootstrap = bootstraps.get(bootstrapIndex);
            String kind = kinds.get(bootstrap[0]);
            if (kind == null) {
                continue;
            }
            int nat = pool.u2(i, 3);
            String descriptor = pool.utf8(pool.u2(nat, 3));
            String name = "webmc$" + kind + "$" + i;
            byte[] code;
            int[] limits = new int[2];
            if (kind.startsWith("makeConcat")) {
                code = concat(pool, descriptor, kind.equals("makeConcat") ? null : bootstrap, limits);
            } else {
                code = typeSwitch(pool, descriptor, bootstrap, kind.equals("enumSwitch") ? "enumIndex" : "typeIndex", limits);
            }
            if (code == null) {
                continue;
            }
            generated.write(method(pool, name, descriptor, code, limits[0], limits[1]));
            generatedCount++;
            int ref = pool.add(NAME_AND_TYPE, pool.addUtf8(name), pool.addUtf8(descriptor));
            replaced.put(i, pool.add(isInterface ? INTERFACE_METHODREF : METHODREF, thisClass, ref));
        }
        if (replaced.isEmpty()) {
            return in;
        }
        rewriteCalls(rest, pool, methodsStart, replaced);

        ByteArrayOutputStream out = new ByteArrayOutputStream(in.length + generated.size() + 512);
        DataOutputStream data = new DataOutputStream(out);
        data.write(in, 0, 8);
        pool.write(data);
        data.write(rest, 0, methodsStart);
        data.writeShort(methodCount + generatedCount);
        data.write(rest, methodsStart + 2, methodsEnd - methodsStart - 2);
        generated.writeTo(data);
        data.write(rest, methodsEnd, rest.length - methodsEnd);
        data.flush();
        return out.toByteArray();
    }

    /** Each bootstrap method as {handle, arguments...}, or null when the class has none. */
    private static List<int[]> bootstrapMethods(Pool pool, byte[] rest, int methodsEnd) {
        int attributes = u2(rest, methodsEnd);
        int q = methodsEnd + 2;
        for (int a = 0; a < attributes; a++) {
            if ("BootstrapMethods".equals(pool.utf8(u2(rest, q)))) {
                List<int[]> bootstraps = new ArrayList<int[]>();
                int r = q + 8;
                for (int k = u2(rest, q + 6); k > 0; k--) {
                    int args = u2(rest, r + 2);
                    int[] entry = new int[args + 1];
                    entry[0] = u2(rest, r);
                    for (int j = 0; j < args; j++) {
                        entry[j + 1] = u2(rest, r + 4 + j * 2);
                    }
                    bootstraps.add(entry);
                    r += 4 + args * 2;
                }
                return bootstraps;
            }
            q += 6 + u4(rest, q + 2);
        }
        return null;
    }

    /**
     * {@code new StringBuilder().append(...)...toString()} following the recipe: \1 is the next
     * argument, \2 the next bootstrap constant, anything else literal text. Without a recipe
     * (makeConcat) every argument is appended.
     */
    private static byte[] concat(Pool pool, String descriptor, int[] bootstrap, int[] limits) throws IOException {
        List<String> args = parameterTypes(descriptor);
        if (args == null || !descriptor.endsWith(")Ljava/lang/String;")) {
            return null;
        }
        String recipe;
        if (bootstrap == null) {
            StringBuilder all = new StringBuilder();
            for (int k = 0; k < args.size(); k++) {
                all.append('\u0001');
            }
            recipe = all.toString();
        } else {
            if (bootstrap.length < 2 || pool.tag(bootstrap[1]) != STRING) {
                return null;
            }
            recipe = pool.utf8(pool.u2(bootstrap[1], 1));
        }
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        DataOutputStream code = new DataOutputStream(bytes);
        code.writeByte(0xbb); // new
        code.writeShort(pool.addClass(BUILDER));
        code.writeByte(0x59); // dup
        code.writeByte(0xb7); // invokespecial
        code.writeShort(pool.addMethodref(BUILDER, "<init>", "()V"));
        int appendString = pool.addMethodref(BUILDER, "append", "(Ljava/lang/String;)Ljava/lang/StringBuilder;");
        int arg = 0;
        int slot = 0;
        int constant = 2;
        StringBuilder literal = new StringBuilder();
        for (int k = 0; k <= recipe.length(); k++) {
            char c = k < recipe.length() ? recipe.charAt(k) : '\u0001';
            if (c != '\u0001' && c != '\u0002') {
                literal.append(c);
                continue;
            }
            if (c == '\u0002') {
                if (constant >= bootstrap.length) {
                    return null;
                }
                String value = constantText(pool, bootstrap[constant++]);
                if (value == null) {
                    return null;
                }
                literal.append(value);
                continue;
            }
            if (literal.length() > 0) {
                code.writeByte(0x13); // ldc_w
                code.writeShort(pool.addString(literal.toString()));
                code.writeByte(0xb6); // invokevirtual
                code.writeShort(appendString);
                literal.setLength(0);
            }
            if (k == recipe.length()) {
                break;
            }
            if (arg >= args.size()) {
                return null;
            }
            String type = args.get(arg++);
            char t = type.charAt(0);
            code.writeByte(loadOpcode(t, slot));
            code.writeByte(slot);
            slot += t == 'J' || t == 'D' ? 2 : 1;
            code.writeByte(0xb6); // invokevirtual
            code.writeShort(pool.addMethodref(BUILDER, "append", "(" + appendType(type) + ")Ljava/lang/StringBuilder;"));
        }
        if (arg != args.size() || slot > 255) {
            return null;
        }
        code.writeByte(0xb6);
        code.writeShort(pool.addMethodref(BUILDER, "toString", "()Ljava/lang/String;"));
        code.writeByte(0xb0); // areturn
        code.flush();
        limits[0] = 4;
        limits[1] = slot;
        return bytes.toByteArray();
    }

    /** The text of a string or integer constant (StringConcatFactory turns constants into text). */
    private static String constantText(Pool pool, int index) {
        int tag = pool.tag(index);
        if (tag == STRING) {
            return pool.utf8(pool.u2(index, 1));
        }
        if (tag == INTEGER) {
            byte[] e = pool.entries.get(index);
            return String.valueOf(((e[1] & 0xff) << 24) | ((e[2] & 0xff) << 16) | ((e[3] & 0xff) << 8) | (e[4] & 0xff));
        }
        return null;
    }

    /**
     * {@code SwitchBootstraps.typeIndex(selector, restart, new Object[] {labels...})}. Labels must
     * be classes, strings or integers.
     */
    private static byte[] typeSwitch(Pool pool, String descriptor, int[] bootstrap, String helper, int[] limits) throws IOException {
        List<String> args = parameterTypes(descriptor);
        if (args == null || args.size() != 2 || !"I".equals(args.get(1)) || !descriptor.endsWith(")I")
                || !(args.get(0).startsWith("L") || args.get(0).startsWith("["))) {
            return null;
        }
        int labels = bootstrap.length - 1;
        for (int k = 1; k <= labels; k++) {
            int tag = pool.tag(bootstrap[k]);
            if (tag != CLASS && tag != STRING && tag != INTEGER) {
                return null;
            }
        }
        if (labels > 32767) {
            return null;
        }
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        DataOutputStream code = new DataOutputStream(bytes);
        code.writeByte(0x2a); // aload_0
        code.writeByte(0x1b); // iload_1
        pushInt(code, labels);
        code.writeByte(0xbd); // anewarray
        code.writeShort(pool.addClass("java/lang/Object"));
        for (int k = 1; k <= labels; k++) {
            code.writeByte(0x59); // dup
            pushInt(code, k - 1);
            code.writeByte(0x13); // ldc_w
            code.writeShort(bootstrap[k]);
            if (pool.tag(bootstrap[k]) == INTEGER) {
                code.writeByte(INVOKESTATIC);
                code.writeShort(pool.addMethodref("java/lang/Integer", "valueOf", "(I)Ljava/lang/Integer;"));
            }
            code.writeByte(0x53); // aastore
        }
        code.writeByte(INVOKESTATIC);
        code.writeShort(pool.addMethodref(SWITCHES, helper, "(Ljava/lang/Object;I[Ljava/lang/Object;)I"));
        code.writeByte(0xac); // ireturn
        code.flush();
        limits[0] = 6;
        limits[1] = 2;
        return bytes.toByteArray();
    }

    private static void pushInt(DataOutputStream code, int value) throws IOException {
        if (value <= 5) {
            code.writeByte(0x03 + value); // iconst_<n>
        } else if (value <= 127) {
            code.writeByte(0x10); // bipush
            code.writeByte(value);
        } else {
            code.writeByte(0x11); // sipush
            code.writeShort(value);
        }
    }

    /** A private static synthetic method_info with the given code. */
    private static byte[] method(Pool pool, String name, String descriptor, byte[] code, int maxStack, int maxLocals) throws IOException {
        ByteArrayOutputStream method = new ByteArrayOutputStream();
        DataOutputStream m = new DataOutputStream(method);
        m.writeShort(0x0002 | 0x0008 | 0x1000); // private static synthetic
        m.writeShort(pool.addUtf8(name));
        m.writeShort(pool.addUtf8(descriptor));
        m.writeShort(1);
        m.writeShort(pool.addUtf8("Code"));
        m.writeInt(2 + 2 + 4 + code.length + 2 + 2);
        m.writeShort(maxStack);
        m.writeShort(maxLocals);
        m.writeInt(code.length);
        m.write(code);
        m.writeShort(0); // exception table
        m.writeShort(0); // attributes
        m.flush();
        return method.toByteArray();
    }

    private static void rewriteCalls(byte[] b, Pool pool, int methodsStart, Map<Integer, Integer> replaced) {
        int p = methodsStart;
        int methods = u2(b, p);
        p += 2;
        for (int m = 0; m < methods; m++) {
            int attributes = u2(b, p + 6);
            p += 8;
            for (int a = 0; a < attributes; a++) {
                int length = u4(b, p + 2);
                if ("Code".equals(pool.utf8(u2(b, p)))) {
                    int codeLength = u4(b, p + 10);
                    int code = p + 14;
                    for (int pc = 0; pc < codeLength; pc += instructionLength(b, code, pc)) {
                        if ((b[code + pc] & 0xff) != INVOKEDYNAMIC) {
                            continue;
                        }
                        Integer target = replaced.get(u2(b, code + pc + 1));
                        if (target != null) {
                            b[code + pc] = (byte) INVOKESTATIC;
                            b[code + pc + 1] = (byte) (target >> 8);
                            b[code + pc + 2] = (byte) (int) target;
                            b[code + pc + 3] = 0; // nop
                            b[code + pc + 4] = 0; // nop
                        }
                    }
                }
                p += 6 + length;
            }
        }
    }

    /** Parameter types of a method descriptor, or null when it cannot be parsed. */
    static List<String> parameterTypes(String descriptor) {
        if (!descriptor.startsWith("(")) {
            return null;
        }
        List<String> types = new ArrayList<String>();
        int k = 1;
        while (k < descriptor.length() && descriptor.charAt(k) != ')') {
            int start = k;
            while (descriptor.charAt(k) == '[') {
                k++;
            }
            if (descriptor.charAt(k) == 'L') {
                k = descriptor.indexOf(';', k);
                if (k < 0) {
                    return null;
                }
            }
            k++;
            types.add(descriptor.substring(start, k));
        }
        return k < descriptor.length() ? types : null;
    }

    private static int loadOpcode(char type, int slot) {
        switch (type) {
            case 'J': return 0x16; // lload
            case 'F': return 0x17; // fload
            case 'D': return 0x18; // dload
            case 'L': case '[': return 0x19; // aload
            default: return 0x15; // iload
        }
    }

    /** The StringBuilder.append overload StringConcatFactory's conversion matches. */
    private static String appendType(String type) {
        switch (type.charAt(0)) {
            case 'J': case 'F': case 'D': case 'Z': case 'C': return type;
            case 'B': case 'S': case 'I': return "I";
            default: return "java/lang/String".equals(type.substring(1, type.length() - 1)) ? "Ljava/lang/String;" : "Ljava/lang/Object;";
        }
    }
}
