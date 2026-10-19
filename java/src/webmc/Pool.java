package webmc;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.IOException;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/** A class file's constant pool as raw entries; entries can be replaced and appended. */
final class Pool {
    final byte[] in;
    final int originalCount;
    int count;
    final List<byte[]> entries = new ArrayList<byte[]>();
    /** Offset of the first byte after the constant pool in the class file. */
    final int end;
    private final Map<String, Integer> utf8s = new HashMap<String, Integer>();
    /** Decoded UTF8 entries by index, filled as they are read (the transforms ask for the same ones often). */
    private String[] strings;
    private final Map<String, Integer> added = new HashMap<String, Integer>();

    Pool(byte[] in) throws IOException {
        this.in = in;
        originalCount = ClassFiles.u2(in, 8);
        count = originalCount;
        entries.add(null);
        int p = 10;
        for (int i = 1; i < originalCount; i++) {
            int start = p;
            int tag = in[p] & 0xff;
            switch (tag) {
                case 1:
                    p += 3 + ClassFiles.u2(in, p + 1);
                    break;
                case 7: case 8: case 16: case 19: case 20:
                    p += 3;
                    break;
                case 15:
                    p += 4;
                    break;
                case 3: case 4: case 9: case 10: case 11: case 12: case 17: case 18:
                    p += 5;
                    break;
                case 5: case 6:
                    p += 9;
                    break;
                default:
                    throw new IOException("Unknown constant pool tag " + tag);
            }
            byte[] entry = new byte[p - start];
            System.arraycopy(in, start, entry, 0, entry.length);
            entries.add(entry);
            if (tag == 5 || tag == 6) {
                entries.add(null);
                i++;
            }
        }
        end = p;
        strings = new String[count + 16];
    }

    int tag(int i) {
        byte[] e = entries.get(i);
        return e == null ? 0 : e[0] & 0xff;
    }

    int u2(int i, int offset) {
        return ClassFiles.u2(entries.get(i), offset);
    }

    String utf8(int i) {
        if (i < strings.length && strings[i] != null) {
            return strings[i];
        }
        byte[] e = entries.get(i);
        String value = null;
        int length = ClassFiles.u2(e, 1);
        boolean ascii = true;
        for (int k = 3; k < 3 + length; k++) {
            if (e[k] <= 0) { // modified UTF-8 has no zero bytes; negative ones are not ASCII
                ascii = false;
                break;
            }
        }
        if (ascii) {
            value = new String(e, 3, length, java.nio.charset.StandardCharsets.ISO_8859_1);
        } else {
            try {
                value = new DataInputStream(new ByteArrayInputStream(e, 1, e.length - 1)).readUTF();
            } catch (IOException ex) {
                throw new IllegalStateException(ex);
            }
        }
        remember(i, value);
        return value;
    }

    private void remember(int i, String value) {
        if (i >= strings.length) {
            strings = java.util.Arrays.copyOf(strings, Math.max(i + 1, strings.length * 2));
        }
        strings[i] = value;
    }

    String className(int i) {
        return utf8(u2(i, 1));
    }

    /** Name of a Fieldref/Methodref/InterfaceMethodref. */
    String memberName(int ref) {
        return utf8(u2(u2(ref, 3), 1));
    }

    String memberDescriptor(int ref) {
        return utf8(u2(u2(ref, 3), 3));
    }

    /** Value of a CONSTANT_Double. */
    double doubleValue(int i) {
        byte[] e = entries.get(i);
        long bits = 0;
        for (int k = 1; k <= 8; k++) {
            bits = (bits << 8) | (e[k] & 0xff);
        }
        return Double.longBitsToDouble(bits);
    }

    /** Value of a CONSTANT_Long. */
    long longValue(int i) {
        byte[] e = entries.get(i);
        long bits = 0;
        for (int k = 1; k <= 8; k++) {
            bits = (bits << 8) | (e[k] & 0xff);
        }
        return bits;
    }

    /** Appends a CONSTANT_Double (it takes two pool slots). */
    int addDouble(double value) {
        return addWide(6, Double.doubleToLongBits(value));
    }

    /** Appends a CONSTANT_Long (it takes two pool slots). */
    int addLong(long value) {
        return addWide(5, value);
    }

    private int addWide(int tag, long bits) {
        byte[] e = new byte[9];
        e[0] = (byte) tag;
        for (int k = 8; k >= 1; k--) {
            e[k] = (byte) bits;
            bits >>>= 8;
        }
        entries.add(e);
        entries.add(null);
        count += 2;
        return count - 2;
    }

    int addUtf8(String value) throws IOException {
        Integer known = utf8s.get(value);
        if (known != null) {
            return known;
        }
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        DataOutputStream d = new DataOutputStream(bytes);
        d.writeByte(ClassFiles.UTF8);
        d.writeUTF(value);
        d.flush();
        entries.add(bytes.toByteArray());
        utf8s.put(value, count);
        remember(count, value);
        return count++;
    }

    int add(int tag, int a) {
        String key = tag + ":" + a;
        Integer known = added.get(key);
        if (known != null) {
            return known;
        }
        entries.add(new byte[] {(byte) tag, (byte) (a >> 8), (byte) a});
        added.put(key, count);
        return count++;
    }

    int add(int tag, int a, int b) {
        String key = tag + ":" + a + ":" + b;
        Integer known = added.get(key);
        if (known != null) {
            return known;
        }
        entries.add(new byte[] {(byte) tag, (byte) (a >> 8), (byte) a, (byte) (b >> 8), (byte) b});
        added.put(key, count);
        return count++;
    }

    int addClass(String internalName) throws IOException {
        return add(ClassFiles.CLASS, addUtf8(internalName));
    }

    int addString(String value) throws IOException {
        return add(ClassFiles.STRING, addUtf8(value));
    }

    int addMethodref(String owner, String name, String descriptor) throws IOException {
        int nat = add(ClassFiles.NAME_AND_TYPE, addUtf8(name), addUtf8(descriptor));
        return add(ClassFiles.METHODREF, addClass(owner), nat);
    }

    void setUtf8(int i, String value) throws IOException {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        DataOutputStream d = new DataOutputStream(bytes);
        d.writeByte(ClassFiles.UTF8);
        d.writeUTF(value);
        d.flush();
        entries.set(i, bytes.toByteArray());
        remember(i, value);
    }

    void setString(int i, int utf8) {
        entries.set(i, new byte[] {(byte) ClassFiles.STRING, (byte) (utf8 >> 8), (byte) utf8});
    }

    void setMethodHandle(int i, int kind, int reference) {
        entries.set(i, new byte[] {(byte) ClassFiles.METHOD_HANDLE, (byte) kind, (byte) (reference >> 8), (byte) reference});
    }

    /** Points a field or method reference at another class (same name and descriptor). */
    void setOwner(int i, int classIndex) {
        byte[] e = entries.get(i).clone();
        e[1] = (byte) (classIndex >> 8);
        e[2] = (byte) classIndex;
        entries.set(i, e);
    }

    /** Everything after the constant pool (copied, so code can be patched in place). */
    byte[] rest() {
        byte[] rest = new byte[in.length - end];
        System.arraycopy(in, end, rest, 0, rest.length);
        return rest;
    }

    void write(DataOutputStream out) throws IOException {
        if (count > 0xffff) {
            throw new IOException("constant pool too large");
        }
        out.writeShort(count);
        for (int i = 1; i < entries.size(); i++) {
            byte[] e = entries.get(i);
            if (e != null) {
                out.write(e);
            }
        }
    }
}
