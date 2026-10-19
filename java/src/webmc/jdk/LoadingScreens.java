package webmc.jdk;

/**
 * Stand-ins for parts of the game's loading screens (see webmc.GamePatches). The parameters are
 * the game's types; Object takes them all.
 */
public final class LoadingScreens {
    private LoadingScreens() {
    }

    /**
     * 26.x LevelLoadingScreen.extractChunksForRendering(graphics, x, y, size, spacing, status):
     * draws nothing. The map draws each chunk as a rectangle, and the GUI places every rectangle by
     * testing it against all those before it; in the browser that took over half the time while a
     * world loaded. The progress text and bar are still drawn.
     */
    public static void noChunkMap(Object graphics, int x, int y, int size, int spacing, Object status) {
    }
}
