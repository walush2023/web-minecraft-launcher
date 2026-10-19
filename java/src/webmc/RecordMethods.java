package webmc;

import static webmc.ClassFiles.INTERFACE_METHODREF;
import static webmc.ClassFiles.INVOKEDYNAMIC;
import static webmc.ClassFiles.INVOKESTATIC;
import static webmc.ClassFiles.INVOKE_DYNAMIC;
import static webmc.ClassFiles.METHODREF;
import static webmc.ClassFiles.METHOD_HANDLE;
import static webmc.ClassFiles.NAME_AND_TYPE;
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
 * Gives records plain-bytecode hashCode/equals/toString.
 *
 * <p>javac implements them with an invokedynamic call to
 * {@code java.lang.runtime.ObjectMethods.bootstrap}. In CheerpJ 4.3 that bootstrap throws
 * {@code ClassNotFoundException: ""} for records with array components, which crashes Minecraft
 * 1.17+ during world generation. Each such call is replaced by {@code invokestatic} of a private
 * static method added to the record (the 5-byte invokedynamic becomes invokestatic plus two
 * {@code nop}s, so no offset moves). The methods compute what ObjectMethods computes; they are
 * straight-line code, with {@code webmc.jdk.Records} doing the comparisons, so they need no
 * stack map frames. Plain bytecode is also much faster than the method-handle chains.
 */
final class RecordMethods {
    private static final String OBJECT_METHODS = "java/lang/runtime/ObjectMethods";
    private static final String RECORDS = "webmc/jdk/Records";
    private static final String BUILDER = "java/lang/StringBuilder";
    private static final int GETFIELD = 0xb4;

    private RecordMethods() {
    }

    static byte[] inline(byte[] in) throws IOException {
        if (!contains(in, OBJECT_METHODS)) {
            return in;
        }
        Pool pool = new Pool(in);
        List<Integer> bootstrapHandles = new ArrayList<Integer>();
        for (int i = 1; i < pool.originalCount; i++) {
            if (pool.tag(i) != METHOD_HANDLE) {
                continue;
            }
            int ref = pool.u2(i, 2);
            int refTag = pool.tag(ref);
            if ((refTag == METHODREF || refTag == INTERFACE_METHODREF)
                    && OBJECT_METHODS.equals(pool.className(pool.u2(ref, 1))) && "bootstrap".equals(pool.memberName(ref))) {
                bootstrapHandles.add(i);
            }
        }
        if (bootstrapHandles.isEmpty()) {
            return in;
        }
        byte[] rest = pool.rest();
        int thisClass = u2(rest, 2);
        int p = 6;
        p += 2 + u2(rest, p) * 2; // interfaces
        p = skipMembers(rest, p); // fields
        int methodsStart = p;
        int methodCount = u2(rest, p);
        int methodsEnd = skipMembers(rest, p);
        int attributes = u2(rest, methodsEnd);
        int q = methodsEnd + 2;
        int bootstrapAttribute = -1;
        for (int a = 0; a < attributes; a++) {
            if ("BootstrapMethods".equals(pool.utf8(u2(rest, q)))) {
                bootstrapAttribute = q;
            }
            q += 6 + u4(rest, q + 2);
        }
        if (bootstrapAttribute < 0) {
            return in;
        }
        List<int[]> bootstraps = new ArrayList<int[]>();
        int r = bootstrapAttribute + 8;
        for (int k = u2(rest, bootstrapAttribute + 6); k > 0; k--) {
            int args = u2(rest, r + 2);
            int[] entry = new int[args + 1];
            entry[0] = u2(rest, r);
            for (int j = 0; j < args; j++) {
                entry[j + 1] = u2(rest, r + 4 + j * 2);
            }
            bootstraps.add(entry);
            r += 4 + args * 2;
        }

        Map<Integer, Integer> replaced = new HashMap<Integer, Integer>();
        Map<String, Integer> made = new HashMap<String, Integer>();
        ByteArrayOutputStream generated = new ByteArrayOutputStream();
        int generatedCount = 0;
        for (int i = 1; i < pool.originalCount; i++) {
            if (pool.tag(i) != INVOKE_DYNAMIC) {
                continue;
            }
            int bootstrapIndex = pool.u2(i, 1);
            int[] bootstrap = bootstraps.get(bootstrapIndex);
            if (!bootstrapHandles.contains(bootstrap[0])) {
                continue;
            }
            int nat = pool.u2(i, 3);
            String operation = pool.utf8(pool.u2(nat, 1));
            String descriptor = pool.utf8(pool.u2(nat, 3));
            String key = bootstrapIndex + ":" + operation + descriptor;
            Integer method = made.get(key);
            if (method == null) {
                String name = "webmc$" + operation + "$" + bootstrapIndex;
                byte[] body = generate(pool, operation, descriptor, bootstrap, name);
                if (body == null) {
                    continue;
                }
                generated.write(body);
                generatedCount++;
                method = pool.add(METHODREF, thisClass, pool.add(NAME_AND_TYPE, pool.addUtf8(name), pool.addUtf8(descriptor)));
                made.put(key, method);
            }
            replaced.put(i, method);
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

    /** A complete method_info, or null for an operation ObjectMethods does not define. */
    private static byte[] generate(Pool pool, String operation, String descriptor, int[] bootstrap, String name) throws IOException {
        if (bootstrap.length < 3) {
            return null;
        }
        int recordClass = bootstrap[1];
        String[] names = pool.tag(bootstrap[2]) == ClassFiles.STRING ? pool.utf8(pool.u2(bootstrap[2], 1)).split(";", -1) : new String[0];
        int fields = bootstrap.length - 3;
        int[] fieldRefs = new int[fields];
        char[] types = new char[fields];
        for (int f = 0; f < fields; f++) {
            int handle = bootstrap[f + 3];
            if (pool.tag(handle) != METHOD_HANDLE || pool.entries.get(handle)[1] != 1 /* REF_getField */) {
                return null;
            }
            fieldRefs[f] = pool.u2(handle, 2);
            types[f] = pool.memberDescriptor(fieldRefs[f]).charAt(0);
        }
        ByteArrayOutputStream codeBytes = new ByteArrayOutputStream();
        DataOutputStream code = new DataOutputStream(codeBytes);
        int maxStack;
        int maxLocals;
        if ("hashCode".equals(operation) && descriptor.endsWith(")I")) {
            code.writeByte(0x03); // iconst_0
            for (int f = 0; f < fields; f++) {
                code.writeByte(0x10); // bipush 31
                code.writeByte(31);
                code.writeByte(0x68); // imul
                code.writeByte(0x2a); // aload_0
                code.writeByte(GETFIELD);
                code.writeShort(fieldRefs[f]);
                code.writeByte(INVOKESTATIC);
                code.writeShort(hashMethod(pool, types[f]));
                code.writeByte(0x60); // iadd
            }
            code.writeByte(0xac); // ireturn
            maxStack = 3;
            maxLocals = 1;
        } else if ("equals".equals(operation) && descriptor.endsWith(")Z")) {
            // Records are final, so instanceof is the same-class test (and false for null).
            code.writeByte(0x2b); // aload_1
            code.writeByte(0xc1); // instanceof
            code.writeShort(recordClass);
            code.writeByte(0x2b); // aload_1
            code.writeByte(0x2a); // aload_0
            code.writeByte(0x2b); // aload_1
            code.writeByte(0xc1); // instanceof
            code.writeShort(recordClass);
            code.writeByte(INVOKESTATIC);
            code.writeShort(pool.addMethodref(RECORDS, "pick", "(Ljava/lang/Object;Ljava/lang/Object;Z)Ljava/lang/Object;"));
            code.writeByte(0xc0); // checkcast
            code.writeShort(recordClass);
            code.writeByte(0x4d); // astore_2
            for (int f = 0; f < fields; f++) {
                code.writeByte(0x2a); // aload_0
                code.writeByte(GETFIELD);
                code.writeShort(fieldRefs[f]);
                code.writeByte(0x2c); // aload_2
                code.writeByte(GETFIELD);
                code.writeShort(fieldRefs[f]);
                code.writeByte(INVOKESTATIC);
                code.writeShort(pool.addMethodref(RECORDS, "eq", "(" + stackType(types[f]) + stackType(types[f]) + ")Z"));
                code.writeByte(0x7e); // iand
            }
            code.writeByte(0xac); // ireturn
            maxStack = 5;
            maxLocals = 3;
        } else if ("toString".equals(operation) && descriptor.endsWith(")Ljava/lang/String;")) {
            String simpleName = simpleName(pool.className(recordClass));
            int appendString = pool.addMethodref(BUILDER, "append", "(Ljava/lang/String;)Ljava/lang/StringBuilder;");
            code.writeByte(0xbb); // new
            code.writeShort(pool.addClass(BUILDER));
            code.writeByte(0x59); // dup
            code.writeByte(0x13); // ldc_w
            code.writeShort(pool.addString(simpleName + "["));
            code.writeByte(0xb7); // invokespecial
            code.writeShort(pool.addMethodref(BUILDER, "<init>", "(Ljava/lang/String;)V"));
            for (int f = 0; f < fields; f++) {
                code.writeByte(0x13); // ldc_w
                code.writeShort(pool.addString((f == 0 ? "" : ", ") + (f < names.length ? names[f] : "") + "="));
                code.writeByte(0xb6); // invokevirtual
                code.writeShort(appendString);
                code.writeByte(0x2a); // aload_0
                code.writeByte(GETFIELD);
                code.writeShort(fieldRefs[f]);
                code.writeByte(0xb6);
                code.writeShort(pool.addMethodref(BUILDER, "append", "(" + appendType(types[f]) + ")Ljava/lang/StringBuilder;"));
            }
            code.writeByte(0x13);
            code.writeShort(pool.addString("]"));
            code.writeByte(0xb6);
            code.writeShort(appendString);
            code.writeByte(0xb6);
            code.writeShort(pool.addMethodref(BUILDER, "toString", "()Ljava/lang/String;"));
            code.writeByte(0xb0); // areturn
            maxStack = 3;
            maxLocals = 1;
        } else {
            return null;
        }
        code.flush();
        byte[] bytes = codeBytes.toByteArray();
        ByteArrayOutputStream method = new ByteArrayOutputStream();
        DataOutputStream m = new DataOutputStream(method);
        m.writeShort(0x0002 | 0x0008 | 0x1000); // private static synthetic
        m.writeShort(pool.addUtf8(name));
        m.writeShort(pool.addUtf8(descriptor));
        m.writeShort(1);
        m.writeShort(pool.addUtf8("Code"));
        m.writeInt(2 + 2 + 4 + bytes.length + 2 + 2);
        m.writeShort(maxStack);
        m.writeShort(maxLocals);
        m.writeInt(bytes.length);
        m.write(bytes);
        m.writeShort(0); // exception table
        m.writeShort(0); // attributes
        m.flush();
        return method.toByteArray();
    }

    private static int hashMethod(Pool pool, char type) throws IOException {
        switch (type) {
            case 'I': return pool.addMethodref("java/lang/Integer", "hashCode", "(I)I");
            case 'J': return pool.addMethodref("java/lang/Long", "hashCode", "(J)I");
            case 'F': return pool.addMethodref("java/lang/Float", "hashCode", "(F)I");
            case 'D': return pool.addMethodref("java/lang/Double", "hashCode", "(D)I");
            case 'Z': return pool.addMethodref("java/lang/Boolean", "hashCode", "(Z)I");
            case 'B': return pool.addMethodref("java/lang/Byte", "hashCode", "(B)I");
            case 'S': return pool.addMethodref("java/lang/Short", "hashCode", "(S)I");
            case 'C': return pool.addMethodref("java/lang/Character", "hashCode", "(C)I");
            default: return pool.addMethodref("java/util/Objects", "hashCode", "(Ljava/lang/Object;)I");
        }
    }

    /** The webmc.jdk.Records.eq parameter type for a field type. */
    private static String stackType(char type) {
        switch (type) {
            case 'J': return "J";
            case 'F': return "F";
            case 'D': return "D";
            case 'L': case '[': return "Ljava/lang/Object;";
            default: return "I";
        }
    }

    private static String appendType(char type) {
        switch (type) {
            case 'J': case 'F': case 'D': case 'Z': case 'C': return String.valueOf(type);
            case 'L': case '[': return "Ljava/lang/Object;";
            default: return "I";
        }
    }

    /** Class.getSimpleName() for a member or top-level class (local records: digits removed). */
    static String simpleName(String internalName) {
        String name = internalName.substring(internalName.lastIndexOf('/') + 1);
        name = name.substring(name.lastIndexOf('$') + 1);
        int i = 0;
        while (i < name.length() - 1 && Character.isDigit(name.charAt(i))) {
            i++;
        }
        return name.substring(i);
    }
}
