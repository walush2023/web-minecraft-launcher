package webmc.lwjgl;

import org.lwjgl.system.MemoryUtil;
import sun.misc.Unsafe;

/**
 * LWJGL memory allocator for the browser, selected with
 * {@code -Dorg.lwjgl.system.allocator=webmc.lwjgl.HeapAllocator}. It replaces jemalloc (a native
 * library) with sun.misc.Unsafe, whose memory the JavaScript natives can read and write.
 */
public final class HeapAllocator implements MemoryUtil.MemoryAllocator {
    private static final Unsafe U = Bridge.UNSAFE;

    @Override
    public long getMalloc() {
        return 0L;
    }

    @Override
    public long getCalloc() {
        return 0L;
    }

    @Override
    public long getRealloc() {
        return 0L;
    }

    @Override
    public long getFree() {
        return 0L;
    }

    @Override
    public long getAlignedAlloc() {
        return 0L;
    }

    @Override
    public long getAlignedFree() {
        return 0L;
    }

    @Override
    public long malloc(long size) {
        return U.allocateMemory(size == 0L ? 1L : size);
    }

    @Override
    public long calloc(long num, long size) {
        long bytes = num * size;
        long address = U.allocateMemory(bytes == 0L ? 1L : bytes);
        U.setMemory(address, bytes, (byte) 0);
        return address;
    }

    @Override
    public long realloc(long ptr, long size) {
        return ptr == 0L ? malloc(size) : U.reallocateMemory(ptr, size == 0L ? 1L : size);
    }

    @Override
    public void free(long ptr) {
        if (ptr != 0L) {
            U.freeMemory(ptr);
        }
    }

    @Override
    public long aligned_alloc(long alignment, long size) {
        long raw = U.allocateMemory(size + alignment + 8L);
        long aligned = (raw + 8L + alignment - 1L) & -alignment;
        U.putLong(aligned - 8L, raw);
        return aligned;
    }

    @Override
    public void aligned_free(long ptr) {
        if (ptr != 0L) {
            U.freeMemory(U.getLong(ptr - 8L));
        }
    }
}
