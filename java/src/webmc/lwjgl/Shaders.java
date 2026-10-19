package webmc.lwjgl;

import java.lang.reflect.Method;
import java.nio.ByteBuffer;
import org.lwjgl.system.Callback;
import org.lwjgl.system.MemoryUtil;

/**
 * Stands in for {@code Shaderc.shaderc_compile_into_spv} (Minecraft 26.x compiles every shader
 * with it; webmc.ClassDowngrader redirects the call here). The browser's shaderc
 * (public/lwjgl3/spirv.js) needs the game's #include files, which the game provides through a
 * callback. A native cannot call back into Java while it runs without losing its own result in
 * CheerpJ, so the includes are resolved here first: the native names the files the source still
 * needs, this method asks the game's callback for each, and the compile itself then runs without
 * calling back.
 */
public final class Shaders {
    private static volatile Method resolve;

    private Shaders() {
    }

    public static long shaderc_compile_into_spv(long compiler, ByteBuffer source, int kind, ByteBuffer fileName, ByteBuffer entryPoint, long options) {
        long sourceAddress = MemoryUtil.memAddress(source);
        int sourceLength = source.remaining();
        long file = MemoryUtil.memAddress(fileName);
        for (int depth = 1; depth < 4096; depth++) {
            long request = nextInclude(options, sourceAddress, sourceLength);
            if (request == 0L) {
                break;
            }
            includeResolved(options, request, resolveInclude(options, request, file, depth));
        }
        return compile(compiler, sourceAddress, sourceLength, kind, file, MemoryUtil.memAddress(entryPoint), options);
    }

    /** Calls the game's shaderc_include_resolve_fn (a ShadercIncludeResolveI); 0 when there is none. */
    private static long resolveInclude(long options, long request, long requester, int depth) {
        long function = includeResolver(options);
        if (function == 0L) {
            return 0L;
        }
        try {
            Object callback = Callback.get(function);
            Method invoke = resolve;
            if (invoke == null) {
                Class<?> type = Class.forName("org.lwjgl.util.shaderc.ShadercIncludeResolveI", false, Shaders.class.getClassLoader());
                invoke = type.getMethod("invoke", long.class, long.class, int.class, long.class, long.class);
                resolve = invoke;
            }
            return (Long) invoke.invoke(callback, includeUserData(options), request, 1, requester, (long) depth);
        } catch (ReflectiveOperationException e) {
            throw new IllegalStateException("shader include callback failed", e);
        }
    }

    /** A C string naming the next #include file the compile needs, or 0 when all are known. */
    private static native long nextInclude(long options, long source, int length);

    /** Hands over the callback's shaderc_include_result for that request (0: none). */
    private static native void includeResolved(long options, long request, long result);

    private static native long includeResolver(long options);

    private static native long includeUserData(long options);

    private static native long compile(long compiler, long source, int length, int kind, long fileName, long entryPoint, long options);
}
