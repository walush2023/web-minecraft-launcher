package webmc.lwjgl;

import java.lang.reflect.Field;
import java.nio.Buffer;
import java.nio.ByteBuffer;
import sun.misc.Unsafe;

/**
 * Java side of the browser LWJGL 3 backend (public/lwjgl3/*.js).
 *
 * <p>The JavaScript natives work directly on the memory that sun.misc.Unsafe allocates in.
 * {@link #setup()} allocates the first block for the JavaScript allocator and writes a marker
 * into it, so the JavaScript side can find the right WebAssembly memory. The other methods are
 * called from JavaScript natives that need Java to do something (more memory, buffers).
 */
public final class Bridge {
    static final Unsafe UNSAFE = loadUnsafe();

    private static final int ARENA_SIZE = 16 << 20;
    private static final int MAGIC0 = 0x63626577; // "webc"
    private static final int MAGIC1 = 0x6c676a77; // "wjgl"

    private static final long ADDRESS = fieldOffset(Buffer.class, "address");
    private static final long CAPACITY = fieldOffset(Buffer.class, "capacity");
    private static final long LIMIT = fieldOffset(Buffer.class, "limit");
    private static final long MARK = fieldOffset(Buffer.class, "mark");
    private static final long BIG_ENDIAN = fieldOffset(ByteBuffer.class, "bigEndian");
    private static final Class<?> DIRECT_BYTE_BUFFER = directByteBufferClass();

    private Bridge() {
    }

    /** Implemented in JavaScript: binds the heap and adopts the arena. Returns 0 on failure. */
    private static native int init(long arena, int size, int magic0, int magic1);

    /** Implemented in JavaScript (async): waits until the JavaScript allocator needs memory; returns the size. */
    private static native int waitForBlockRequest();

    /** Implemented in JavaScript: hands a block allocated for the last request to the JavaScript allocator. */
    private static native void blockAllocated(long address, int size);

    public static void setup() {
        long arena = UNSAFE.allocateMemory(ARENA_SIZE);
        UNSAFE.putInt(arena, MAGIC0);
        UNSAFE.putInt(arena + 4, MAGIC1);
        if (init(arena, ARENA_SIZE, MAGIC0, MAGIC1) == 0) {
            throw new IllegalStateException("webmc: could not locate the native heap");
        }
        // CheerpJ rejects calls from JavaScript into Java while another such call is running, which
        // happens when several game threads need memory at once. So more memory is not requested
        // by calling Java: this thread waits for requests and answers them.
        Thread provider = new Thread(new Runnable() {
            @Override
            public void run() {
                while (true) {
                    int size = waitForBlockRequest();
                    blockAllocated(UNSAFE.allocateMemory(size), size);
                }
            }
        }, "webmc-native-heap");
        provider.setDaemon(true);
        provider.start();
    }

    /** Allocates a block for the JavaScript allocator (kept for callers outside the provider thread). */
    public static double allocateBlock(double size) {
        return (double) UNSAFE.allocateMemory((long) size);
    }

    /** JNI NewDirectByteBuffer: a ByteBuffer over existing memory (big endian, like JNI). */
    public static ByteBuffer newDirectByteBuffer(double address, double capacity) throws InstantiationException {
        ByteBuffer buffer = (ByteBuffer) UNSAFE.allocateInstance(DIRECT_BYTE_BUFFER);
        UNSAFE.putLong(buffer, ADDRESS, (long) address);
        UNSAFE.putInt(buffer, CAPACITY, (int) capacity);
        UNSAFE.putInt(buffer, LIMIT, (int) capacity);
        UNSAFE.putInt(buffer, MARK, -1);
        if (BIG_ENDIAN >= 0) {
            UNSAFE.putBoolean(buffer, BIG_ENDIAN, true);
        }
        return buffer;
    }

    /** JNI GetDirectBufferAddress. */
    public static double directBufferAddress(Buffer buffer) {
        return (double) UNSAFE.getLong(buffer, ADDRESS);
    }

    private static Unsafe loadUnsafe() {
        try {
            Field field = Unsafe.class.getDeclaredField("theUnsafe");
            field.setAccessible(true);
            return (Unsafe) field.get(null);
        } catch (ReflectiveOperationException e) {
            throw new ExceptionInInitializerError(e);
        }
    }

    /** LWJGL 3.1 - 3.2 (see public/lwjgl3/legacy.js): the Unsafe offset of a java.nio.Buffer field. */
    public static long bufferField(String name) {
        long offset = fieldOffset(Buffer.class, name);
        if (offset < 0) {
            throw new IllegalStateException("webmc: java.nio.Buffer has no field " + name);
        }
        return offset;
    }

    /** LWJGL 3.2 (see public/lwjgl3/legacy.js): the offset of the field a direct buffer keeps its parent in. */
    public static long parentField(Object buffer) {
        for (Class<?> type = buffer.getClass(); type != null; type = type.getSuperclass()) {
            long offset = fieldOffset(type, "att");
            if (offset >= 0) {
                return offset;
            }
        }
        throw new IllegalStateException("webmc: no parent field in " + buffer.getClass().getName());
    }

    private static long fieldOffset(Class<?> type, String name) {
        try {
            return UNSAFE.objectFieldOffset(type.getDeclaredField(name));
        } catch (NoSuchFieldException e) {
            return -1;
        }
    }

    private static Class<?> directByteBufferClass() {
        try {
            return Class.forName("java.nio.DirectByteBuffer");
        } catch (ClassNotFoundException e) {
            throw new ExceptionInInitializerError(e);
        }
    }
}
