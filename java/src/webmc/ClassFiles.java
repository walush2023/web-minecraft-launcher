package webmc;

import java.nio.charset.StandardCharsets;
import java.util.Arrays;

/** Constants and byte helpers shared by the in-memory class rewriters. */
final class ClassFiles {
    static final int UTF8 = 1;
    static final int CLASS = 7;
    static final int STRING = 8;
    static final int FIELDREF = 9;
    static final int METHODREF = 10;
    static final int INTERFACE_METHODREF = 11;
    static final int NAME_AND_TYPE = 12;
    static final int METHOD_HANDLE = 15;
    static final int INVOKE_DYNAMIC = 18;

    static final int INVOKEVIRTUAL = 0xb6;
    static final int INVOKESPECIAL = 0xb7;
    static final int INVOKESTATIC = 0xb8;
    static final int INVOKEINTERFACE = 0xb9;
    static final int INVOKEDYNAMIC = 0xba;

    private ClassFiles() {
    }

    static int u2(byte[] b, int at) {
        return ((b[at] & 0xff) << 8) | (b[at + 1] & 0xff);
    }

    static int u4(byte[] b, int at) {
        return (u2(b, at) << 16) | u2(b, at + 2);
    }

    static boolean contains(byte[] haystack, String ascii) {
        return contains(haystack, ascii.getBytes(StandardCharsets.UTF_8));
    }

    static boolean contains(byte[] haystack, byte[] needle) {
        outer:
        for (int i = 0; i + needle.length <= haystack.length; i++) {
            for (int j = 0; j < needle.length; j++) {
                if (haystack[i + j] != needle[j]) {
                    continue outer;
                }
            }
            return true;
        }
        return false;
    }

    /** Skips a fields or methods table starting at its count; returns the offset after it. */
    static int skipMembers(byte[] b, int p) {
        int count = u2(b, p);
        p += 2;
        for (int i = 0; i < count; i++) {
            int attributes = u2(b, p + 6);
            p += 8;
            for (int a = 0; a < attributes; a++) {
                p += 6 + u4(b, p + 2);
            }
        }
        return p;
    }

    /** Length in bytes of the instruction at pc; code is the offset of the bytecode in b. */
    static int instructionLength(byte[] b, int code, int pc) {
        int opcode = b[code + pc] & 0xff;
        switch (opcode) {
            case 0xaa: { // tableswitch
                int p = pc + 1 + ((4 - (pc + 1) % 4) % 4);
                int low = u4(b, code + p + 4);
                int high = u4(b, code + p + 8);
                return p - pc + 12 + (high - low + 1) * 4;
            }
            case 0xab: { // lookupswitch
                int p = pc + 1 + ((4 - (pc + 1) % 4) % 4);
                return p - pc + 8 + u4(b, code + p + 4) * 8;
            }
            case 0xc4: // wide
                return (b[code + pc + 1] & 0xff) == 0x84 ? 6 : 4;
            default:
                return LENGTHS[opcode];
        }
    }

    private static final int[] LENGTHS = new int[256];

    static {
        Arrays.fill(LENGTHS, 1);
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
