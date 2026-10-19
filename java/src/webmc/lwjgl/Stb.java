package webmc.lwjgl;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.IntBuffer;
import org.lwjgl.stb.STBIIOCallbacks;
import org.lwjgl.stb.STBIReadCallback;
import org.lwjgl.system.MemoryUtil;

/**
 * stbi_info_from_callbacks for Minecraft 1.13 - 1.16, whose PngInfo reads every texture's size
 * through it (webmc.GamePatches redirects the calls here). The JavaScript stb natives would have
 * to call the game's read callback from JavaScript, and CheerpJ loses the native's result when
 * that callback waits for file data; here the callback is an ordinary Java call.
 */
public final class Stb {
    /** PNG signature (8 bytes) and IHDR chunk (25 bytes). */
    private static final int HEADER = 33;
    private static final long PNG_SIGNATURE = 0x89504E470D0A1A0AL;

    private Stb() {
    }

    public static boolean infoFromCallbacks(STBIIOCallbacks callbacks, long user, IntBuffer x, IntBuffer y, IntBuffer comp) {
        ByteBuffer header = ByteBuffer.allocateDirect(HEADER).order(ByteOrder.BIG_ENDIAN);
        long address = MemoryUtil.memAddress(header);
        STBIReadCallback read = callbacks.read();
        int total = 0;
        while (total < HEADER) {
            int n = read.invoke(user, address + total, HEADER - total);
            if (n <= 0) {
                break;
            }
            total += n;
        }
        if (total < HEADER || header.getLong(0) != PNG_SIGNATURE) {
            return false;
        }
        int colorType = header.get(25) & 0xff;
        // Like stb_image: grey 1, grey + alpha 2, RGBA 4, RGB and palette 3.
        int channels = colorType == 0 ? 1 : colorType == 4 ? 2 : colorType == 6 ? 4 : 3;
        x.put(x.position(), header.getInt(16));
        y.put(y.position(), header.getInt(20));
        comp.put(comp.position(), channels);
        return true;
    }
}
