package webmc;

import java.io.ByteArrayOutputStream;
import java.io.DataOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.lang.reflect.Method;
import java.security.ProtectionDomain;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Works around a CheerpJ 4.3 bug: the NullPointerException raised by {@code getfield} on a
 * null reference is not delivered to a matching {@code catch (NullPointerException)} block,
 * while NPEs raised by method calls are. Minecraft 1.8 - 1.12.2 relies on such a catch in
 * ModelBlock.checkModelHierarchy and crashes while loading block models.
 *
 * <p>For every method that catches NullPointerException, each {@code getfield} is replaced by
 * {@code invokestatic} of a generated private static accessor that performs the same read.
 * Both instructions are 3 bytes long with the same stack effect, so offsets, exception
 * tables and stack map frames stay valid. The patched class is defined in the system class
 * loader before the game loads it. The game's files on disk are never modified.
 */
final class NpePatcher {
    private static final int GETFIELD = 0xb4;
    private static final int INVOKESTATIC = 0xb8;

    private NpePatcher() {
    }

    /**
     * Patches and pre-defines the given root-package classes (comma separated). They are
     * defined with the protection domain of {@code jarClass} (a class from the same jar), so
     * they carry the same code source and signers as the rest of the signed client jar.
     */
    static void patchAll(String classNames, String jarClass) {
        ProtectionDomain domain;
        try {
            domain = Class.forName(jarClass, false, ClassLoader.getSystemClassLoader()).getProtectionDomain();
        } catch (Throwable t) {
            System.err.println("[webmc] cannot patch classes, " + jarClass + " not found: " + t);
            return;
        }
        for (String name : classNames.split(",")) {
            name = name.trim();
            if (name.isEmpty()) {
                continue;
            }
            try {
                byte[] original = readResource(name + ".class");
                byte[] patched = new NpePatcher().patch(original);
                if (patched != null) {
                    define(name.replace('/', '.'), patched, domain);
                    System.out.println("[webmc] patched NullPointerException handling in " + name);
                }
            } catch (Throwable t) {
                System.err.println("[webmc] could not patch " + name + ": " + t);
            }
        }
    }

    /** The patched class, or null when it has no field reads to protect. */
    static byte[] patchClass(byte[] bytes) throws IOException {
        return new NpePatcher().patch(bytes.clone());
    }

    private static byte[] readResource(String path) throws IOException {
        InputStream in = ClassLoader.getSystemResourceAsStream(path);
        if (in == null) {
            throw new IOException("not found: " + path);
        }
        try {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buffer = new byte[8192];
            int n;
            while ((n = in.read(buffer)) > 0) {
                out.write(buffer, 0, n);
            }
            return out.toByteArray();
        } finally {
            in.close();
        }
    }

    private static void define(String name, byte[] bytes, ProtectionDomain domain) throws Exception {
        Method define = ClassLoader.class.getDeclaredMethod("defineClass",
                String.class, byte[].class, int.class, int.class, ProtectionDomain.class);
        define.setAccessible(true);
        define.invoke(ClassLoader.getSystemClassLoader(), name, bytes, 0, bytes.length, domain);
    }

    // ---------------------------------------------------------------------------------
    // Minimal class file rewriting
    // ---------------------------------------------------------------------------------
    private byte[] in;
    private int pos;
    private final List<byte[]> pool = new ArrayList<byte[]>(); // raw entries, index = cp index
    private final List<Integer> poolTags = new ArrayList<Integer>();
    private final ByteArrayOutputStream extraPool = new ByteArrayOutputStream();
    private int poolCount;
    private int thisClass;
    private final Map<Integer, Integer> accessorForField = new HashMap<Integer, Integer>();
    private final List<byte[]> accessorMethods = new ArrayList<byte[]>();
    private final Map<String, Integer> utf8Index = new HashMap<String, Integer>();

    private int u1() {
        return in[pos++] & 0xff;
    }

    private int u2() {
        return (u1() << 8) | u1();
    }

    private int u4() {
        return (u2() << 16) | u2();
    }

    private static int u2(byte[] b, int at) {
        return ((b[at] & 0xff) << 8) | (b[at + 1] & 0xff);
    }

    private static int u4(byte[] b, int at) {
        return (u2(b, at) << 16) | u2(b, at + 2);
    }

    private byte[] patch(byte[] classBytes) throws IOException {
        in = classBytes;
        pos = 8;
        poolCount = u2();
        pool.add(null);
        poolTags.add(0);
        for (int i = 1; i < poolCount; i++) {
            int start = pos;
            int tag = u1();
            switch (tag) {
                case 1: {
                    int length = u2();
                    pos += length;
                    break;
                }
                case 7: case 8: case 16: case 19: case 20:
                    pos += 2;
                    break;
                case 15:
                    pos += 3;
                    break;
                case 3: case 4: case 9: case 10: case 11: case 12: case 17: case 18:
                    pos += 4;
                    break;
                case 5: case 6:
                    pos += 8;
                    break;
                default:
                    throw new IOException("Unknown constant pool tag " + tag);
            }
            byte[] entry = new byte[pos - start];
            System.arraycopy(in, start, entry, 0, entry.length);
            pool.add(entry);
            poolTags.add(tag);
            if (tag == 1) {
                utf8Index.put(utf8(i), i);
            }
            if (tag == 5 || tag == 6) {
                pool.add(null);
                poolTags.add(0);
                i++;
            }
        }
        int npeClass = findClass("java/lang/NullPointerException");
        if (npeClass == 0) {
            return null;
        }
        int poolEnd = pos;
        pos += 2; // access flags
        thisClass = u2();
        pos += 2; // super class
        int interfaces = u2();
        pos += interfaces * 2;
        skipMembers(); // fields
        int methodsStart = pos;
        int methodCount = u2();
        boolean changed = false;
        for (int m = 0; m < methodCount; m++) {
            pos += 6;
            int attributes = u2();
            for (int a = 0; a < attributes; a++) {
                String name = utf8(u2());
                int length = u4();
                int attributeEnd = pos + length;
                if ("Code".equals(name) && catches(pos, npeClass)) {
                    changed |= rewriteCode(pos);
                }
                pos = attributeEnd;
            }
        }
        if (!changed) {
            return null;
        }
        int methodsEnd = pos;

        ByteArrayOutputStream out = new ByteArrayOutputStream(in.length + 512);
        DataOutputStream data = new DataOutputStream(out);
        data.write(in, 0, 8);
        data.writeShort(poolCount);
        data.write(in, 10, poolEnd - 10);
        extraPool.writeTo(data);
        data.write(in, poolEnd, methodsStart - poolEnd);
        data.writeShort(methodCount + accessorMethods.size());
        data.write(in, methodsStart + 2, methodsEnd - methodsStart - 2);
        for (byte[] method : accessorMethods) {
            data.write(method);
        }
        data.write(in, methodsEnd, in.length - methodsEnd);
        data.flush();
        return out.toByteArray();
    }

    private void skipMembers() {
        int count = u2();
        for (int i = 0; i < count; i++) {
            pos += 6;
            int attributes = u2();
            for (int a = 0; a < attributes; a++) {
                pos += 2;
                int length = u4();
                pos += length;
            }
        }
    }

    private String utf8(int index) {
        byte[] entry = pool.get(index);
        int length = u2(entry, 1);
        try {
            return new String(entry, 3, length, "UTF-8");
        } catch (IOException e) {
            throw new IllegalStateException(e);
        }
    }

    private int findClass(String name) {
        for (int i = 1; i < pool.size(); i++) {
            if (poolTags.get(i) == 7 && name.equals(utf8(u2(pool.get(i), 1)))) {
                return i;
            }
        }
        return 0;
    }

    /** codeAttr points at max_stack of a Code attribute. */
    private boolean catches(int codeAttr, int npeClass) {
        int codeLength = u4(in, codeAttr + 4);
        int table = codeAttr + 8 + codeLength;
        int handlers = u2(in, table);
        for (int h = 0; h < handlers; h++) {
            if (u2(in, table + 2 + h * 8 + 6) == npeClass) {
                return true;
            }
        }
        return false;
    }

    private boolean rewriteCode(int codeAttr) throws IOException {
        int codeLength = u4(in, codeAttr + 4);
        int code = codeAttr + 8;
        boolean changed = false;
        int pc = 0;
        while (pc < codeLength) {
            int opcode = in[code + pc] & 0xff;
            if (opcode == GETFIELD) {
                int fieldRef = u2(in, code + pc + 1);
                int accessor = accessorFor(fieldRef);
                in[code + pc] = (byte) INVOKESTATIC;
                in[code + pc + 1] = (byte) (accessor >> 8);
                in[code + pc + 2] = (byte) accessor;
                changed = true;
            }
            pc += instructionLength(code, pc);
        }
        return changed;
    }

    /** Returns the Methodref index of a static accessor reading the given field. */
    private int accessorFor(int fieldRef) throws IOException {
        Integer existing = accessorForField.get(fieldRef);
        if (existing != null) {
            return existing;
        }
        byte[] ref = pool.get(fieldRef);
        int ownerClass = u2(ref, 1);
        byte[] nameAndType = pool.get(u2(ref, 3));
        String fieldName = utf8(u2(nameAndType, 1));
        String fieldType = utf8(u2(nameAndType, 3));
        String owner = utf8(u2(pool.get(ownerClass), 1));
        String descriptor = "(L" + owner + ";)" + fieldType;
        String name = "webmc$get$" + accessorForField.size() + "$" + fieldName;

        int nameIndex = addUtf8(name);
        int descriptorIndex = addUtf8(descriptor);
        int nat = addEntry(12, nameIndex, descriptorIndex);
        int methodRef = addEntry(10, thisClass, nat);
        int codeIndex = addUtf8("Code");

        char type = fieldType.charAt(0);
        boolean wide = type == 'J' || type == 'D';
        int returnOp = type == 'L' || type == '[' ? 0xb0 : type == 'J' ? 0xad : type == 'F' ? 0xae : type == 'D' ? 0xaf : 0xac;

        ByteArrayOutputStream method = new ByteArrayOutputStream();
        DataOutputStream m = new DataOutputStream(method);
        m.writeShort(0x0002 | 0x0008 | 0x1000); // private static synthetic
        m.writeShort(nameIndex);
        m.writeShort(descriptorIndex);
        m.writeShort(1); // attributes
        m.writeShort(codeIndex);
        m.writeInt(2 + 2 + 4 + 5 + 2 + 2); // Code attribute length
        m.writeShort(wide ? 2 : 1); // max_stack
        m.writeShort(1); // max_locals
        m.writeInt(5); // code length
        m.writeByte(0x2a); // aload_0
        m.writeByte(GETFIELD);
        m.writeShort(fieldRef);
        m.writeByte(returnOp);
        m.writeShort(0); // exception table
        m.writeShort(0); // attributes
        m.flush();
        accessorMethods.add(method.toByteArray());
        accessorForField.put(fieldRef, methodRef);
        return methodRef;
    }

    private int addUtf8(String value) throws IOException {
        Integer existing = utf8Index.get(value);
        if (existing != null) {
            return existing;
        }
        DataOutputStream d = new DataOutputStream(extraPool);
        d.writeByte(1);
        d.writeUTF(value);
        d.flush();
        int index = poolCount++;
        utf8Index.put(value, index);
        return index;
    }

    private int addEntry(int tag, int a, int b) throws IOException {
        DataOutputStream d = new DataOutputStream(extraPool);
        d.writeByte(tag);
        d.writeShort(a);
        d.writeShort(b);
        d.flush();
        return poolCount++;
    }

    /** Length in bytes of the instruction at pc (code points at the start of the bytecode). */
    private int instructionLength(int code, int pc) {
        int opcode = in[code + pc] & 0xff;
        switch (opcode) {
            case 0xaa: { // tableswitch
                int p = pc + 1 + ((4 - (pc + 1) % 4) % 4);
                int low = u4(in, code + p + 4);
                int high = u4(in, code + p + 8);
                return p - pc + 12 + (high - low + 1) * 4;
            }
            case 0xab: { // lookupswitch
                int p = pc + 1 + ((4 - (pc + 1) % 4) % 4);
                int pairs = u4(in, code + p + 4);
                return p - pc + 8 + pairs * 8;
            }
            case 0xc4: // wide
                return (in[code + pc + 1] & 0xff) == 0x84 ? 6 : 4;
            default:
                return LENGTHS[opcode];
        }
    }

    private static final int[] LENGTHS = new int[256];

    static {
        java.util.Arrays.fill(LENGTHS, 1);
        int[] two = {0x10, 0x12, 0x15, 0x16, 0x17, 0x18, 0x19, 0x36, 0x37, 0x38, 0x39, 0x3a, 0xa9, 0xbc};
        int[] three = {0x11, 0x13, 0x14, 0x84, 0x99, 0x9a, 0x9b, 0x9c, 0x9d, 0x9e, 0x9f, 0xa0, 0xa1, 0xa2, 0xa3,
            0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xbb, 0xbd, 0xc0, 0xc1, 0xc6, 0xc7};
        for (int op : two) {
            LENGTHS[op] = 2;
        }
        for (int op : three) {
            LENGTHS[op] = 3;
        }
        LENGTHS[0xb9] = 5; // invokeinterface
        LENGTHS[0xba] = 5; // invokedynamic
        LENGTHS[0xc5] = 4; // multianewarray
        LENGTHS[0xc8] = 5; // goto_w
        LENGTHS[0xc9] = 5; // jsr_w
    }
}
