package webmc;

import static webmc.ClassFiles.instructionLength;
import static webmc.ClassFiles.u2;
import static webmc.ClassFiles.u4;

import java.io.ByteArrayOutputStream;
import java.io.DataOutputStream;
import java.io.IOException;

/**
 * Inserts {@code webmc.jdk.Sched.tick()} at the start of every method that contains a loop (a
 * backward branch), so long-running game threads yield regularly (see {@link webmc.jdk.Sched}).
 *
 * <p>The inserted code is {@code invokestatic; nop}: four bytes, so tableswitch/lookupswitch
 * padding is unchanged. Everything that refers to code offsets moves by four: the exception
 * table, LineNumberTable, LocalVariable(Type)Table, the first StackMapTable frame and
 * {@code uninitialized} verification types. Methods with other code attributes are left alone.
 */
final class TimeSlices {
    private static final int SHIFT = 4;

    private TimeSlices() {
    }

    /** Packages (internal name prefixes) whose methods get no yield points: -Dwebmc.timeSlicesSkip=a/,b/ */
    private static final String[] SKIP = System.getProperty("webmc.timeSlicesSkip", "").isEmpty()
        ? new String[0] : System.getProperty("webmc.timeSlicesSkip").split(",");

    /** Whether the class belongs to the game (obfuscated classes have no package). */
    static boolean isGameClass(String internalName) {
        for (String prefix : SKIP) {
            if (internalName.startsWith(prefix)) {
                return false;
            }
        }
        return internalName.indexOf('/') < 0 || internalName.startsWith("net/minecraft/") || internalName.startsWith("com/mojang/");
    }

    static byte[] instrument(byte[] in) throws IOException {
        Pool pool = new Pool(in);
        byte[] rest = pool.rest();
        int p = 6;
        p += 2 + u2(rest, p) * 2; // interfaces
        p = ClassFiles.skipMembers(rest, p); // fields
        int methodsStart = p;
        int methodCount = u2(rest, p);
        p += 2;
        int tick = 0;
        ByteArrayOutputStream methods = new ByteArrayOutputStream(rest.length + 1024);
        DataOutputStream out = new DataOutputStream(methods);
        boolean changed = false;
        for (int m = 0; m < methodCount; m++) {
            int attributes = u2(rest, p + 6);
            out.write(rest, p, 8);
            p += 8;
            for (int a = 0; a < attributes; a++) {
                int length = u4(rest, p + 2);
                byte[] rewritten = null;
                if ("Code".equals(pool.utf8(u2(rest, p))) && hasLoop(rest, p)) {
                    if (tick == 0) {
                        tick = pool.addMethodref("webmc/jdk/Sched", "tick", "()V");
                    }
                    rewritten = rewriteCode(rest, p, pool, tick);
                }
                if (rewritten != null) {
                    out.write(rewritten);
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
        out.flush();
        int methodsEnd = p;
        ByteArrayOutputStream result = new ByteArrayOutputStream(in.length + methods.size() - (methodsEnd - methodsStart) + 256);
        DataOutputStream data = new DataOutputStream(result);
        data.write(in, 0, 8);
        pool.write(data);
        data.write(rest, 0, methodsStart);
        data.writeShort(methodCount);
        methods.writeTo(data);
        data.write(rest, methodsEnd, rest.length - methodsEnd);
        data.flush();
        return result.toByteArray();
    }

    /** a points at a Code attribute (its name index). */
    private static boolean hasLoop(byte[] b, int a) {
        int codeLength = u4(b, a + 10);
        int code = a + 14;
        for (int pc = 0; pc < codeLength; pc += instructionLength(b, code, pc)) {
            int op = b[code + pc] & 0xff;
            if ((op >= 0x99 && op <= 0xa7) || op == 0xc6 || op == 0xc7) {
                if ((short) u2(b, code + pc + 1) < 0) {
                    return true;
                }
            } else if (op == 0xc8 && u4(b, code + pc + 1) < 0) {
                return true;
            }
        }
        return false;
    }

    /** Returns the complete rewritten Code attribute, or null when it cannot be rewritten safely. */
    private static byte[] rewriteCode(byte[] b, int a, Pool pool, int tick) throws IOException {
        int maxStack = u2(b, a + 6);
        int maxLocals = u2(b, a + 8);
        int codeLength = u4(b, a + 10);
        if (codeLength + SHIFT > 65535) {
            return null;
        }
        int code = a + 14;
        int q = code + codeLength;
        int handlers = u2(b, q);
        int handlersStart = q + 2;
        q = handlersStart + handlers * 8;
        int subCount = u2(b, q);
        q += 2;
        ByteArrayOutputStream subs = new ByteArrayOutputStream();
        DataOutputStream s = new DataOutputStream(subs);
        for (int i = 0; i < subCount; i++) {
            String name = pool.utf8(u2(b, q));
            int length = u4(b, q + 2);
            int body = q + 6;
            if ("LineNumberTable".equals(name)) {
                s.write(b, q, 6);
                int n = u2(b, body);
                s.writeShort(n);
                for (int k = 0; k < n; k++) {
                    int startPc = u2(b, body + 2 + k * 4);
                    s.writeShort(startPc == 0 ? 0 : startPc + SHIFT);
                    s.writeShort(u2(b, body + 4 + k * 4));
                }
            } else if ("LocalVariableTable".equals(name) || "LocalVariableTypeTable".equals(name)) {
                s.write(b, q, 6);
                int n = u2(b, body);
                s.writeShort(n);
                for (int k = 0; k < n; k++) {
                    int e = body + 2 + k * 10;
                    int startPc = u2(b, e);
                    int len = u2(b, e + 2);
                    s.writeShort(startPc == 0 ? 0 : startPc + SHIFT);
                    s.writeShort(startPc == 0 ? len + SHIFT : len);
                    s.write(b, e + 4, 6);
                }
            } else if ("StackMapTable".equals(name)) {
                byte[] frames = shiftFrames(b, body, length);
                if (frames == null) {
                    return null;
                }
                s.writeShort(u2(b, q));
                s.writeInt(frames.length);
                s.write(frames);
            } else {
                return null; // e.g. type annotations with code offsets
            }
            q = body + length;
        }
        s.flush();

        ByteArrayOutputStream attr = new ByteArrayOutputStream(codeLength + 64 + subs.size());
        DataOutputStream d = new DataOutputStream(attr);
        d.writeShort(u2(b, a));
        d.writeInt(2 + 2 + 4 + codeLength + SHIFT + 2 + handlers * 8 + 2 + subs.size());
        d.writeShort(maxStack);
        d.writeShort(maxLocals);
        d.writeInt(codeLength + SHIFT);
        d.writeByte(ClassFiles.INVOKESTATIC);
        d.writeShort(tick);
        d.writeByte(0); // nop
        d.write(b, code, codeLength);
        d.writeShort(handlers);
        for (int h = 0; h < handlers; h++) {
            int e = handlersStart + h * 8;
            d.writeShort(u2(b, e) + SHIFT);
            d.writeShort(u2(b, e + 2) + SHIFT);
            d.writeShort(u2(b, e + 4) + SHIFT);
            d.writeShort(u2(b, e + 6));
        }
        d.writeShort(subCount);
        subs.writeTo(d);
        d.flush();
        return attr.toByteArray();
    }

    /** The StackMapTable body with the first frame moved by SHIFT and uninitialized offsets fixed. */
    private static byte[] shiftFrames(byte[] b, int body, int length) throws IOException {
        int count = u2(b, body);
        int p = body + 2;
        int end = body + length;
        ByteArrayOutputStream bytes = new ByteArrayOutputStream(length + 8);
        DataOutputStream out = new DataOutputStream(bytes);
        out.writeShort(count);
        for (int i = 0; i < count; i++) {
            int type = b[p++] & 0xff;
            int add = i == 0 ? SHIFT : 0;
            if (type <= 63) {
                int delta = type + add;
                if (delta <= 63) {
                    out.writeByte(delta);
                } else {
                    out.writeByte(251);
                    out.writeShort(delta);
                }
            } else if (type <= 127) {
                int delta = type - 64 + add;
                if (delta <= 63) {
                    out.writeByte(64 + delta);
                } else {
                    out.writeByte(247);
                    out.writeShort(delta);
                }
                p = copyTypes(b, p, 1, out);
            } else if (type == 247) {
                out.writeByte(type);
                out.writeShort(u2(b, p) + add);
                p = copyTypes(b, p + 2, 1, out);
            } else if (type >= 248 && type <= 251) {
                out.writeByte(type);
                out.writeShort(u2(b, p) + add);
                p += 2;
            } else if (type >= 252 && type <= 254) {
                out.writeByte(type);
                out.writeShort(u2(b, p) + add);
                p = copyTypes(b, p + 2, type - 251, out);
            } else if (type == 255) {
                out.writeByte(type);
                out.writeShort(u2(b, p) + add);
                p += 2;
                int locals = u2(b, p);
                out.writeShort(locals);
                p = copyTypes(b, p + 2, locals, out);
                int stack = u2(b, p);
                out.writeShort(stack);
                p = copyTypes(b, p + 2, stack, out);
            } else {
                return null; // reserved frame types
            }
            if (p > end) {
                return null;
            }
        }
        out.flush();
        return bytes.toByteArray();
    }

    private static int copyTypes(byte[] b, int p, int n, DataOutputStream out) throws IOException {
        for (int k = 0; k < n; k++) {
            int tag = b[p++] & 0xff;
            out.writeByte(tag);
            if (tag == 7) { // Object: constant pool index
                out.writeShort(u2(b, p));
                p += 2;
            } else if (tag == 8) { // Uninitialized: offset of the `new` instruction
                out.writeShort(u2(b, p) + SHIFT);
                p += 2;
            }
        }
        return p;
    }
}
