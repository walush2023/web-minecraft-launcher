package webmc.jdk;

/**
 * 26.x HttpUtil.getAvailablePort and isPortAvailable for the game's classes (see
 * webmc.GamePatches): they open a ServerSocket, and the browser has no sockets (CheerpJ fails to
 * initialize sun.nio.ch.Net, an Error the game does not catch), so the World Options screen, where
 * 26.x also sets the difficulty, failed to open.
 */
public final class Ports {
    private Ports() {
    }

    /** HttpUtil's own answer when no socket can be opened. */
    public static int availablePort() {
        return 25564;
    }

    public static boolean portAvailable(int port) {
        return port > 0 && port <= 65535;
    }
}
