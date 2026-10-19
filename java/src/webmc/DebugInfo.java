package webmc;

import static webmc.ClassFiles.u2;
import static webmc.ClassFiles.u4;

import java.io.ByteArrayOutputStream;
import java.io.DataOutputStream;
import java.io.IOException;

/**
 * Removes debugging information from a class: every method's LocalVariableTable and
 * LocalVariableTypeTable (only debuggers read them) and, unless {@code lines} is set, its
 * LineNumberTable (CheerpJ's stack traces show no line numbers anyway). Constant pool strings
 * that nothing else refers to afterwards become empty strings.
 *
 * <p>The browser JVM keeps every loaded class in its runtime heap, which cannot grow past
 * 256 MiB. Minecraft 26.x is not obfuscated and ships full local variable tables; it loads
 * enough classes to fill that heap while it creates a world.
 */
final class DebugInfo {
    private DebugInfo() {
    }

    static byte[] strip(byte[] in, boolean lines) throws IOException {
        // Obfuscated game classes have no debugging tables: skip parsing them.
        if (!ClassFiles.contains(in, "LocalVariable") && (lines || !ClassFiles.contains(in, "LineNumberTable"))) {
            return in;
        }
        Pool pool = new Pool(in);
        byte[] b = pool.rest();
        References refs = new References(pool, b);
        ByteArrayOutputStream bytes = new ByteArrayOutputStream(b.length);
        DataOutputStream out = new DataOutputStream(bytes);
        int p = 6;
        p += 2 + u2(b, p) * 2; // interfaces
        out.write(b, 0, p);
        boolean changed = false;
        for (int kind = 0; kind < 2; kind++) { // fields, then methods
            int count = u2(b, p);
            out.writeShort(count);
            p += 2;
            for (int m = 0; m < count; m++) {
                refs.utf8(u2(b, p + 2));
                refs.utf8(u2(b, p + 4));
                int attributes = u2(b, p + 6);
                out.write(b, p, 8);
                p += 8;
                for (int a = 0; a < attributes; a++) {
                    int length = u4(b, p + 2);
                    if ("Code".equals(pool.utf8(u2(b, p)))) {
                        byte[] code = code(b, p, pool, lines, refs);
                        changed |= code.length != 6 + length;
                        out.write(code);
                    } else {
                        refs.attribute(p);
                        out.write(b, p, 6 + length);
                    }
                    p += 6 + length;
                }
            }
        }
        int attributes = u2(b, p);
        for (int a = 0, q = p + 2; a < attributes; a++) {
            refs.attribute(q);
            q += 6 + u4(b, q + 2);
        }
        if (!changed) {
            return in;
        }
        out.write(b, p, b.length - p);
        out.flush();
        refs.constants();
        if (!refs.unknown) {
            byte[] empty = {ClassFiles.UTF8, 0, 0};
            for (int i = 1; i < pool.entries.size(); i++) {
                if (pool.tag(i) == ClassFiles.UTF8 && !refs.used[i]) {
                    pool.entries.set(i, empty);
                }
            }
        }
        ByteArrayOutputStream result = new ByteArrayOutputStream(in.length);
        DataOutputStream data = new DataOutputStream(result);
        data.write(in, 0, 8);
        pool.write(data);
        bytes.writeTo(data);
        data.flush();
        return result.toByteArray();
    }

    /** The Code attribute at a (its name index) without the debugging tables. */
    private static byte[] code(byte[] b, int a, Pool pool, boolean lines, References refs) throws IOException {
        refs.utf8(u2(b, a));
        int codeLength = u4(b, a + 10);
        int q = a + 14 + codeLength;
        q += 2 + u2(b, q) * 8; // exception table
        int count = u2(b, q);
        int head = q - (a + 6); // max_stack through the exception table
        q += 2;
        ByteArrayOutputStream kept = new ByteArrayOutputStream();
        int keptCount = 0;
        for (int i = 0; i < count; i++) {
            String name = pool.utf8(u2(b, q));
            int length = u4(b, q + 2);
            boolean drop = "LocalVariableTable".equals(name) || "LocalVariableTypeTable".equals(name)
                || (!lines && "LineNumberTable".equals(name));
            if (!drop) {
                refs.attribute(q);
                kept.write(b, q, 6 + length);
                keptCount++;
            }
            q += 6 + length;
        }
        ByteArrayOutputStream result = new ByteArrayOutputStream(6 + head + 2 + kept.size());
        DataOutputStream d = new DataOutputStream(result);
        d.writeShort(u2(b, a));
        d.writeInt(head + 2 + kept.size());
        d.write(b, a + 6, head);
        d.writeShort(keptCount);
        kept.writeTo(d);
        d.flush();
        return result.toByteArray();
    }

    /** Collects the constant pool strings that a class still refers to. */
    private static final class References {
        final Pool pool;
        final byte[] b;
        final boolean[] used;
        /** An attribute whose references are not known: no string may be emptied. */
        boolean unknown;

        References(Pool pool, byte[] b) {
            this.pool = pool;
            this.b = b;
            this.used = new boolean[pool.entries.size()];
        }

        void utf8(int i) {
            if (i > 0 && i < used.length) {
                used[i] = true;
            }
        }

        /** Strings that other constants refer to (every non-string constant counts as used). */
        void constants() {
            for (int i = 1; i < used.length; i++) {
                switch (pool.tag(i)) {
                    case 7: case 8: case 16: case 19: case 20: // Class, String, MethodType, Module, Package
                        utf8(pool.u2(i, 1));
                        break;
                    case 12: // NameAndType
                        utf8(pool.u2(i, 1));
                        utf8(pool.u2(i, 3));
                        break;
                    default:
                        break;
                }
            }
        }

        /** The attribute at p (its name index). */
        void attribute(int p) {
            utf8(u2(b, p));
            String name = pool.utf8(u2(b, p));
            int body = p + 6;
            switch (name) {
                case "Signature":
                case "SourceFile":
                    utf8(u2(b, body));
                    break;
                case "InnerClasses":
                    for (int k = 0, n = u2(b, body); k < n; k++) {
                        utf8(u2(b, body + 2 + k * 8 + 4));
                    }
                    break;
                case "MethodParameters":
                    for (int k = 0, n = b[body] & 0xff; k < n; k++) {
                        utf8(u2(b, body + 1 + k * 4));
                    }
                    break;
                case "LocalVariableTable":
                case "LocalVariableTypeTable":
                    for (int k = 0, n = u2(b, body); k < n; k++) {
                        utf8(u2(b, body + 2 + k * 10 + 4));
                        utf8(u2(b, body + 2 + k * 10 + 6));
                    }
                    break;
                case "RuntimeVisibleAnnotations":
                case "RuntimeInvisibleAnnotations": {
                    int q = body + 2;
                    for (int k = 0, n = u2(b, body); k < n && !unknown; k++) {
                        q = annotation(q);
                    }
                    break;
                }
                case "RuntimeVisibleParameterAnnotations":
                case "RuntimeInvisibleParameterAnnotations": {
                    int q = body + 1;
                    for (int k = 0, n = b[body] & 0xff; k < n && !unknown; k++) {
                        int annotations = u2(b, q);
                        q += 2;
                        for (int j = 0; j < annotations && !unknown; j++) {
                            q = annotation(q);
                        }
                    }
                    break;
                }
                case "RuntimeVisibleTypeAnnotations":
                case "RuntimeInvisibleTypeAnnotations": {
                    int q = body + 2;
                    for (int k = 0, n = u2(b, body); k < n && !unknown; k++) {
                        q = typeAnnotation(q);
                    }
                    break;
                }
                case "AnnotationDefault":
                    elementValue(body);
                    break;
                case "Record": {
                    int q = body + 2;
                    for (int k = 0, n = u2(b, body); k < n; k++) {
                        utf8(u2(b, q));
                        utf8(u2(b, q + 2));
                        int attributes = u2(b, q + 4);
                        q += 6;
                        for (int j = 0; j < attributes; j++) {
                            attribute(q);
                            q += 6 + u4(b, q + 2);
                        }
                    }
                    break;
                }
                case "Code": // only inside Record components or similar: not expected
                    unknown = true;
                    break;
                case "ConstantValue":
                case "Exceptions":
                case "Deprecated":
                case "Synthetic":
                case "LineNumberTable":
                case "StackMapTable":
                case "EnclosingMethod":
                case "NestHost":
                case "NestMembers":
                case "PermittedSubclasses":
                case "BootstrapMethods":
                case "SourceDebugExtension":
                    break; // no strings, or only other constants
                default:
                    unknown = true;
                    break;
            }
        }

        private int annotation(int q) {
            utf8(u2(b, q));
            int pairs = u2(b, q + 2);
            q += 4;
            for (int k = 0; k < pairs && !unknown; k++) {
                utf8(u2(b, q));
                q = elementValue(q + 2);
            }
            return q;
        }

        private int elementValue(int q) {
            int tag = b[q] & 0xff;
            q++;
            switch (tag) {
                case 'B': case 'C': case 'D': case 'F': case 'I': case 'J': case 'S': case 'Z':
                    return q + 2;
                case 's': case 'c':
                    utf8(u2(b, q));
                    return q + 2;
                case 'e':
                    utf8(u2(b, q));
                    utf8(u2(b, q + 2));
                    return q + 4;
                case '@':
                    return annotation(q);
                case '[': {
                    int n = u2(b, q);
                    q += 2;
                    for (int k = 0; k < n && !unknown; k++) {
                        q = elementValue(q);
                    }
                    return q;
                }
                default:
                    unknown = true;
                    return q;
            }
        }

        private int typeAnnotation(int q) {
            int target = b[q] & 0xff;
            q++;
            switch (target) {
                case 0x00: case 0x01: case 0x16:
                    q += 1;
                    break;
                case 0x10: case 0x11: case 0x12: case 0x17: case 0x42: case 0x43: case 0x44: case 0x45: case 0x46:
                    q += 2;
                    break;
                case 0x13: case 0x14: case 0x15:
                    break;
                case 0x40: case 0x41:
                    q += 2 + u2(b, q) * 6;
                    break;
                case 0x47: case 0x48: case 0x49: case 0x4a: case 0x4b:
                    q += 3;
                    break;
                default:
                    unknown = true;
                    return q;
            }
            q += 1 + (b[q] & 0xff) * 2; // type_path
            return annotation(q);
        }
    }
}
